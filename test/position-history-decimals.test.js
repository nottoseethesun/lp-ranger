"use strict";

/**
 * @file test/position-history-decimals.test.js
 * @description A closed NFT's history prices its amounts by its tokens'
 *   decimals, and an unreadable decimals is neither guessed nor kept.
 *
 *   A failed read, or an answer outside `tokenDecimals` in
 *   setting-bounds.json, leaves the figures that need decimals as the log
 *   has them, and is asked again the next time. Only a usable answer is
 *   cached, under the canonical chain-first key. A guess kept in its
 *   place would price every amount of a token with other decimals wrongly
 *   for the life of the process, until a restart.
 *
 *   Drives the real `getPositionHistory` with ethers, the endpoint
 *   gateway and the price fetcher stubbed, as
 *   `position-history-nft-window.test.js` does. The Collect and
 *   DecreaseLiquidity scan is what the exit value and fees are read
 *   from, so whether it ran says whether those figures were priced.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const LATEST = 30_000_000;
const TOKEN_ID = "12345";

/*-
 *  One holder every stub reads through, so the module cached on the
 *  first run keeps talking to the live run's state.
 */
const _ctx = { decimals: null, decimalsAsked: 0, scans: 0 };

function _ethersStub() {
  return {
    JsonRpcProvider: class {},
    Contract: class {
      async getPool() {
        return "0x" + "a".repeat(40);
      }
      async positions() {
        return {
          token0: "0x" + "1".repeat(40),
          token1: "0x" + "2".repeat(40),
          fee: 3000,
        };
      }
      async decimals() {
        _ctx.decimalsAsked++;
        return _ctx.decimals();
      }
      filters = { PoolCreated: () => ({}) };
      async queryFilter() {
        return [{ blockNumber: 1 }];
      }
    },
    Interface: class {
      getEvent(name) {
        return { topicHash: "0x" + name.padEnd(64, "0").slice(0, 64) };
      }
      parseLog() {
        return { args: { amount0: 0n, amount1: 0n, liquidity: 0n } };
      }
    },
    ZeroAddress: "0x0000000000000000000000000000000000000000",
  };
}

/*-
 *  The zero-address `from` topic of the mint lookup, a different read
 *  that needs no decimals and is not counted.
 */
const _ZERO_TOPIC = "0x" + "0".repeat(64);

const _provider = {
  async getBlockNumber() {
    return LATEST;
  },
  async getLogs(opts) {
    if (Array.isArray(opts.topics) && opts.topics[1] !== _ZERO_TOPIC)
      _ctx.scans++;
    return [];
  },
  async getBlock() {
    return null;
  },
  async getTransactionReceipt() {
    return null;
  },
};

/** One closed-NFT history, with decimals answered by `decimals`. */
async function history(decimals) {
  _ctx.decimals = decimals;
  _ctx.scans = 0;
  /*-
   *  TEST-ONLY global swap: the history module takes ethers, the endpoint
   *  gateway and the price fetcher at load and offers no seam for them,
   *  so `require` itself hands it the stubs, as the closed-NFT window
   *  tests do. Restored pristine in the `finally` below, immediately
   *  after the call that needed it.
   */
  const origRequire = Module.prototype.require;
  const stub = _ethersStub();
  Module.prototype.require = function (id) {
    if (id === "ethers") return stub;
    if (id === "./send-transaction")
      return { getManagedReadProvider: () => _provider };
    if (id === "./price-fetcher")
      return {
        fetchHistoricalPriceGecko: async () => ({ price0: 0, price1: 0 }),
      };
    return origRequire.apply(this, arguments);
  };
  try {
    const { getPositionHistory } = origRequire.call(
      module,
      "../src/position-history",
    );
    /*-
     *  Dated today, so the history is priced from the fallback prices: an
     *  earlier day's unread price stays unread (src/position-history.js),
     *  and decimals are read only for a priced history.
     */
    const today = Math.floor(Date.now() / 1000);
    return await getPositionHistory(TOKEN_ID, {
      rebalanceEvents: [
        { newTokenId: TOKEN_ID, blockNumber: 26_000_000, timestamp: today },
        {
          oldTokenId: TOKEN_ID,
          newTokenId: "12346",
          blockNumber: 26_001_000,
          timestamp: today,
        },
      ],
      fallbackPrices: { price0: 1, price1: 1 },
    });
  } finally {
    Module.prototype.require = origRequire;
    const pcb = origRequire.call(module, "../src/pool-creation-block");
    if (typeof pcb._resetForTests === "function") pcb._resetForTests();
  }
}

const fails = () => {
  throw new Error("could not reach the endpoint");
};

describe("closed-NFT history and its tokens' decimals", () => {
  it("leaves the priced figures alone when decimals cannot be read", async () => {
    await history(fails);
    assert.equal(_ctx.scans, 0, "no exit value or fees were priced");
  });

  it("asks again the next time rather than keeping a guess", async () => {
    const before = _ctx.decimalsAsked;
    await history(fails);
    assert.equal(_ctx.decimalsAsked - before, 2, "both tokens asked again");
  });

  it("refuses decimals no token can have, and keeps nothing", async () => {
    const before = _ctx.decimalsAsked;
    await history(() => 200);
    assert.equal(_ctx.scans, 0);
    await history(() => 200);
    assert.equal(_ctx.decimalsAsked - before, 4, "asked on both runs");
  });

  it("prices the figures, and keeps the answer, once decimals are read", async () => {
    await history(() => 18);
    assert.ok(_ctx.scans > 0, "the exit value and fees were read");
    const before = _ctx.decimalsAsked;
    await history(() => 18);
    assert.equal(_ctx.decimalsAsked, before, "the kept answer was used");
  });
});
