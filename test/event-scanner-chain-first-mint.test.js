"use strict";

/**
 * @file test/event-scanner-chain-first-mint.test.js
 * @description `resolveChainFirstMint` — which position NFT starts the
 *   inferred chain, and the block it was minted in.
 *
 * Two facts about a pool's oldest position NFTs are easy to conflate,
 * and this function exists because they are not the same:
 *
 *   - the OLDEST-HELD NFT — earliest arrival of any kind, which
 *     `resolveFirstMintWithForeign` records for Lifetime Days;
 *   - the CHAIN-FIRST NFT — earliest arrival that was a mint, which is
 *     the first link of the chain `pairTransfers` infers, because that
 *     pairing uses mints only.
 *
 * They name the same NFT when every arrival was a mint, and different
 * NFTs as soon as one arrived by transfer. Per-day P&L opens its first
 * row from the CHAIN-FIRST NFT's mint.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { resolveChainFirstMint } = require("../src/event-scanner-mint-lookup");

const ZERO = "0x0000000000000000000000000000000000000000";
const OTHER_WALLET = "0x00000000000000000000000000000000000000aa";

/** One arrival at this wallet. */
function arrival(tokenId, timestamp, blockNumber, from = ZERO) {
  return { direction: "in", tokenId, timestamp, blockNumber, from };
}

describe("resolveChainFirstMint", () => {
  it("names the earliest minted NFT and its block", () => {
    const r = resolveChainFirstMint({}, [
      arrival("200", 1000, 26_000_000),
      arrival("300", 2000, 26_001_000),
      arrival("400", 3000, 26_002_000),
    ]);
    assert.equal(r.chainFirstTokenId, "200");
    assert.equal(r.chainFirstMintBlock, 26_000_000);
    assert.equal(r.chainFirstMintTimestamp, 1000);
  });

  it("skips a transferred-in NFT even when it arrived first", () => {
    /*- The reason this function is separate from its sibling. #100 is
     *  the oldest-held NFT, but `pairTransfers` builds the chain from
     *  mints, so the chain starts at #200. */
    const r = resolveChainFirstMint({}, [
      arrival("100", 500, 25_000_000, OTHER_WALLET),
      arrival("200", 1000, 26_000_000),
      arrival("300", 2000, 26_001_000),
    ]);
    assert.equal(r.chainFirstTokenId, "200");
    assert.equal(r.chainFirstMintBlock, 26_000_000);
  });

  it("ignores arrival order in the input array", () => {
    /*- Callers pass a sorted list today; sorting here means the answer
     *  does not silently depend on that staying true. */
    const r = resolveChainFirstMint({}, [
      arrival("400", 3000, 26_002_000),
      arrival("200", 1000, 26_000_000),
      arrival("300", 2000, 26_001_000),
    ]);
    assert.equal(r.chainFirstTokenId, "200");
  });

  it("keeps the cached answer when this window holds only later mints", () => {
    /*- An incremental scan sees a slice of the chain. Without this the
     *  recorded first mint would creep toward the chain tip on every
     *  run. */
    const cached = {
      chainFirstTokenId: "200",
      chainFirstMintBlock: 26_000_000,
      chainFirstMintTimestamp: 1000,
    };
    const r = resolveChainFirstMint(cached, [arrival("500", 9000, 26_009_000)]);
    assert.equal(r.chainFirstTokenId, "200");
    assert.equal(r.chainFirstMintBlock, 26_000_000);
  });

  it("replaces the cached answer when this window holds an earlier mint", () => {
    const cached = {
      chainFirstTokenId: "300",
      chainFirstMintBlock: 26_001_000,
      chainFirstMintTimestamp: 2000,
    };
    const r = resolveChainFirstMint(cached, [arrival("200", 1000, 26_000_000)]);
    assert.equal(r.chainFirstTokenId, "200");
    assert.equal(r.chainFirstMintTimestamp, 1000);
  });

  it("returns the cached answer when no mints are in this window", () => {
    const cached = {
      chainFirstTokenId: "200",
      chainFirstMintBlock: 26_000_000,
      chainFirstMintTimestamp: 1000,
    };
    assert.deepEqual(resolveChainFirstMint(cached, []), cached);
    assert.deepEqual(
      resolveChainFirstMint(cached, [
        arrival("100", 500, 25_000_000, OTHER_WALLET),
      ]),
      cached,
    );
  });

  it("answers nulls when nothing is known", () => {
    assert.deepEqual(resolveChainFirstMint({}, []), {
      chainFirstTokenId: null,
      chainFirstMintBlock: null,
      chainFirstMintTimestamp: null,
    });
    assert.deepEqual(resolveChainFirstMint({}, undefined), {
      chainFirstTokenId: null,
      chainFirstMintBlock: null,
      chainFirstMintTimestamp: null,
    });
  });

  it("ignores an arrival with no resolved timestamp", () => {
    /*- A descriptor whose block timestamp could not be read has
     *  `timestamp: 0`, which would otherwise sort first and win. */
    const r = resolveChainFirstMint({}, [
      arrival("199", 0, 25_500_000),
      arrival("200", 1000, 26_000_000),
    ]);
    assert.equal(r.chainFirstTokenId, "200");
  });
});
