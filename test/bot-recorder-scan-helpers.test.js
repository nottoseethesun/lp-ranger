/**
 * @file test/bot-recorder-scan-helpers.test.js
 * @description Each NFT in the rebalance chain is scanned across its own
 *   life, not the pool's.
 *
 * `fetchAllNftEvents` took one `fromBlock` for the whole chain — the
 * pool's creation block — and handed the same one to every NFT. An NFT
 * cannot emit IncreaseLiquidity / Collect / DecreaseLiquidity before it
 * is minted, so everything before its mint was a guaranteed-empty walk.
 *
 * Measured on a real position: a 132-rebalance chain in a pool created
 * two years before the operator's first deposit. 1,144 chunks per NFT
 * across ~133 NFTs, three queries each, at 250 ms per request — about
 * 32 hours, nearly all of it scanning blocks where the NFT did not yet
 * exist. Bounded to each NFT's own mint, most drop to single-digit
 * chunks.
 *
 * The resume case is the subtle one and has its own test: there
 * `fromBlock` is a checkpoint from a previous scan, not the pool's
 * creation block, and it has to win over an earlier mint block or the
 * scan re-walks ground it already covered.
 */

"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");

const { mintBlocksByTokenId } = require("../src/nft-mint-blocks");

/** Record the fromBlock each NFT's scan was given. */
function withStubbedScanner(fn) {
  const compounder = require("../src/compounder");
  const seen = new Map();
  const restore = compounder.scanNftEvents;
  mock.method(compounder, "scanNftEvents", async (tid, opts) => {
    seen.set(String(tid), opts.fromBlock);
    return { ilEvents: [], collectEvents: [], dlEvents: [], ilLogsCount: 0 };
  });
  return fn(seen).finally(() => {
    compounder.scanNftEvents = restore;
    mock.reset();
  });
}

/*- Required after the stub is installed, so it binds the mocked
 *  `scanNftEvents` rather than the real one. */
function helpers() {
  delete require.cache[require.resolve("../src/bot-recorder-scan-helpers")];
  return require("../src/bot-recorder-scan-helpers");
}

/** #100 → #200 → #300, minted 5M and 6M blocks in. */
const CHAIN = [
  { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000_000 },
  { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000_000 },
];
const POOL_CREATION = 1_000_000;

describe("collectTokenIds", () => {
  it("covers the current NFT and every NFT in the chain", () => {
    const { collectTokenIds } = helpers();
    const ids = collectTokenIds({ tokenId: "300" }, CHAIN);
    assert.deepEqual([...ids].sort(), ["100", "200", "300"]);
  });
});

describe("fetchAllNftEvents scan floors", () => {
  it("scans each NFT from its own mint block", async () => {
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        ["100", "200", "300"],
        POOL_CREATION,
        mintBlocksByTokenId(CHAIN),
      );
      assert.equal(seen.get("200"), 5_000_000);
      assert.equal(seen.get("300"), 6_000_000);
    });
  });

  it("falls back to the shared floor for the chain's first NFT", async () => {
    /*- #100 appears only as an oldTokenId, so its mint predates the
     *  chain and the pool's creation block is the honest answer. */
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        ["100", "200", "300"],
        POOL_CREATION,
        mintBlocksByTokenId(CHAIN),
      );
      assert.equal(seen.get("100"), POOL_CREATION);
    });
  });

  it("keeps a resume checkpoint that is later than the mint block", async () => {
    /*- The incremental path passes a checkpoint from a previous scan as
     *  `fromBlock`.  Using the earlier mint block here would re-walk
     *  everything the last scan already covered — the exact waste this
     *  change exists to remove. */
    const CHECKPOINT = 7_000_000;
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        ["100", "200", "300"],
        CHECKPOINT,
        mintBlocksByTokenId(CHAIN),
      );
      for (const tid of ["100", "200", "300"]) {
        assert.equal(
          seen.get(tid),
          CHECKPOINT,
          `${tid} must resume, not rescan`,
        );
      }
    });
  });

  it("behaves as before when no mint blocks are supplied", async () => {
    /*- Callers without a chain to read from still get the old contract. */
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(["100", "200"], POOL_CREATION);
      assert.equal(seen.get("100"), POOL_CREATION);
      assert.equal(seen.get("200"), POOL_CREATION);
    });
  });

  it("never scans below the shared floor", async () => {
    /*- A mint block earlier than the floor must not widen the scan. */
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        ["200"],
        POOL_CREATION,
        mintBlocksByTokenId([
          { newTokenId: "200", blockNumber: POOL_CREATION - 500 },
        ]),
      );
      assert.equal(seen.get("200"), POOL_CREATION);
    });
  });
});
