/**
 * @file test/nft-mint-blocks.test.js
 * @description Pins the per-NFT scan floor.
 *
 * An NFT cannot emit `IncreaseLiquidity`, `Collect` or
 * `DecreaseLiquidity` before the block it was minted in, so scanning
 * one from the pool's creation block is a guaranteed-empty walk across
 * everything before its mint.
 *
 * Every request goes through the global request queue, so that walk is
 * wall-clock time: a cold-cache lifetime scan of a three-NFT chain
 * unbounded is ~10,000 paced requests, about three quarters of an
 * hour. The bot's poll cycle awaits the same scan, so it reads nothing
 * and cannot rebalance for the duration.
 *
 * This file pins the mapping itself. That each chain read really uses
 * it is pinned beside each read — see the note at the end.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  mintBlocksByTokenId,
  scanFloorFor,
  nftScanFrom,
  nftScanFromBlock,
  chainScanFloor,
} = require("../src/nft-mint-blocks");

/** A rebalance chain: #100 → #200 → #300. */
const CHAIN = [
  { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000_000 },
  { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000_000 },
];

describe("mintBlocksByTokenId", () => {
  it("maps each minted NFT to the block it appeared in", () => {
    const m = mintBlocksByTokenId(CHAIN);
    assert.equal(m.get("200"), 5_000_000);
    assert.equal(m.get("300"), 6_000_000);
  });

  it("does not claim a mint block for the first NFT in the chain", () => {
    /*- #100 only ever appears as an oldTokenId — its mint predates the
     *  chain, so callers must fall back to the pool floor rather than
     *  guess. */
    assert.equal(mintBlocksByTokenId(CHAIN).get("100"), undefined);
  });

  it("keeps the earliest block when an id repeats", () => {
    /*- A floor that is too high silently loses events; too low only
     *  costs time.  So a tie breaks downward. */
    const m = mintBlocksByTokenId([
      { newTokenId: "7", blockNumber: 900 },
      { newTokenId: "7", blockNumber: 400 },
    ]);
    assert.equal(m.get("7"), 400);
  });

  it("accepts numeric token ids and keys them as strings", () => {
    const m = mintBlocksByTokenId([{ newTokenId: 42, blockNumber: 11 }]);
    assert.equal(m.get("42"), 11);
  });

  it("ignores entries with no usable block number", () => {
    const m = mintBlocksByTokenId([
      { newTokenId: "1" },
      { newTokenId: "2", blockNumber: null },
      { newTokenId: "3", blockNumber: "8000" },
      { newTokenId: "4", blockNumber: -1 },
      null,
    ]);
    assert.equal(m.size, 0);
  });

  it("returns an empty map for a missing or non-array input", () => {
    assert.equal(mintBlocksByTokenId(undefined).size, 0);
    assert.equal(mintBlocksByTokenId(null).size, 0);
    assert.equal(mintBlocksByTokenId({}).size, 0);
    assert.equal(mintBlocksByTokenId([]).size, 0);
  });
});

describe("scanFloorFor", () => {
  it("prefers the NFT's own mint block", () => {
    assert.equal(scanFloorFor(mintBlocksByTokenId(CHAIN), "300", 1), 6_000_000);
  });

  it("falls back when the mint is unknown", () => {
    assert.equal(scanFloorFor(mintBlocksByTokenId(CHAIN), "100", 123), 123);
  });

  it("passes a null fallback through, so callers can defer the lookup", () => {
    /*- The bot path uses null to mean "not known yet" so it only pays
     *  for the pool-creation lookup when it actually needs it. */
    assert.equal(scanFloorFor(mintBlocksByTokenId(CHAIN), "100", null), null);
  });

  it("tolerates a missing map", () => {
    assert.equal(scanFloorFor(undefined, "1", 9), 9);
  });
});

describe("nftScanFrom", () => {
  const MINTS = mintBlocksByTokenId(CHAIN);

  it("tightens a pool-creation floor to the NFT's own mint", () => {
    assert.equal(nftScanFrom(MINTS, "300", 1_000), 6_000_000);
  });

  it("lets a resume checkpoint beat an earlier mint block", () => {
    /*- The incremental path's floor is a checkpoint, not pool creation.
     *  Using the earlier mint would re-walk what the last scan covered. */
    assert.equal(nftScanFrom(MINTS, "200", 9_000_000), 9_000_000);
  });

  it("falls back to the shared floor for an NFT not in the chain", () => {
    assert.equal(nftScanFrom(MINTS, "100", 1_000), 1_000);
  });

  it("never returns a non-finite block", () => {
    /*- NaN would make chunkRanges answer an empty window list, so the
     *  scan would find nothing and report it as "no events" rather than
     *  as a failure.  0 can only widen the scan, never narrow it. */
    for (const bad of [undefined, null, NaN, Infinity, "5"]) {
      const got = nftScanFrom(MINTS, "100", bad);
      assert.ok(
        Number.isFinite(got),
        `floor ${String(bad)} produced ${String(got)}`,
      );
    }
  });

  it("still applies the mint block when the shared floor is unusable", () => {
    assert.equal(nftScanFrom(MINTS, "300", undefined), 6_000_000);
  });
});

describe("chainScanFloor", () => {
  /*- The oldest NFT in a chain has no mint block in the events, so it
   *  would otherwise fall all the way back to the pool's creation
   *  block.  On a pool that existed long before the operator's first
   *  deposit that one NFT is the most expensive scan of the run. */
  function withFirstMint(block) {
    const evts = [...CHAIN];
    evts.firstMintBlockNumber = block;
    return evts;
  }

  it("lifts the pool floor to the chain's first mint", () => {
    assert.equal(
      chainScanFloor(withFirstMint(26_000_000), 18_900_000),
      26_000_000,
    );
  });

  it("keeps the pool floor when it is already higher", () => {
    /*- A resume checkpoint can outrank the first mint; taking the lower
     *  of the two would re-walk what the last scan covered. */
    assert.equal(chainScanFloor(withFirstMint(5_000), 9_000), 9_000);
  });

  it("keeps the pool floor when the scanner resolved no first mint", () => {
    assert.equal(chainScanFloor(CHAIN, 18_900_000), 18_900_000);
  });

  it("tolerates missing events and a non-finite floor", () => {
    assert.equal(chainScanFloor(undefined, 100), 100);
    assert.equal(chainScanFloor(null, 100), 100);
    assert.equal(chainScanFloor(withFirstMint(500), undefined), 500);
    assert.ok(Number.isFinite(chainScanFloor(CHAIN, undefined)));
  });

  it("ignores a non-numeric firstMintBlockNumber", () => {
    assert.equal(chainScanFloor(withFirstMint("26000000"), 7), 7);
    assert.equal(chainScanFloor(withFirstMint(null), 7), 7);
  });
});

describe("the module offers no upper bound", () => {
  /*- Deliberate.  One could only come from the app's inferred
   *  succession, which reads consecutive mints as successive
   *  rebalances.  A dust mint from a failed or partial rebalance is
   *  indistinguishable in the Transfer log, so the NFT it appears to
   *  replace can still be funded and drain later — past any bound taken
   *  from that inference.
   *
   *  Pinned as an export test because the loss is silent: an NFT whose
   *  drain falls past such a bound returns zero Collects and is
   *  skipped, and one that compounded mid-life returns the compound's
   *  Collect, which is then read as its exit value. */
  it("exports no retirement-block or scan-to helper", () => {
    const mod = require("../src/nft-mint-blocks");
    assert.equal(mod.retirementBlocksByTokenId, undefined);
    assert.equal(mod.nftScanTo, undefined);
    assert.equal(mod.nftScanWindow, undefined);
  });
});

describe("nftScanFromBlock", () => {
  it("tightens a shared floor to the NFT's own mint", () => {
    assert.equal(nftScanFromBlock({ mintBlock: 900, sharedFloor: 500 }), 900);
  });

  it("lets a resume checkpoint beat an earlier mint block", () => {
    assert.equal(nftScanFromBlock({ mintBlock: 500, sharedFloor: 900 }), 900);
  });

  it("widens rather than breaking on unusable input", () => {
    assert.equal(nftScanFromBlock({ mintBlock: NaN, sharedFloor: 7 }), 7);
    assert.equal(nftScanFromBlock({ sharedFloor: undefined }), 0);
    assert.equal(nftScanFromBlock(), 0);
  });
});

/*- That the chain reads really use these floors is pinned where each
 *  read is made: test/bot-recorder-scan-helpers.test.js (the managed
 *  lifetime scan), test/position-details-chain-read.test.js (the
 *  unmanaged details path) and test/position-history-scan-chain.test.js
 *  (epoch reconstruction). */
