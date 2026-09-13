/**
 * @file test/nft-mint-blocks.test.js
 * @description Pins the per-NFT scan floor.
 *
 * An NFT cannot emit `IncreaseLiquidity`, `Collect` or
 * `DecreaseLiquidity` before the block it was minted in, so scanning
 * one from the pool's creation block is a guaranteed-empty walk across
 * everything before its mint.
 *
 * Every request goes through the global 250 ms queue, so that walk is
 * wall-clock time: a cold-cache lifetime scan of a three-NFT chain
 * unbounded is ~10,000 paced requests, about three quarters of an
 * hour. The bot's poll cycle awaits the same scan, so it reads nothing
 * and cannot rebalance for the duration.
 *
 * Two things are pinned: the mapping itself, and that the scan really
 * uses it (driven through the exported `_scanCompounds`, with the
 * detector injected so no RPC is involved).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  mintBlocksByTokenId,
  scanFloorFor,
  nftScanFrom,
  chainScanFloor,
  retirementBlocksByTokenId,
  nftScanTo,
} = require("../src/nft-mint-blocks");
const { _scanCompounds } = require("../src/position-details-compound");

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

describe("retirementBlocksByTokenId", () => {
  /*- A rebalance drains the old NFT and mints its replacement, so the
   *  old one stops emitting at that block.  Scanning it to head after
   *  that re-reads the entire remainder of the chain for nothing. */
  it("maps each retired NFT to the block it was replaced at", () => {
    const m = retirementBlocksByTokenId(CHAIN);
    assert.equal(m.get("100"), 5_000_000);
    assert.equal(m.get("200"), 6_000_000);
  });

  it("leaves the CURRENT NFT out, so it keeps scanning to head", () => {
    /*- #300 was never replaced — it only appears as a newTokenId. */
    assert.equal(retirementBlocksByTokenId(CHAIN).get("300"), undefined);
  });

  it("keeps the LATEST block when an id repeats", () => {
    /*- Mirror of the mint map taking the earliest: an upper bound that
     *  is too low silently loses events; too high only costs time. */
    const m = retirementBlocksByTokenId([
      { oldTokenId: "7", blockNumber: 400 },
      { oldTokenId: "7", blockNumber: 900 },
    ]);
    assert.equal(m.get("7"), 900);
  });

  it("ignores entries with no usable block number", () => {
    const m = retirementBlocksByTokenId([
      { oldTokenId: "1" },
      { oldTokenId: "2", blockNumber: null },
      { oldTokenId: "3", blockNumber: "800" },
      { oldTokenId: "4", blockNumber: -1 },
      null,
    ]);
    assert.equal(m.size, 0);
  });

  it("returns an empty map for a missing or non-array input", () => {
    assert.equal(retirementBlocksByTokenId(undefined).size, 0);
    assert.equal(retirementBlocksByTokenId({}).size, 0);
  });
});

describe("nftScanTo", () => {
  const RETIRED = retirementBlocksByTokenId(CHAIN);

  it("stops a retired NFT at its replacement's mint", () => {
    assert.equal(nftScanTo(RETIRED, "100"), 5_000_000);
    assert.equal(nftScanTo(RETIRED, "200"), 6_000_000);
  });

  it("scans the current NFT to head", () => {
    assert.equal(nftScanTo(RETIRED, "300"), "latest");
  });

  it("tolerates a missing map", () => {
    assert.equal(nftScanTo(undefined, "1"), "latest");
  });
});

describe("_scanCompounds uses each NFT's own floor", () => {
  /** Record the fromBlock each per-NFT scan was given. */
  const seenTo = new Map();
  function run(events, position) {
    const seen = new Map();
    const detect = async (tid, opts) => {
      seen.set(String(tid), opts.fromBlock);
      seenTo.set(String(tid), opts.toBlock);
      return { totalCompoundedUsd: 0, compounds: [], totalNftGasWei: "0" };
    };
    return _scanCompounds(
      position,
      events,
      { walletAddress: "0xw" },
      { decimals0: 18, decimals1: 18, poolAddress: null },
      { price0: 1, price1: 1 },
      { positions: {} },
      "key",
      undefined,
      detect,
    ).then(() => seen);
  }

  it("scans each NFT from its own mint block", async () => {
    const seen = await run(CHAIN, { tokenId: "300" });
    assert.equal(seen.get("200"), 5_000_000);
    assert.equal(seen.get("300"), 6_000_000);
  });

  it("falls back to the pool floor only for the chain's first NFT", async () => {
    /*- poolAddress is null here, so the pool floor resolves to 0.  What
     *  matters is that ONLY #100 gets it. */
    const seen = await run(CHAIN, { tokenId: "300" });
    assert.equal(
      seen.get("100"),
      0,
      "first NFT has no mint block in the chain",
    );
    assert.notEqual(seen.get("200"), 0);
    assert.notEqual(seen.get("300"), 0);
  });

  it("covers every NFT in the chain", async () => {
    const seen = await run(CHAIN, { tokenId: "300" });
    assert.deepEqual([...seen.keys()].sort(), ["100", "200", "300"]);
  });

  it("stops each retired NFT at its replacement's mint", async () => {
    /*- The other half of the bound: a drained NFT emits nothing after
     *  the rebalance that replaced it. */
    await run(CHAIN, { tokenId: "300" });
    assert.equal(seenTo.get("100"), 5_000_000);
    assert.equal(seenTo.get("200"), 6_000_000);
    assert.equal(seenTo.get("300"), "latest", "the current NFT runs to head");
  });
});
