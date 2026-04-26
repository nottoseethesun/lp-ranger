/**
 * @file test/hodl-baseline.test.js
 * @description Unit tests for the hodl-baseline module.
 * Run with: node --test test/hodl-baseline.test.js
 */

"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// ── helpers ──────────────────────────────────────────────────────────────────

const { _resetForTest } = require("../src/gecko-rate-limit");

/** Save and restore the real global fetch around every test. */
let _originalFetch;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _resetForTest();
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  mock.restoreAll();
});

/**
 * Build a minimal mock ethers library for initHodlBaseline tests.
 * @param {object} overrides - Optional overrides for mock behavior.
 * @returns {object} Mock ethersLib with Contract, Interface, ZeroAddress, zeroPadValue.
 */
function mockEthersLib(overrides = {}) {
  const poolAddress = overrides.poolAddress || "0xPool1234";
  return {
    ZeroAddress: "0x" + "0".repeat(40),
    zeroPadValue: (val, _len) => val.padEnd(66, "0"),
    Contract: class {
      async getPool() {
        return poolAddress;
      }
    },
    Interface: class {
      getEvent() {
        return { topicHash: "0xabc123" };
      }
    },
  };
}

/**
 * Build a minimal mock provider.
 * @param {object} overrides - Optional overrides.
 * @returns {object} Mock provider with getLogs, getBlock.
 */
function mockProvider(overrides = {}) {
  return {
    getLogs: async () =>
      "logs" in overrides ? overrides.logs : [{ blockNumber: 100 }],
    getBlock: async () =>
      "block" in overrides ? overrides.block : { timestamp: 1700000000 },
  };
}

/** Minimal position object. */
const POSITION = {
  tokenId: 42,
  token0: "0xToken0",
  token1: "0xToken1",
  fee: 3000,
  liquidity: 1000000n,
  tickLower: -1000,
  tickUpper: 1000,
};

// ── tests ────────────────────────────────────────────────────────────────────

describe("initHodlBaseline", () => {
  it("skips if hodlBaseline already set with mintDate and mintTimestamp", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {
      hodlBaseline: {
        entryValue: 100,
        mintDate: "2023-11-14",
        mintTimestamp: "2023-11-14T22:13:20.000Z",
      },
    };
    const updateBotState = mock.fn();

    await initHodlBaseline(
      mockProvider(),
      mockEthersLib(),
      POSITION,
      botState,
      updateBotState,
    );

    assert.strictEqual(
      updateBotState.mock.callCount(),
      0,
      "should not call updateBotState",
    );
  });

  it("patches mintDate and mintTimestamp when baseline exists without them", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {
      hodlBaseline: { entryValue: 100, mintDate: "2023-11-14" },
    };
    const updateBotState = mock.fn();

    await initHodlBaseline(
      mockProvider(),
      mockEthersLib(),
      POSITION,
      botState,
      updateBotState,
    );

    assert.strictEqual(updateBotState.mock.callCount(), 1);
    assert.strictEqual(botState.hodlBaseline.mintDate, "2023-11-14");
    /*- Canonical mintTimestamp is now Unix seconds (number).  Older
        .bot-config.json files may still hold an ISO string; consumers
        normalize via dashboard-date-utils.js#toMintTsSeconds. */
    assert.strictEqual(botState.hodlBaseline.mintTimestamp, 1700000000);
  });

  it("skips when pool address is zero address", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {};
    const updateBotState = mock.fn();
    const ethers = mockEthersLib({ poolAddress: "0x" + "0".repeat(40) });

    await initHodlBaseline(
      mockProvider(),
      ethers,
      POSITION,
      botState,
      updateBotState,
    );

    assert.strictEqual(updateBotState.mock.callCount(), 0);
  });

  it("skips when no mint logs found", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {};
    const updateBotState = mock.fn();

    await initHodlBaseline(
      mockProvider({ logs: [] }),
      mockEthersLib(),
      POSITION,
      botState,
      updateBotState,
    );

    assert.strictEqual(updateBotState.mock.callCount(), 0);
  });

  it("skips when block is null", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {};
    const updateBotState = mock.fn();

    await initHodlBaseline(
      mockProvider({ block: null }),
      mockEthersLib(),
      POSITION,
      botState,
      updateBotState,
    );

    assert.strictEqual(updateBotState.mock.callCount(), 0);
  });

  it("creates baseline with zero entryValue when GeckoTerminal returns no prices", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {};
    const updateBotState = mock.fn();

    // GeckoTerminal returns empty candles
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    });

    await initHodlBaseline(
      mockProvider(),
      mockEthersLib(),
      POSITION,
      botState,
      updateBotState,
    );

    assert.ok(
      botState.hodlBaseline,
      "should still set hodlBaseline with deposited amounts",
    );
    assert.strictEqual(
      botState.hodlBaseline.entryValue,
      0,
      "entryValue should be 0 without prices",
    );
  });

  it("catches and logs errors without throwing", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {};
    const updateBotState = mock.fn();

    // Provider that throws
    const badProvider = {
      getLogs: async () => {
        throw new Error("RPC down");
      },
    };

    // Should not throw
    await initHodlBaseline(
      badProvider,
      mockEthersLib(),
      POSITION,
      botState,
      updateBotState,
    );

    assert.strictEqual(updateBotState.mock.callCount(), 0);
  });
});

describe("mintGasWei in baseline", () => {
  it("publishes mintGasWei from the mint TX receipt", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const config = require("../src/config");
    const pmAddr = config.POSITION_MANAGER;
    const botState = {};
    const updateBotState = mock.fn();

    // GeckoTerminal returns empty candles (prices unavailable)
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    });

    // Provider with a receipt that has gas data
    const provider = {
      getLogs: async () => [{ blockNumber: 100, transactionHash: "0xMintTx" }],
      getBlock: async () => ({ timestamp: 1700000000 }),
      getTransactionReceipt: async () => ({
        gasUsed: 500_000n,
        gasPrice: 30_000_000_000n,
        logs: [
          {
            address: pmAddr,
            topics: ["0xabc123", "0x002a"],
            data: "0x" + "0".repeat(128),
          },
        ],
      }),
    };

    // ethersLib that can parse IncreaseLiquidity and return pool state
    const ethers = {
      ZeroAddress: "0x" + "0".repeat(40),
      zeroPadValue: (val, _len) => val.padEnd(66, "0"),
      Contract: class {
        constructor() {
          this.getPool = async () => "0xPool1234";
          // Pool contract methods for getPoolState
          this.slot0 = async () => [0n, 0, 0, 0, 0, 0, false];
          this.token0 = async () => "0xToken0";
          this.token1 = async () => "0xToken1";
          this.fee = async () => 3000;
        }
        static async decimals() {
          return 8;
        }
      },
      Interface: class {
        getEvent() {
          return { topicHash: "0xabc123" };
        }
        parseLog() {
          return {
            name: "IncreaseLiquidity",
            args: {
              tokenId: 42n,
              amount0: 1000000n,
              amount1: 2000000n,
            },
          };
        }
      },
    };

    await initHodlBaseline(
      provider,
      ethers,
      POSITION,
      botState,
      updateBotState,
    );

    assert.ok(botState.hodlBaseline, "baseline should be set");
    assert.strictEqual(
      botState.hodlBaseline.mintGasWei,
      String(500_000n * 30_000_000_000n),
      "should store mintGasWei = gasUsed × gasPrice",
    );
  });

  it("defaults mintGasWei to '0' when receipt is unavailable", async () => {
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {};
    const updateBotState = mock.fn();

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    });

    const provider = {
      getLogs: async () => [{ blockNumber: 100, transactionHash: "0xMintTx" }],
      getBlock: async () => ({ timestamp: 1700000000 }),
      getTransactionReceipt: async () => null,
    };

    const ethers = mockEthersLib();

    await initHodlBaseline(
      provider,
      ethers,
      POSITION,
      botState,
      updateBotState,
    );

    assert.ok(botState.hodlBaseline, "baseline should be set");
    assert.strictEqual(
      botState.hodlBaseline.mintGasWei,
      "0",
      "should default to '0' when receipt unavailable",
    );
  });
});

describe("_positionValueUsd", () => {
  it("computes USD value from position amounts and prices", () => {
    const { _positionValueUsd } = require("../src/hodl-baseline");

    // Mock range-math — the require inside _positionValueUsd will pick this up
    // since it uses a dynamic require. We need to test with real range-math.
    const position = {
      liquidity: 1000000n,
      tickLower: -1000,
      tickUpper: 1000,
    };
    const poolState = {
      tick: 0,
      decimals0: 18,
      decimals1: 18,
    };

    // With tick=0 (price ratio 1:1), and symmetric range, amounts should be roughly equal
    const value = _positionValueUsd(position, poolState, 2.0, 3.0);
    assert.ok(typeof value === "number", "should return a number");
    assert.ok(value > 0, "should return positive value");
  });
});
