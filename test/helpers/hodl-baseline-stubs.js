/**
 * @file test/helpers/hodl-baseline-stubs.js
 * @description Shared stub harness for the HODL-baseline test files. One
 * harness rather than a copy per file, because these stubs have to track
 * what `getPoolState` actually validates and a second copy would drift
 * the moment that validation gained a field.
 *
 * The baseline reads three things, and a test that means to exercise one
 * of them has to let the other two succeed:
 *
 *   1. the mint's receipt            → `mockProvider().getTransactionReceipt`
 *   2. the deposit inside it         → `mockEthersLib().Interface#parseLog`
 *   3. both tokens' decimals         → `getPoolState`, via `Contract`
 *
 * The third is the one with teeth. `getPoolState` resolves the pool from
 * the factory, reads `slot0`, both tokens' `decimals` and the fee tier's
 * tick spacing, then validates every field — so a stub that satisfies
 * only the call signatures still fails, and fails as an exhausted retry
 * budget rather than as anything that names the missing field.
 *
 * Three details are therefore load-bearing. `slot0` is returned as an
 * object with NAMED properties, because the code reads `slot0.tick` and
 * `slot0.sqrtPriceX96` rather than array positions, and ethers' own
 * Result type supports both. `decimals` is an instance method, because
 * it is called on a constructed ERC-20 contract. And the pool address is
 * a real 40-hex string, because it is validated for shape and against
 * the zero sentinel before anything else happens.
 */

"use strict";

const config = require("../../src/config");

/** A pool address of the right shape, and not the zero sentinel. */
const POOL_ADDR = "0x" + "11".repeat(20);

/** sqrtPriceX96 for a 1:1 price. A zero here fails validation. */
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

/** The raw deposit the stub interface decodes out of the mint log. */
const DEPOSIT = { amount0: 1_000_000n, amount1: 2_000_000n };

/** Decimals both stub tokens report, so a caller can do the division. */
const DECIMALS = 8;

/** Minimal position object, matching the stub interface's token id. */
const POSITION = Object.freeze({
  tokenId: 42,
  token0: "0xToken0",
  token1: "0xToken1",
  fee: 3000,
  liquidity: 1000000n,
  tickLower: -1000,
  tickUpper: 1000,
});

/**
 * One contract stub covering every method `getPoolState` reaches.
 *
 * The method names are distinct across the three contracts it builds —
 * the factory, the pool and the two tokens — so one class serves all of
 * them without dispatching on address.
 *
 * @param {object} o
 * @param {string} o.poolAddress      What the factory returns.
 * @param {number} [o.decimals]       What both tokens report.
 * @param {Function} [o.onDecimals]   Called instead, to fail that read.
 * @returns {Function} A Contract class.
 */
function contractStub({ poolAddress, decimals = DECIMALS, onDecimals }) {
  return class {
    async getPool() {
      return poolAddress;
    }
    async feeAmountTickSpacing() {
      return 60n;
    }
    /*- Named properties, not an array: `_getPoolStateOnce` reads
     *  `slot0.tick` and `slot0.sqrtPriceX96`. An array satisfies the
     *  call and then yields NaN for the tick. */
    async slot0() {
      return { sqrtPriceX96: SQRT_PRICE_1_1, tick: 0 };
    }
    async decimals() {
      if (onDecimals) return onDecimals();
      return decimals;
    }
  };
}

/**
 * A provider stub for the endpoint gateway to hold.
 *
 * Nothing here touches a socket — the contract stub ignores the provider
 * it is handed. It exists so `sendTx.init` has something to register and
 * `getCurrentRPC` has something to return.
 *
 * @returns {Function} A JsonRpcProvider class.
 */
function providerStub() {
  return class {
    constructor(url) {
      this._url = url;
      this.pollingInterval = 1;
    }
    send() {
      return Promise.resolve(null);
    }
  };
}

/**
 * Build the ethers stand-in the baseline needs.
 *
 * @param {object} [overrides]
 * @param {string} [overrides.poolAddress]  Override the factory's answer.
 * @param {Function} [overrides.onDecimals] Fail the decimals read.
 * @returns {object} Mock ethersLib.
 */
function mockEthersLib(overrides = {}) {
  const poolAddress = overrides.poolAddress || POOL_ADDR;
  return {
    ZeroAddress: "0x" + "0".repeat(40),
    zeroPadValue: (val, _len) => val.padEnd(66, "0"),
    Contract: contractStub({ poolAddress, ...overrides }),
    JsonRpcProvider: providerStub(),
    Interface: class {
      getEvent() {
        return { topicHash: "0xabc123" };
      }
      parseLog() {
        return {
          name: "IncreaseLiquidity",
          args: { tokenId: 42n, ...DEPOSIT },
        };
      }
    },
  };
}

/**
 * Build the provider stand-in the baseline reads through.
 *
 * @param {object} [overrides]
 * @param {Array} [overrides.logs]    What the mint scan finds.
 * @param {object} [overrides.block]  The mint log's block.
 * @param {number} [overrides.head]   Chain head, for the chunker.
 * @param {object} [overrides.receipt] The mint receipt, or null.
 * @returns {object} Mock provider.
 */
function mockProvider(overrides = {}) {
  return {
    getLogs: async () =>
      "logs" in overrides
        ? overrides.logs
        : [{ blockNumber: 100, transactionHash: "0xMintTx" }],
    getBlock: async () =>
      "block" in overrides ? overrides.block : { timestamp: 1700000000 },
    /*- The mint lookup is chunked, and the chunker resolves a "latest"
     *  toBlock to a concrete number before it can window the range. */
    getBlockNumber: async () => ("head" in overrides ? overrides.head : 100),
    /*- A mint receipt carrying one Position Manager log. A case that
     *  omits this is testing an unreadable mint whether it means to or
     *  not. */
    getTransactionReceipt: async () =>
      "receipt" in overrides
        ? overrides.receipt
        : {
            gasUsed: 500_000n,
            gasPrice: 30_000_000_000n,
            logs: [
              {
                address: config.POSITION_MANAGER,
                topics: ["0xabc123", "0x002a"],
                data: "0x" + "0".repeat(128),
              },
            ],
          },
  };
}

/** A GeckoTerminal response carrying no candles, so prices resolve to 0. */
function noPricesResponse() {
  return {
    ok: true,
    json: async () => ({ data: { attributes: { ohlcv_list: [] } } }),
  };
}

module.exports = {
  POOL_ADDR,
  SQRT_PRICE_1_1,
  DEPOSIT,
  DECIMALS,
  POSITION,
  contractStub,
  providerStub,
  mockEthersLib,
  mockProvider,
  noPricesResponse,
};
