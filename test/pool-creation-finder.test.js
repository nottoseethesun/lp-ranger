"use strict";

/**
 * @file test/pool-creation-finder.test.js
 * @description Unit tests for the pool-deployment-block binary search.
 *
 * Most callers use `getPoolCreationBlockCached` from
 * `pool-creation-block.js` (covered by `test/pool-creation-block.test.js`);
 * this file drives the primitive directly, so the boundary, the call
 * count, and the error and not-found branches are each explicit.
 *
 * The provider double answers `getCode` from one number — the block the
 * pool was deployed in — which is the only fact the search is entitled to
 * use. It also counts calls, because the cost is the reason this exists.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { findPoolCreationBlock } = require("../src/pool-creation-finder");

const POOL = "0xP00L000000000000000000000000000000000002";
const CODE = "0x60806040";

/**
 * Provider whose `getCode` reports the pool as deployed at `createdAt`.
 * @param {number} createdAt  Deployment block.
 * @returns {{provider: object, calls: number[]}}
 */
function mkProvider(createdAt) {
  const calls = [];
  return {
    calls,
    provider: {
      async getCode(_addr, blockTag) {
        calls.push(blockTag);
        return blockTag >= createdAt ? CODE : "0x";
      },
    },
  };
}

describe("findPoolCreationBlock", () => {
  it("lands exactly on the deployment block", async () => {
    const { provider } = mkProvider(18_959_197);
    assert.equal(
      await findPoolCreationBlock(provider, {
        poolAddress: POOL,
        fromBlock: 0,
        toBlock: 27_537_296,
      }),
      18_959_197,
    );
  });

  it("finds a pool deployed in the very next block after the floor", async () => {
    const { provider } = mkProvider(1);
    assert.equal(
      await findPoolCreationBlock(provider, {
        poolAddress: POOL,
        fromBlock: 0,
        toBlock: 27_537_296,
      }),
      1,
    );
  });

  it("finds a pool deployed at the head", async () => {
    const { provider } = mkProvider(27_537_296);
    assert.equal(
      await findPoolCreationBlock(provider, {
        poolAddress: POOL,
        fromBlock: 0,
        toBlock: 27_537_296,
      }),
      27_537_296,
    );
  });

  it("costs about log2(range) calls, not a linear walk", async () => {
    /*- The whole point.  A chunked Factory log scan over the same range is
     *  ~900-1,100 queries; anything near that here means the search has
     *  degenerated into a walk. */
    const { provider, calls } = mkProvider(18_959_197);
    await findPoolCreationBlock(provider, {
      poolAddress: POOL,
      fromBlock: 0,
      toBlock: 27_537_296,
    });
    assert.ok(
      calls.length <= 30,
      `expected ~25 getCode calls, got ${calls.length}`,
    );
  });

  it("returns null when the pool holds no code at the head", async () => {
    /*- Not on this chain.  Returning a block would hand the caller a floor
     *  for a pool that never existed. */
    const { provider } = mkProvider(Number.MAX_SAFE_INTEGER);
    assert.equal(
      await findPoolCreationBlock(provider, {
        poolAddress: POOL,
        fromBlock: 0,
        toBlock: 27_537_296,
      }),
      null,
    );
  });

  it("returns the floor when the pool predates the window", async () => {
    /*- Code already present at `fromBlock`: the deployment is older than
     *  anything this search can see, so the floor is the tightest honest
     *  answer. */
    const { provider } = mkProvider(0);
    assert.equal(
      await findPoolCreationBlock(provider, {
        poolAddress: POOL,
        fromBlock: 1_000,
        toBlock: 27_537_296,
      }),
      1_000,
    );
  });

  it("propagates a provider error rather than guessing", async () => {
    /*- A node without historical state answers with an error.  Swallowing
     *  it and returning a block would move the caller's scan floor forward
     *  past events it still has to read. */
    const provider = {
      async getCode() {
        throw new Error("missing trie node");
      },
    };
    await assert.rejects(
      findPoolCreationBlock(provider, {
        poolAddress: POOL,
        fromBlock: 0,
        toBlock: 27_537_296,
      }),
      /missing trie node/,
    );
  });

  it("honours an abort signal", async () => {
    const { provider } = mkProvider(18_959_197);
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      findPoolCreationBlock(provider, {
        poolAddress: POOL,
        fromBlock: 0,
        toBlock: 27_537_296,
        signal: ctrl.signal,
      }),
      (e) => e.name === "AbortError",
    );
  });

  it("reports progress that reaches its own total", async () => {
    /*- Drives the dashboard's 5-50% scan-progress band; a callback that
     *  never reaches `total` leaves the bar short of where the next phase
     *  picks up. */
    const { provider } = mkProvider(18_959_197);
    const seen = [];
    await findPoolCreationBlock(provider, {
      poolAddress: POOL,
      fromBlock: 0,
      toBlock: 27_537_296,
      onProgress: (done, total) => seen.push([done, total]),
    });
    assert.ok(seen.length > 0, "progress must be reported");
    const [done, total] = seen[seen.length - 1];
    assert.equal(done, total);
    for (const [d, t] of seen) assert.ok(d <= t, `progress ${d} exceeded ${t}`);
  });

  it("returns null on missing or degenerate arguments", async () => {
    const { provider } = mkProvider(1);
    assert.equal(await findPoolCreationBlock(provider, {}), null);
    assert.equal(
      await findPoolCreationBlock(null, { poolAddress: POOL }),
      null,
    );
    assert.equal(
      await findPoolCreationBlock(provider, {
        poolAddress: POOL,
        fromBlock: 500,
        toBlock: 500,
      }),
      null,
    );
  });
});
