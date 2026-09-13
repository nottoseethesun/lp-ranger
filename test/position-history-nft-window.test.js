/**
 * @file test/position-history-nft-window.test.js
 * @description Guards that closed-NFT history scans are bounded to the
 *   NFT's own life, not the pool's.
 *
 * `test/position-history-scan-bound.test.js` already pins the *lower*
 * bound at the pool's creation block. That was never tight enough:
 * epoch reconstruction calls `getPositionHistory` once per closed NFT in
 * a rebalance chain, so a pool-wide window is re-walked once per
 * rebalance. On a 132-rebalance chain that was 132 x 2 x 1,144 chunks —
 * roughly 300,000 paced requests, over a day of wall-clock, for NFTs
 * that each lived a few minutes.
 *
 * Both bounds are free: `_supplementFromEvents` resolves the NFT's mint
 * block and the block it was replaced at before any scan runs.
 *
 * These tests drive the real `getPositionHistory` entry point rather
 * than the helper, because the defect was in which arguments the entry
 * point passed down — a helper-level test would have stayed green
 * through the whole bug.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");
const Module = require("module");
const { nftScanWindow } = require("../src/nft-mint-blocks");

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

async function _run({ withClose }) {
  _ctx = { calls: [], prov: _provider() };
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
    await getPositionHistory(TOKEN_ID, {
      rebalanceEvents: _events({ withClose }),
      fallbackPrices: { price0: 1, price1: 1 },
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

    it("never reads past the block it was replaced at", () => {
      for (const c of calls)
        assert.ok(
          c.toBlock <= CLOSE_BLOCK,
          `toBlock ${c.toBlock} runs past the replacement at ${CLOSE_BLOCK}`,
        );
    });

    it("costs a couple of chunks, not the pool's whole history", () => {
      /*- The regression this file exists for: unbounded, the same run
       *  was ~1,144 chunks per event type. Two event types are scanned,
       *  so allow a handful and no more. */
      assert.ok(
        calls.length <= 8,
        `${calls.length} chunks for a 1,000-block window — the bound is gone`,
      );
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

describe("nftScanWindow", () => {
  it("takes the later of the shared floor and the NFT's mint", () => {
    assert.equal(
      nftScanWindow({ mintBlock: 500, sharedFloor: 900 }).from,
      900,
      "a resume checkpoint past the mint must win",
    );
    assert.equal(
      nftScanWindow({ mintBlock: 900, sharedFloor: 500 }).from,
      900,
      "a mint past the pool floor must tighten it",
    );
  });

  it("scans to the head when the NFT was never retired", () => {
    assert.equal(nftScanWindow({ mintBlock: 1 }).to, "latest");
  });

  it("stops at the retirement block when there is one", () => {
    assert.equal(nftScanWindow({ retirementBlock: 42 }).to, 42);
  });

  it("widens rather than breaking on a non-finite floor", () => {
    /*- Math.max would yield NaN, and a non-finite bound makes the
     *  chunker answer an empty window list — which reads as "no events"
     *  rather than as a failure. */
    assert.equal(nftScanWindow({ sharedFloor: undefined }).from, 0);
    assert.equal(nftScanWindow({ mintBlock: NaN, sharedFloor: 7 }).from, 7);
  });

  it("defaults to the widest window when told nothing", () => {
    assert.deepEqual(nftScanWindow(), { from: 0, to: "latest" });
  });
});
