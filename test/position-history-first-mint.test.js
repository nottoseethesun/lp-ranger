"use strict";

/**
 * @file test/position-history-first-mint.test.js
 * @description The oldest NFT in a rebalance chain takes its mint from
 *   the events array rather than from chain.
 *
 * Every other NFT's mint is free: a rebalance records "old X replaced by
 * new Y" at a block, so Y's mint block is that event's. The oldest one
 * appears only as an `oldTokenId`, so nothing names its mint. Reading it
 * from chain means scanning the pool's whole history for one Transfer —
 * 943 chunks on a real position, all of it for a number the event
 * scanner already resolved and hung on the array as
 * `firstMintBlockNumber`.
 *
 * The gate is `firstMintTokenId`, and it is not ceremony. The first mint
 * describes the oldest ARRIVAL, while the chain is built by
 * `pairTransfers` from direct mints only, so on a pool whose earliest
 * arrival came in by transfer the two are different tokens. Dating this
 * NFT from that block would be wrong and would look right.
 *
 * Drives `_supplementFromEvents` through the real `getPositionHistory`
 * entry point; the chain-reading helpers are stubbed so an unwanted
 * fallback shows up as a call, not as a slow test.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const OLDEST = "156966";
const NEWER = "156978";
const FOREIGN = "70001";

const MINT_TS = 1_773_567_025;
const MINT_BLOCK = 26_028_850;
const CLOSE_BLOCK = 26_031_697;

/** A 2-NFT chain: OLDEST replaced by NEWER. */
function mkEvents(extra = {}) {
  const evts = [
    {
      oldTokenId: OLDEST,
      newTokenId: NEWER,
      blockNumber: CLOSE_BLOCK,
      timestamp: MINT_TS + 10_000,
    },
  ];
  evts.firstMintTimestamp = MINT_TS;
  evts.firstMintBlockNumber = MINT_BLOCK;
  Object.assign(evts, extra);
  return evts;
}

/**
 * Load position-history with its chain-reading helpers stubbed, counting
 * every fallback to chain.
 */
function load() {
  const counts = { mintFromChain: 0 };
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "./position-history-mint") {
      return {
        supplementMintFromChain: async () => {
          counts.mintFromChain += 1;
        },
      };
    }
    if (id === "./price-fetcher")
      return {
        fetchHistoricalPriceGecko: async () => ({ price0: 0, price1: 0 }),
      };
    if (id === "./send-transaction")
      return { getManagedReadProvider: () => ({}) };
    return orig.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve("../src/position-history")];
    const mod = orig.call(module, "../src/position-history");
    return { mod, counts };
  } finally {
    Module.prototype.require = orig;
  }
}

describe("oldest NFT takes its mint from the events array", () => {
  let mod, counts;

  beforeEach(() => {
    ({ mod, counts } = load());
  });

  afterEach(() => {
    delete require.cache[require.resolve("../src/position-history")];
  });

  it("dates the oldest NFT without reading chain", async () => {
    const r = await mod.getPositionHistory(OLDEST, {
      rebalanceEvents: mkEvents({ firstMintTokenId: OLDEST }),
    });
    assert.equal(r.mintBlockNumber, MINT_BLOCK);
    assert.equal(r.mintDate, new Date(MINT_TS * 1000).toISOString());
    assert.equal(
      counts.mintFromChain,
      0,
      "the block was already on the events array",
    );
  });

  it("reads chain when the first mint belongs to a different NFT", async () => {
    /*- The case the id gate exists for.  A pool whose earliest arrival
     *  came in by transfer has a first-mint naming that token, not the
     *  chain's oldest — using its block here would date this NFT from
     *  another one's mint. */
    const r = await mod.getPositionHistory(OLDEST, {
      rebalanceEvents: mkEvents({ firstMintTokenId: FOREIGN }),
    });
    assert.notEqual(
      r.mintBlockNumber,
      MINT_BLOCK,
      "must not date this NFT from another token's mint",
    );
    assert.equal(r.mintDate, null);
    assert.equal(counts.mintFromChain, 1);
  });

  it("reads chain when the id is absent, as on a pre-existing cache", async () => {
    const r = await mod.getPositionHistory(OLDEST, {
      rebalanceEvents: mkEvents(),
    });
    assert.notEqual(r.mintBlockNumber, MINT_BLOCK);
    assert.equal(r.mintDate, null);
    assert.equal(counts.mintFromChain, 1);
  });

  it("still prefers an NFT's own rebalance event over the first mint", async () => {
    /*- NEWER is named by the event, so it must take the event's block —
     *  the first-mint fields describe a different NFT entirely. */
    const r = await mod.getPositionHistory(NEWER, {
      rebalanceEvents: mkEvents({ firstMintTokenId: NEWER }),
    });
    assert.equal(r.mintBlockNumber, CLOSE_BLOCK);
    assert.equal(counts.mintFromChain, 0);
  });
});
