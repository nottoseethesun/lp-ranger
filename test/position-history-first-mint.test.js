"use strict";

/**
 * @file test/position-history-first-mint.test.js
 * @description The oldest NFT in a rebalance chain takes its mint from
 *   the events array rather than from chain.
 *
 * Every other NFT's mint is free: a rebalance records "old X replaced by
 * new Y" at a block, so Y's mint block AND its mint transaction are that
 * event's. The oldest one appears only as an `oldTokenId`, so nothing
 * names its mint.
 *
 * The events array still supplies its DATE and BLOCK, as
 * `chainFirstMint*` / `firstMint*`, and those are taken from there — no
 * search. What the array cannot supply is the mint TRANSACTION, and
 * `position-history.js` needs it: `needsEntryFromChain` and the
 * creation-gas read are both gated on `mintTxHash`. Without it the
 * oldest NFT opens at $0 and its mint costs nothing.
 *
 * So that one NFT does reach `supplementMintFromChain` — for the hash,
 * not the date. It is not the 943-chunk walk that argument was once
 * against: the caller hands over the block the events already gave, and
 * `_mintScanWindow` searches that single block.
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
      /*- A rebalance event always carries the transaction that made it;
       *  the scanner reads it straight off the log. NEWER's mint IS this
       *  transaction, which is why an NFT named as a `newTokenId` never
       *  needs a chain lookup — and why OLDEST, named by no event, does. */
      txHash: "0xREBALANCE",
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

  it("dates the chain-first NFT from chainFirst*, and still fetches its transaction", async () => {
    const r = await mod.getPositionHistory(OLDEST, {
      rebalanceEvents: mkEvents({
        chainFirstTokenId: OLDEST,
        chainFirstMintBlock: MINT_BLOCK,
        chainFirstMintTimestamp: MINT_TS,
      }),
    });
    /*- Date and block come off the array — no search for either. */
    assert.equal(r.mintBlockNumber, MINT_BLOCK);
    assert.equal(r.mintDate, new Date(MINT_TS * 1000).toISOString());
    assert.equal(
      counts.mintFromChain,
      1,
      "the transaction is not on the array, and the entry value and creation gas are both gated on it",
    );
  });

  it("uses chainFirst* even when the oldest-held NFT was transferred in", async () => {
    /*- The case the whole field exists for.  `firstMint*` names the
     *  transferred-in NFT, so it cannot date this one; `chainFirst*`
     *  names this one directly, so the DATE needs no search. */
    const r = await mod.getPositionHistory(OLDEST, {
      rebalanceEvents: mkEvents({
        firstMintTokenId: FOREIGN,
        chainFirstTokenId: OLDEST,
        chainFirstMintBlock: MINT_BLOCK,
        chainFirstMintTimestamp: MINT_TS,
      }),
    });
    assert.equal(
      r.mintBlockNumber,
      MINT_BLOCK,
      "dated from chainFirst*, not from the transferred-in NFT",
    );
    assert.equal(counts.mintFromChain, 1, "the transaction still is not");
  });

  it("falls back to firstMint* on a cache written before chainFirst*", async () => {
    const r = await mod.getPositionHistory(OLDEST, {
      rebalanceEvents: mkEvents({ firstMintTokenId: OLDEST }),
    });
    assert.equal(r.mintBlockNumber, MINT_BLOCK);
    assert.equal(counts.mintFromChain, 1, "still only for the transaction");
  });

  it("reads chain when both fields name a different NFT", async () => {
    /*- Neither source describes this NFT, so neither may date it —
     *  using either block would date this NFT from another one's mint. */
    const r = await mod.getPositionHistory(OLDEST, {
      rebalanceEvents: mkEvents({
        firstMintTokenId: FOREIGN,
        chainFirstTokenId: FOREIGN,
        chainFirstMintBlock: MINT_BLOCK,
        chainFirstMintTimestamp: MINT_TS,
      }),
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
