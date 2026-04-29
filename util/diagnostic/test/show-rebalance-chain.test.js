/**
 * @file util/diagnostic/test/show-rebalance-chain.test.js
 * @description
 * Tests for the pure helpers in show-rebalance-chain.js.  The CLI
 * `main()` is gated behind `require.main === module`, so requiring
 * the tool here is safe and does not start an RPC scan.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { tokenIdFromLog, dedupe } = require("../show-rebalance-chain");

test("tokenIdFromLog — decodes the indexed tokenId from topic[3]", () => {
  /*- Transfer(from, to, tokenId) → topics: [topic0, from, to, tokenId]. */
  const log = {
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      "0x" + "0".repeat(64),
      "0x" + "1".repeat(64),
      "0x000000000000000000000000000000000000000000000000000000000002dde2",
    ],
  };
  assert.equal(tokenIdFromLog(log), "187874");
});

test("tokenIdFromLog — returns '?' on malformed input", () => {
  assert.equal(tokenIdFromLog({ topics: [] }), "?");
  assert.equal(tokenIdFromLog({ topics: [null, null, null, "not hex"] }), "?");
});

test("dedupe — drops repeats with the same (block,tx,tokenId,dir) tuple", () => {
  const t = "0xddf2";
  const log = (block, tx, tid, dir) => ({
    blockNumber: block,
    transactionHash: tx,
    transactionIndex: 0,
    topics: [
      t,
      "0x" + "0".repeat(64),
      "0x" + "1".repeat(64),
      "0x" + tid.padStart(64, "0"),
    ],
    _dir: dir,
  });
  const a = log(100, "0xaa", "1", "IN");
  const dup = log(100, "0xaa", "1", "IN");
  const b = log(100, "0xaa", "1", "OUT");
  const c = log(101, "0xbb", "2", "IN");
  const out = dedupe([a, dup, b, c]);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((l) => `${l.blockNumber}|${l._dir}`),
    ["100|IN", "100|OUT", "101|IN"],
  );
});

test("dedupe — empty input returns empty array", () => {
  assert.deepEqual(dedupe([]), []);
});
