/**
 * @file util/test/show-rebalance-chain.test.js
 * @description
 * Tests for the pure helpers in show-rebalance-chain.js.  The CLI
 * `main()` is gated behind `require.main === module`, so requiring
 * the tool here is safe and does not start an RPC scan.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  tokenIdFromLog,
  dedupe,
  classifyTransfer,
  renderHeader,
  renderTransfers,
} = require("../diagnostic/show-rebalance-chain");
const { captureConsole } = require("./_capture");

const ZERO = "0x" + "0".repeat(64);
const WALLET_TOPIC =
  "0x" + "0".repeat(24) + "4e448d6fd48b2bb0f2ca5c1d1d34e4bdd5fe6e8f";
const TID_TOPIC =
  "0x000000000000000000000000000000000000000000000000000000000002dde2";

/** A Transfer log as the scanner tags it. */
function xfer({ dir, from, to, block = 500, tx = "0xTX" }) {
  return {
    _dir: dir,
    blockNumber: block,
    topics: ["0xTOPIC0", from, to, TID_TOPIC],
    transactionHash: tx,
  };
}

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

test("dedupe — drops repeats with same (block,tx,tokenId,dir)", () => {
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

/* ---------- transfer classification ---------- */

test("classifyTransfer — an inbound transfer from zero is tagged a mint", () => {
  /*- Untagged, a mint is indistinguishable from an ordinary inbound
   *  transfer — and finding mints is why the tool exists. */
  const r = classifyTransfer(
    xfer({ dir: "IN", from: ZERO, to: WALLET_TOPIC }),
    new Map(),
  );
  assert.equal(r.tag, " (mint)");
  assert.equal(r.tokenId, "187874");
});

test("classifyTransfer — an outbound transfer to zero is tagged a burn", () => {
  const r = classifyTransfer(
    xfer({ dir: "OUT", from: WALLET_TOPIC, to: ZERO }),
    new Map(),
  );
  assert.equal(r.tag, " (burn)");
});

test("classifyTransfer — an ordinary transfer carries no tag", () => {
  const inbound = classifyTransfer(
    xfer({ dir: "IN", from: WALLET_TOPIC, to: WALLET_TOPIC }),
    new Map(),
  );
  const outbound = classifyTransfer(
    xfer({ dir: "OUT", from: WALLET_TOPIC, to: WALLET_TOPIC }),
    new Map(),
  );
  assert.equal(inbound.tag, "");
  assert.equal(outbound.tag, "");
});

test("classifyTransfer — a zero SENDER on an outbound row is not a burn", () => {
  /*- The zero address matters on a specific side per direction; testing
   *  only one side would let a swapped topic index pass. */
  const r = classifyTransfer(
    xfer({ dir: "OUT", from: ZERO, to: WALLET_TOPIC }),
    new Map(),
  );
  assert.equal(r.tag, "");
});

test("classifyTransfer — pads the direction so columns line up", () => {
  const inbound = classifyTransfer(
    xfer({ dir: "IN", from: ZERO, to: WALLET_TOPIC }),
    new Map(),
  );
  assert.equal(inbound.dir, "IN ");
  assert.equal(inbound.dir.length, 3);
});

test("classifyTransfer — resolves the block timestamp when known", () => {
  const log = xfer({ dir: "IN", from: ZERO, to: WALLET_TOPIC, block: 42 });
  assert.equal(
    classifyTransfer(log, new Map([[42, 1_700_000_000]])).ts,
    1_700_000_000,
  );
  assert.equal(classifyTransfer(log, new Map()).ts, undefined);
});

/* ---------- rendering ---------- */

test("renderHeader — states the wallet, RPC, range and PM contract", async () => {
  const res = await captureConsole(() =>
    renderHeader({
      wallet: "0xWALLET",
      rpcUrl: "https://rpc.example",
      fromBlock: 10,
      head: 99,
      years: 5,
      pmAddress: "0xPM",
    }),
  );
  const text = res.out.join("\n");
  assert.match(text, /wallet:\s+0xWALLET/);
  assert.match(text, /block range: 10 → 99 {2}\(~5 year\(s\)\)/);
  assert.match(text, /PM address:\s+0xPM/);
  assert.match(text, /Scanning Transfer events/);
});

test("renderTransfers — one row per log, mint tagged, table closed", async () => {
  const logs = [
    xfer({ dir: "IN", from: ZERO, to: WALLET_TOPIC, block: 10, tx: "0xa" }),
    xfer({
      dir: "OUT",
      from: WALLET_TOPIC,
      to: WALLET_TOPIC,
      block: 11,
      tx: "0xb",
    }),
  ];
  const res = await captureConsole(() =>
    renderTransfers(logs, new Map([[10, 1_700_000_000]])),
  );
  const text = res.out.join("\n");
  assert.match(text, /DIR {2}BLOCK/);
  assert.match(text, /0xa \(mint\)/);
  assert.match(text, /OUT {2}11/);
  assert.match(text, /—/, "the unresolved block renders a dash, not a blank");
  assert.match(text, /Done\./);
});

test("renderTransfers — an empty scan still prints a closed table", async () => {
  /*- A bare header with nothing under it reads as a crash. */
  const res = await captureConsole(() => renderTransfers([], new Map()));
  assert.match(res.out.join("\n"), /Done\./);
});
