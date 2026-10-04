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
const { _setRetryDelayForTests } = require("../src/rebalancer-pools");
const sendTx = require("../src/send-transaction");
const rpcQueue = require("../src/rpc-request-manager");
const outOfService = require("../src/rpc-out-of-service");
/*- Shared with test/hodl-baseline-unreadable-mint.test.js. These stubs
 *  have to track what `getPoolState` validates, and a second copy would
 *  drift the moment that validation gained a field. */
const {
  DEPOSIT,
  DECIMALS,
  POSITION,
  mockEthersLib,
  mockProvider,
  noPricesResponse,
} = require("./helpers/hodl-baseline-stubs");

/** Save and restore the real global fetch around every test. */
let _originalFetch;

beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _resetForTest();
  sendTx._resetForTests();
  rpcQueue._resetForTests();
  outOfService._resetForTests();
  /*- The decimals read is a bounded retry; left at its shipped three
   *  seconds, a case that lets it fail sits through the whole budget.
   *
   *  Not restored afterwards, deliberately — see the same note in
   *  test/hodl-baseline-unreadable-mint.test.js. There is no getter to
   *  restore from, no case here wants the real delay, and each test file
   *  gets its own process. */
  _setRetryDelayForTests(0);
});

afterEach(() => {
  globalThis.fetch = _originalFetch;
  mock.restoreAll();
  sendTx._resetForTests();
  rpcQueue._resetForTests();
  outOfService._resetForTests();
});

/**
 * Register a stub library with the endpoint gateway.
 *
 * The token-decimals read inside the baseline goes through
 * `getPoolState`, which asks the gateway which endpoint is current. With
 * none registered it raises "not initialized", and the baseline then
 * correctly declines to publish — indistinguishable from the failures
 * some of these cases are about.
 *
 * @param {object} ethersLib  The stub library to register.
 * @returns {void}
 */
function useGateway(ethersLib) {
  sendTx.init({ urls: ["http://hodl-baseline.test"] }, ethersLib);
}
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
        bot-config.json files may still hold an ISO string; consumers
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

    const ethers = mockEthersLib();
    useGateway(ethers);
    await initHodlBaseline(
      mockProvider(),
      ethers,
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
    /*- The amounts are the point of the case, and asserting them is what
     *  was missing: a baseline carrying zeros satisfied every other
     *  assertion here, so a failed decimals read looked like a pass. */
    assert.strictEqual(
      botState.hodlBaseline.hodlAmount0,
      Number(DEPOSIT.amount0) / 1e8,
      "deposited amount0 must survive a missing price",
    );
    assert.strictEqual(
      botState.hodlBaseline.hodlAmount1,
      Number(DEPOSIT.amount1) / 1e8,
      "deposited amount1 must survive a missing price",
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
      getBlockNumber: async () => 100,
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
  it("publishes the mint's gas and the deposited amounts", async () => {
    /*- One receipt read serves both: the gas comes off the receipt
     *  itself, the amounts out of the deposit event inside it. Asserting
     *  both is what was missing — a baseline carrying zero amounts
     *  satisfied a gas-only assertion, so a failed decimals read read as
     *  a pass. */
    const { initHodlBaseline } = require("../src/hodl-baseline");
    const botState = {};
    const updateBotState = mock.fn();
    globalThis.fetch = async () => noPricesResponse();
    const ethers = mockEthersLib();
    useGateway(ethers);

    await initHodlBaseline(
      mockProvider(),
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
    assert.strictEqual(
      botState.hodlBaseline.hodlAmount0,
      Number(DEPOSIT.amount0) / 10 ** DECIMALS,
      "deposited amount0 must be divided by the token's decimals",
    );
    assert.strictEqual(
      botState.hodlBaseline.hodlAmount1,
      Number(DEPOSIT.amount1) / 10 ** DECIMALS,
      "deposited amount1 must be divided by the token's decimals",
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

// ── mint lookup stops at the hit ─────────────────────────────────────────────

describe("_findMintEvent early exit", () => {
  /*- A token is minted once, so the first chunk that returns anything
   *  holds the whole answer. Without `onChunk` the scan walked on to the
   *  chain head carrying an event it already had: on a pool two years
   *  older than the position, 944 chunks for one event.
   *
   *  Driven through `getPositionBaseline` rather than the helper, which
   *  is not exported — and the entry point is what decides which
   *  arguments reach the chunker anyway. */

  /** Provider that records every getLogs window and hits on the first. */
  function _countingProvider(head) {
    const windows = [];
    return {
      windows,
      getBlockNumber: async () => head,
      getBlock: async () => ({ timestamp: 1700000000 }),
      getTransactionReceipt: async () => null,
      getLogs: async (opts) => {
        windows.push(opts);
        return windows.length === 1
          ? [{ blockNumber: 1, transactionHash: "0xMintTx" }]
          : [];
      },
    };
  }

  it("issues one getLogs when the first chunk carries the mint", async () => {
    const { getPositionBaseline } = require("../src/hodl-baseline");
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    });
    /*- A head far enough out that the span is many chunks wide, so a
     *  walk that does not stop is unmistakable in the count. */
    const prov = _countingProvider(5_000_000);
    await getPositionBaseline(prov, mockEthersLib(), POSITION);
    assert.equal(
      prov.windows.length,
      1,
      `scanned ${prov.windows.length} windows after already holding the mint`,
    );
  });

  it("still walks the whole span when nothing is found", async () => {
    /*- The early exit must not truncate a scan that has no answer yet:
     *  a short walk read as "never minted" is the failure this guards. */
    const { getPositionBaseline } = require("../src/hodl-baseline");
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    });
    const windows = [];
    const prov = {
      getBlockNumber: async () => 100_000,
      getBlock: async () => ({ timestamp: 1700000000 }),
      getTransactionReceipt: async () => null,
      getLogs: async (opts) => {
        windows.push(opts);
        return [];
      },
    };
    const out = await getPositionBaseline(prov, mockEthersLib(), POSITION);
    assert.equal(out, null, "no mint event means no baseline");
    assert.ok(
      windows.length > 1,
      `stopped after ${windows.length} window(s) with nothing found`,
    );
  });

  /*- Direction. The early exit above is only worth having if the walk
   *  starts at the end the answer is likely to be. This lookup asks
   *  where the position's CURRENT NFT was minted, and a managed
   *  position mints a new one on every rebalance, so that block sits
   *  near the chain head while `fromBlock` sits at the pool's creation.
   *
   *  Production 2026-09-30 walked it the other way: 969 windows and
   *  four minutes for an NFT minted five weeks earlier.
   *
   *  TEST-ONLY global swap: both cases below replace `globalThis.fetch`,
   *  because the baseline's historical-price lookup calls `fetch`
   *  directly and offers no seam to inject it through. The original is
   *  captured and restored by this file's own `beforeEach`/`afterEach`
   *  pair at the top, so each case starts and ends with it pristine. */

  it("requests windows newest-first", async () => {
    const { getPositionBaseline } = require("../src/hodl-baseline");
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    });
    const windows = [];
    const prov = {
      getBlockNumber: async () => 100_000,
      getBlock: async () => ({ timestamp: 1700000000 }),
      getTransactionReceipt: async () => null,
      getLogs: async (opts) => {
        windows.push(opts);
        return [];
      },
    };
    await getPositionBaseline(prov, mockEthersLib(), POSITION);
    assert.ok(windows.length > 1, "needs several windows to show an order");
    const descending = windows.every(
      (w, i) => i === 0 || w.fromBlock < windows[i - 1].fromBlock,
    );
    assert.ok(
      descending,
      "windows must descend from the head: " +
        windows.map((w) => w.fromBlock).join(", "),
    );
  });

  it("costs one window when the mint is near the head", async () => {
    const { getPositionBaseline } = require("../src/hodl-baseline");
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
    });
    const HEAD = 5_000_000;
    const windows = [];
    const prov = {
      getBlockNumber: async () => HEAD,
      getBlock: async () => ({ timestamp: 1700000000 }),
      getTransactionReceipt: async () => null,
      /*- The mint sits in the newest window, which is where a managed
       *  position's current NFT actually is. Walked oldest-first this
       *  is the LAST window reached, so the count is the whole span. */
      getLogs: async (opts) => {
        windows.push(opts);
        return opts.toBlock === HEAD
          ? [{ blockNumber: HEAD - 5, transactionHash: "0xMintTx" }]
          : [];
      },
    };
    await getPositionBaseline(prov, mockEthersLib(), POSITION);
    assert.equal(
      windows.length,
      1,
      `scanned ${windows.length} windows to reach a mint at the head`,
    );
  });
});
