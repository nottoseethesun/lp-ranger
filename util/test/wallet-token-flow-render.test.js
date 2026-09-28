/**
 * @file util/test/wallet-token-flow-render.test.js
 * @description
 * Covers the presentation layer of `wallet-token-flow`, plus the two
 * pieces of the tool that decide what reaches it: `buildTransferRows`
 * (direction, counterparty and amount decoding) and `reportToken` (the
 * per-token section).
 *
 * `buildTransferRows` is where this tool is easiest to get subtly
 * wrong. A Transfer log carries the sender in topic[1] and the
 * recipient in topic[2]; reading the wrong one produces a report that
 * is entirely plausible and entirely misleading — every counterparty
 * shows as the wallet itself. The tests below pin both directions.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { captureConsole } = require("./_capture");
const render = require("../diagnostic/wallet-token-flow/render");
const {
  fmtAmount,
  buildTransferRows,
  reportToken,
  readTokenMeta,
} = require("../diagnostic/wallet-token-flow");

const WALLET = "0x4e448D6fd48B2Bb0F2Ca5c1D1d34E4bDd5FE6E8f";
const OTHER = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const TOKEN = "0x57fde0a71132198BBeC939B98976993d8D89D225";

/** 32-byte topic form of an address. */
function topic(addr) {
  return "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
}

/** A Transfer log as `scanToken` hands it on, with its `_dir` tag. */
function transferLog({ dir, from, to, value, block = 100, tx = "0xTX" }) {
  return {
    _dir: dir,
    blockNumber: block,
    topics: ["0xTOPIC0", topic(from), topic(to)],
    data: "0x" + value.toString(16),
    transactionHash: tx,
  };
}

/* ---------- row construction ---------- */

test("buildTransferRows — an inbound row names the SENDER as counterparty", () => {
  const logs = [
    transferLog({ dir: "IN", from: OTHER, to: WALLET, value: 1000n }),
  ];
  const { rows } = buildTransferRows(logs, new Map([[100, 1_700_000_000]]));
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].counterparty.toLowerCase(),
    OTHER.toLowerCase(),
    "who sent it, not the wallet that received it",
  );
  assert.equal(rows[0].dir, "IN");
  assert.equal(
    rows[0].amount,
    1000n,
    "the log's hex data decodes back to 1000",
  );
});

test("buildTransferRows — an outbound row names the RECIPIENT", () => {
  const logs = [
    transferLog({ dir: "OUT", from: WALLET, to: OTHER, value: 16n }),
  ];
  const { rows } = buildTransferRows(logs, new Map());
  assert.equal(rows[0].counterparty.toLowerCase(), OTHER.toLowerCase());
});

test("buildTransferRows — totals IN and OUT separately", () => {
  const logs = [
    transferLog({ dir: "IN", from: OTHER, to: WALLET, value: 0x10n }),
    transferLog({ dir: "IN", from: OTHER, to: WALLET, value: 0x20n }),
    transferLog({ dir: "OUT", from: WALLET, to: OTHER, value: 0x05n }),
  ];
  const { sumIn, sumOut } = buildTransferRows(logs, new Map());
  assert.equal(sumIn, 48n);
  assert.equal(sumOut, 5n);
});

test("buildTransferRows — carries the timestamp through, undefined if absent", () => {
  const logs = [
    transferLog({ dir: "IN", from: OTHER, to: WALLET, value: 1n, block: 7 }),
  ];
  const withTs = buildTransferRows(logs, new Map([[7, 1_700_000_000]]));
  assert.equal(withTs.rows[0].ts, 1_700_000_000);
  const without = buildTransferRows(logs, new Map());
  assert.equal(without.rows[0].ts, undefined, "a missing block renders as —");
});

test("buildTransferRows — empty input yields zero sums and no rows", () => {
  const out = buildTransferRows([], new Map());
  assert.deepEqual(out.rows, []);
  assert.equal(out.sumIn, 0n);
  assert.equal(out.sumOut, 0n);
});

/* ---------- token metadata ---------- */

test("readTokenMeta — falls back when the token answers neither call", async () => {
  /*- A non-standard token is still worth scanning; refusing to report
   *  its transfers because `symbol()` reverted would be worse than a
   *  "?" label. */
  const provider = {
    call: async () => {
      throw new Error("execution reverted");
    },
  };
  const meta = await readTokenMeta(provider, TOKEN);
  assert.deepEqual(meta, { symbol: "?", decimals: 18 });
});

/* ---------- rendering ---------- */

test("renderHeader — states wallet, tokens, window and RPC", async () => {
  const res = await captureConsole(() =>
    render.renderHeader({
      wallet: WALLET,
      tokens: [TOKEN, OTHER],
      fromSec: 1_700_000_000,
      toSec: 1_700_086_400,
      fromBlock: 100,
      toBlock: 200,
      rpcUrl: "https://rpc.example",
    }),
  );
  const text = res.out.join("\n");
  assert.ok(text.includes(WALLET));
  assert.ok(text.includes(`${TOKEN}, ${OTHER}`));
  assert.match(text, /blocks 100–200/);
  assert.match(text, /https:\/\/rpc\.example/);
  assert.match(text, /2023-11-14.*UTC/, "the window is shown in wall time");
});

test("renderTokenHeading — carries the symbol, address and decimals", async () => {
  const res = await captureConsole(() =>
    render.renderTokenHeading("HEX", TOKEN, 8),
  );
  assert.match(res.out.join(""), /HEX @ 0x57fde0a7.*decimals=8/);
});

test("renderNoTransfers — says so rather than leaving a blank section", async () => {
  /*- "Empty" and "never ran" look identical otherwise, and the
   *  difference decides whether the operator widens the window. */
  const res = await captureConsole(() => render.renderNoTransfers());
  assert.match(res.out.join(""), /no transfers in window/);
});

test("renderTransferTableHeader — labels each column", async () => {
  const res = await captureConsole(() => render.renderTransferTableHeader());
  const text = res.out.join("");
  /*- Substring checks: a RegExp built from a variable trips the
   *  security lint, and these are plain literals anyway. */
  for (const col of ["DIR", "BLOCK", "TIMESTAMP", "AMOUNT", "COUNTERPARTY"]) {
    assert.ok(text.includes(col), `column "${col}" must be labelled`);
  }
});

test("renderTransferRow — shows direction, scaled amount and the tx", async () => {
  const res = await captureConsole(() =>
    render.renderTransferRow(
      {
        dir: "IN",
        blockNumber: 12345,
        ts: 1_700_000_000,
        amount: 150_000_000n,
        counterparty: OTHER,
        tx: "0xabc",
      },
      fmtAmount,
      8,
    ),
  );
  const row = res.out.join("");
  assert.match(row, /^IN\s+12345/);
  assert.match(row, /1\.5/, "150000000 at 8 decimals is 1.5");
  assert.match(row, /0xabc$/);
});

test("renderTransferRow — an unknown timestamp renders as a dash", async () => {
  const res = await captureConsole(() =>
    render.renderTransferRow(
      {
        dir: "OUT",
        blockNumber: 1,
        ts: undefined,
        amount: 1n,
        counterparty: OTHER,
        tx: "0x1",
      },
      fmtAmount,
      0,
    ),
  );
  assert.match(res.out.join(""), /—/);
});

test("renderSummary — signs the net flow and formats its magnitude", async () => {
  const res = await captureConsole(() =>
    render.renderSummary(
      [
        {
          symbol: "HEX",
          sumIn: 300_000_000n,
          sumOut: 100_000_000n,
          decimals: 8,
        },
        {
          symbol: "PLS",
          sumIn: 100_000_000n,
          sumOut: 400_000_000n,
          decimals: 8,
        },
      ],
      fmtAmount,
    ),
  );
  const text = res.out.join("\n");
  assert.match(text, /HEX.*net: \+2/, "more in than out reads positive");
  assert.match(text, /PLS.*net: -3/, "more out than in reads negative");
  assert.match(text, /Done\./);
});

test("renderSummary — an exactly balanced token reads as +0", async () => {
  /*- The magnitude is taken from the absolute value; a bare negative
   *  reaching the unsigned formatter would render nonsense. */
  const res = await captureConsole(() =>
    render.renderSummary(
      [{ symbol: "HEX", sumIn: 5n, sumOut: 5n, decimals: 0 }],
      fmtAmount,
    ),
  );
  assert.match(res.out.join("\n"), /net: \+0/);
});

/* ---------- per-token section ---------- */

/** Provider double: `call` answers decimals/symbol, `getBlock` a time. */
function metaProvider(decimals = 8) {
  return {
    call: async () => "0x" + decimals.toString(16).padStart(64, "0"),
    getBlock: async () => ({ timestamp: 1_700_000_000 }),
  };
}

test("reportToken — prints the empty section and zero sums", async () => {
  const res = await captureConsole(() =>
    reportToken(metaProvider(), TOKEN, WALLET, 1, 100, async () => []),
  );
  assert.equal(res.value.sumIn, 0n);
  assert.equal(res.value.sumOut, 0n);
  assert.match(res.out.join("\n"), /no transfers in window/);
});

test("reportToken — renders a row per transfer and returns the totals", async () => {
  const logs = [
    transferLog({ dir: "IN", from: OTHER, to: WALLET, value: 0x10n }),
    transferLog({ dir: "OUT", from: WALLET, to: OTHER, value: 0x04n }),
  ];
  const res = await captureConsole(() =>
    reportToken(metaProvider(), TOKEN, WALLET, 1, 100, async () => logs),
  );
  assert.equal(res.value.sumIn, 16n);
  assert.equal(res.value.sumOut, 4n);
  const text = res.out.join("\n");
  assert.match(text, /DIR\s+BLOCK/, "the table header precedes the rows");
  assert.equal(
    res.out.filter((l) => /^(IN|OUT)\s/.test(l)).length,
    2,
    "one row per transfer",
  );
});
