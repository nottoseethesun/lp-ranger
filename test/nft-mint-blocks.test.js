/**
 * @file test/nft-mint-blocks.test.js
 * @description Pins the per-NFT scan floor.
 *
 * Every NFT in a rebalance chain used to be scanned from the pool's
 * creation block. An NFT cannot emit `IncreaseLiquidity`, `Collect` or
 * `DecreaseLiquidity` before the block it was minted in, so all of the
 * blocks before its mint were a guaranteed-empty walk.
 *
 * That was invisible while log queries ran unpaced. Once every request
 * went through the global 250 ms queue it became the dominant cost: a
 * cold-cache lifetime scan of a three-NFT chain ran ~10,000 paced
 * requests — about three quarters of an hour — and because the bot's
 * poll cycle awaits the same scan, the bot read nothing and could not
 * rebalance for the duration.
 *
 * Two things are pinned: the mapping itself, and that the scan really
 * uses it (driven through the exported `_scanCompounds`, with the
 * detector injected so no RPC is involved).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { mintBlocksByTokenId, scanFloorFor } = require("../src/nft-mint-blocks");
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

describe("_scanCompounds uses each NFT's own floor", () => {
  /** Record the fromBlock each per-NFT scan was given. */
  function run(events, position) {
    const seen = new Map();
    const detect = async (tid, opts) => {
      seen.set(String(tid), opts.fromBlock);
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
});
