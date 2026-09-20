"use strict";

/**
 * @file test/nft-events-batch-share-read.test.js
 * @description Tests for `shareRead` in `src/nft-events-batch.js`: a pass
 *   reads the chain once however many consumers ask, and a failed read is
 *   not kept.
 *
 *   Kept apart from test/nft-events-batch.test.js so that file stays
 *   under the 500-line cap.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { shareRead } = require("../src/nft-events-batch");

describe("shareRead", () => {
  it("reads nothing until first asked", () => {
    let reads = 0;
    shareRead(async () => {
      reads += 1;
    });
    assert.equal(reads, 0);
  });

  it("reads once, however many callers ask", async () => {
    let reads = 0;
    const read = shareRead(async () => ({ n: ++reads }));
    const [a, b] = await Promise.all([read(), read()]);
    const c = await read();
    assert.equal(reads, 1);
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
  });

  it("does not keep a failed read", async () => {
    /*-
     *  Each consumer gets an attempt of its own: sharing the read must
     *  not share its failure.
     */
    let reads = 0;
    const read = shareRead(async () => {
      reads += 1;
      if (reads === 1) throw new Error("rpc unavailable");
      return reads;
    });
    await assert.rejects(read(), /rpc unavailable/);
    const retried = await read();
    assert.equal(retried, 2);
    const again = await read();
    assert.equal(again, 2, "and a success is kept");
  });
});
