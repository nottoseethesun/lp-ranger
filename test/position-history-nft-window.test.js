/**
 * @file test/position-history-nft-window.test.js
 * @description Guards that a closed-NFT history scan starts at that
 *   NFT's own mint, and runs to the chain head.
 *
 * `test/position-history-scan-bound.test.js` pins the floor at the
 * pool's creation block, which is not tight enough on its own: epoch
 * reconstruction calls `getPositionHistory` once per closed NFT in the
 * chain, so a pool-wide floor is re-walked once per rebalance. On a
 * 132-rebalance chain that is 132 x 2 x 954 chunks. The NFT's own
 * mint block costs nothing extra — `_supplementFromEvents` resolves it
 * before any scan runs.
 *
 * There is no upper bound, and these tests pin its absence. One could
 * only come from the app's inferred succession, which reads consecutive
 * mints as successive rebalances — untrue when a dust mint from a
 * failed or partial rebalance sits between two real ones. The NFT it
 * appears to replace is then still funded and drains past that bound.
 *
 * These tests drive the real `getPositionHistory` entry point rather
 * than the helper, because what matters is which arguments the entry
 * point passes down — a helper-level test cannot see that.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");
const Module = require("module");

const POOL_CREATED = 1_000_000;
const LATEST = 30_000_000;
const MINT_BLOCK = 26_000_000;
const CLOSE_BLOCK = 26_001_000;
const TOKEN_ID = "12345";

/*- One mutable context that every stub reads through.
 *
 *  `position-history.js` is required once and then cached, capturing
 *  whichever stub objects were in scope at load time. A second run that
 *  built fresh stubs would be talking to itself while the module under
 *  test still used the first run's. Routing the per-run state through
 *  one holder keeps the cached module pointed at the live run. */
let _ctx = { calls: [], prov: null };

/** ethers stub recording every getLogs window. */
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
        return 18;
      }
      /*- PoolCreated lookup used by getPoolCreationBlockCached. */
      filters = { PoolCreated: () => ({}) };
      async queryFilter() {
        return [{ blockNumber: POOL_CREATED }];
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

/** Provider stub: records getLogs windows, returns nothing. */
function _provider() {
  return {
    async getBlockNumber() {
      return LATEST;
    },
    async getLogs(opts) {
      _ctx.calls.push(opts);
      return [];
    },
    async getBlock() {
      return null;
    },
    async getTransactionReceipt() {
      return null;
    },
  };
}

/** Rebalance chain naming this NFT's mint and its replacement. */
function _events({ withClose }) {
  const evts = [
    { newTokenId: TOKEN_ID, blockNumber: MINT_BLOCK, timestamp: 1_700_000_000 },
  ];
  if (withClose)
    evts.push({
      oldTokenId: TOKEN_ID,
      newTokenId: "12346",
      blockNumber: CLOSE_BLOCK,
      timestamp: 1_700_010_000,
    });
  return evts;
}

async function _run({ withClose, extraOpts = {} }) {
  _ctx = { calls: [], prov: _provider(), result: null };
  const origRequire = Module.prototype.require;
  const stub = _ethersStub();
  Module.prototype.require = function (id) {
    if (id === "ethers") return stub;
    if (id === "./send-transaction")
      return { getManagedReadProvider: () => _ctx.prov };
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
    _ctx.result = await getPositionHistory(TOKEN_ID, {
      rebalanceEvents: _events({ withClose }),
      fallbackPrices: { price0: 1, price1: 1 },
      ...extraOpts,
    });
  } finally {
    Module.prototype.require = origRequire;
    const pcb = origRequire.call(module, "../src/pool-creation-block");
    if (typeof pcb._resetForTests === "function") pcb._resetForTests();
  }
  /*- Only the Collect / DecreaseLiquidity scans carry topics; drop any
   *  other read so the assertions speak about the scan alone. */
  return _ctx.calls.filter((c) => Array.isArray(c.topics));
}

describe("closed-NFT history scans are bounded to that NFT's life", () => {
  let calls;

  describe("a retired NFT", () => {
    beforeEach(async () => {
      calls = await _run({ withClose: true });
    });

    it("never reads below the block it was minted in", () => {
      assert.ok(calls.length > 0, "the scan must actually have run");
      for (const c of calls)
        assert.ok(
          c.fromBlock >= MINT_BLOCK,
          `fromBlock ${c.fromBlock} precedes the mint at ${MINT_BLOCK}`,
        );
    });

    it("still reads to the chain head, not to its replacement's mint", () => {
      /*- There is no sound upper bound.  The only candidate comes from
       *  the app's inferred succession, which reads consecutive mints
       *  as successive rebalances — untrue when a dust mint from a
       *  failed or partial rebalance sits between two real ones. The
       *  NFT it appears to replace is then still funded, and drains
       *  past that bound.
       *
       *  The loss is silent either way it lands: an NFT whose drain
       *  falls past the bound returns zero Collects and is skipped,
       *  and one that compounded mid-life returns the compound's
       *  Collect, which is read as its exit value. */
      const last = Math.max(...calls.map((c) => c.toBlock));
      assert.equal(last, LATEST);
    });

    it("still costs far less than scanning the pool's whole history", () => {
      /*- The lower bound is the half that survives: the NFT's own mint
       *  rather than the pool's creation block. */
      const poolWide = Math.ceil((LATEST - POOL_CREATED) / 7500);
      assert.ok(
        calls.length < poolWide,
        `${calls.length} chunks is no better than the pool-wide ${poolWide}`,
      );
      for (const c of calls) assert.ok(c.fromBlock >= MINT_BLOCK);
    });
  });

  describe("the current NFT", () => {
    it("still scans to the chain head, having no replacement", async () => {
      const head = await _run({ withClose: false });
      assert.ok(head.length > 0);
      const last = Math.max(...head.map((c) => c.toBlock));
      assert.equal(last, LATEST, "an unretired NFT must scan to the head");
    });
  });
});

describe("a history already read with the rest of its chain", () => {
  /*- Epoch reconstruction reads every closed NFT's history in one pass
   *  and hands each NFT its slice. Reading it again here would repeat,
   *  one NFT at a time, the walk that pass replaces. */
  const E18 = 10n ** 18n;
  const chainRead = {
    collectEvents: [
      { amount0: 2n * E18, amount1: 0n, blockNumber: MINT_BLOCK + 10 },
      { amount0: 7n * E18, amount1: 3n * E18, blockNumber: CLOSE_BLOCK },
    ],
    dlEvents: [
      {
        liquidity: 1n,
        amount0: 6n * E18,
        amount1: 3n * E18,
        blockNumber: CLOSE_BLOCK,
      },
    ],
  };

  it("is used as given, with no scan of its own", async () => {
    const calls = await _run({
      withClose: true,
      extraOpts: { collectAndDrain: chainRead },
    });
    assert.deepEqual(calls, []);
  });

  it("supplies the exit value and the lifetime fees", async () => {
    await _run({
      withClose: true,
      extraOpts: { collectAndDrain: chainRead },
    });
    /*- Exit: the final Collect, 7 + 3, at the fallback price of 1.
     *  Fees: every Collect less the drained principal, (9 − 6) + (3 − 3). */
    assert.equal(_ctx.result.exitValueUsd, 10);
    assert.equal(_ctx.result.feesEarnedUsd, 3);
  });

  it("is not replaced by a scan when the chain read was unusable", async () => {
    /*- null says the chain read could not be trusted. The NFT's figures
     *  stay unknown, and the epoch is retried as a whole. */
    const calls = await _run({
      withClose: true,
      extraOpts: { collectAndDrain: null },
    });
    assert.deepEqual(calls, []);
    assert.equal(_ctx.result.exitValueUsd, null);
    assert.equal(_ctx.result.feesEarnedUsd, null);
  });
});

/*- `nftScanFromBlock`, the helper this file's floor comes from, is
 *  covered directly in test/nft-mint-blocks.test.js. */
