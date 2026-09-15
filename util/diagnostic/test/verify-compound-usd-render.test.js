/**
 * @file util/diagnostic/test/verify-compound-usd-render.test.js
 * @description
 * Tests for the console-emitting and log-scanning half of
 * `verify-compound-usd/index.js`.  The pure math lives in
 * `analysis.js` and is covered by `verify-compound-usd.test.js`; this
 * suite covers what that one deliberately cannot — the text the tool
 * actually prints, and the chunked `getLogs` scan.
 *
 * These assertions matter beyond coverage: the tool's whole job is to
 * tell an operator which input was wrong, so a mislabelled or
 * mis-scoped line is a real defect.  Two of them were caught this way
 * — sibling-NFT rows being reported as missing events, and a
 * reconciling row being wrongly blamed on prices.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { scanEvents, printHelp } = require("../verify-compound-usd");
const {
  renderPrices,
  renderEventRow,
  renderHypotheses,
  renderRecorded,
  renderEvents,
  renderConfigComparison,
} = require("../verify-compound-usd/render");
const { captureConsole, fakeProvider } = require("./_capture");

/** The real 2026-08-04 compound on NFT #162980. */
const EV = { raw0: 97870110000n, raw1: 192505560000n };
const TOK = { d0: 8, d1: 8, p0: 0.00209314, p1: 0.00111662 };
const POS = { d0: 8, d1: 8, sym0: "HEX", sym1: "eHEX" };

test("renderPrices — prints every source for both tokens", async () => {
  const px = { cascade: 0.002, moralis: 0.0021, gecko: 0.002, dex: 0.0019 };
  const { out } = await captureConsole(() => renderPrices(POS, px, px));
  const text = out.join("\n");
  assert.match(text, /HEX/);
  assert.match(text, /eHEX/);
  assert.match(text, /Moralis=/);
  assert.match(text, /GeckoTerminal=/);
  assert.match(text, /DexScreener=/);
});

test("renderPrices — a null Moralis reads as no API key, not $0", async () => {
  /*- Reporting an absent key as $0.00 would look like a price crash. */
  const px = { cascade: 0.002, moralis: null, gecko: 0.002, dex: 0.0019 };
  const { out } = await captureConsole(() => renderPrices(POS, px, px));
  const text = out.join("\n");
  assert.match(text, /\(no API key\)/);
  assert.doesNotMatch(text, /Moralis=\$0\.00/);
});

test("renderEventRow — renders amounts and the USD value", async () => {
  const { out } = await captureConsole(() =>
    renderEventRow(
      "2026-08-04 07:51:45 UTC",
      "compound",
      EV,
      POS,
      0.002,
      0.001,
    ),
  );
  assert.equal(out.length, 1);
  assert.match(out[0], /compound/);
  assert.match(out[0], /978\.7011/);
  assert.match(out[0], /1925\.0556/);
});

test("renderHypotheses — names an inflated price via the ratio", async () => {
  const { out } = await captureConsole(() => renderHypotheses(240.1, EV, TOK));
  const text = out.join("\n");
  assert.match(text, /reported/);
  assert.match(text, /recomputed @live/);
  assert.match(text, /implied price0/);
  assert.match(text, /implied price1/);
  assert.match(text, /uniform price scale/);
  /*- ~57x uniform scale is the signature of the real #162980 case. */
  assert.match(text, /5[0-9]\.\d\dx/);
});

test("renderHypotheses — says so when no shift explains it", async () => {
  const { out } = await captureConsole(() => renderHypotheses(240.1, EV, TOK));
  assert.match(out.join("\n"), /decimals shift/);
});

test("renderHypotheses — reports a shift when one reproduces", async () => {
  /*- Build a figure that IS a pure decimals error (d1 read as 6). */
  const wrong =
    (Number(EV.raw0) / 1e8) * TOK.p0 + (Number(EV.raw1) / 1e6) * TOK.p1;
  const { out } = await captureConsole(() => renderHypotheses(wrong, EV, TOK));
  assert.match(out.join("\n"), /decimals shift\s+d0=8 d1=6/);
});

test("renderRecorded — reconciling row does NOT blame prices", async () => {
  /*- A row that reconciles is internally consistent, and the tool
   *  compares against live prices, so any older row shows a ratio from
   *  market drift alone.  Blaming the prices there reports a defect for
   *  every row the tool successfully reconciles. */
  const rp0 = 0.0012263514880044137;
  const rp1 = 0.0004887169910048089;
  const row = {
    txHash: "0x269c",
    timestamp: "2026-07-18T04:08:36.454Z",
    amount0Deposited: "230243432799",
    amount1Deposited: "497326851435",
    usdValue: (230243432799 / 1e8) * rp0 + (497326851435 / 1e8) * rp1,
    price0: rp0,
    price1: rp1,
  };
  const ev = { raw0: 230243432799n, raw1: 497326851435n };
  const res = await captureConsole(() => renderRecorded(row, ev, TOK));
  const text = res.out.join("\n");
  assert.equal(res.value, true, "must report that the row reproduces");
  assert.match(text, /✓ match the chain's IncreaseLiquidity/);
  assert.match(text, /arithmetic was faithful/);
  assert.doesNotMatch(text, /PRICES were wrong/);
  assert.match(text, /live prices are TODAY's/);
});

test("renderRecorded — flags amounts that differ from the chain", async () => {
  const row = {
    txHash: "0xdead",
    amount0Deposited: "1",
    amount1Deposited: "2",
    usdValue: 5,
    price0: 0.002,
    price1: 0.001,
  };
  const res = await captureConsole(() => renderRecorded(row, EV, TOK));
  const text = res.out.join("\n");
  assert.match(text, /✗ DIFFER from chain/);
  assert.match(text, /stored 1\/2/);
  assert.equal(res.value, false);
});

test("renderRecorded — non-reconciling row points at decimals", async () => {
  /*- usdValue that the recorded prices cannot produce at chain decimals
   *  but CAN at a shifted pair. */
  const p0 = 0.002,
    p1 = 0.001;
  const stored = (Number(EV.raw0) / 1e7) * p0 + (Number(EV.raw1) / 1e8) * p1;
  const row = {
    txHash: "0xbeef",
    amount0Deposited: String(EV.raw0),
    amount1Deposited: String(EV.raw1),
    usdValue: stored,
    price0: p0,
    price1: p1,
  };
  const res = await captureConsole(() => renderRecorded(row, EV, TOK));
  const text = res.out.join("\n");
  assert.equal(res.value, false);
  assert.match(text, /DECIMALS the bot used differ/);
  assert.match(text, /decimals used ≈ d0=7 d1=8/);
});

test("renderConfigComparison — no rows when history is empty", async () => {
  const { out } = await captureConsole(() =>
    renderConfigComparison({ compoundHistory: [] }, [], TOK, "162980"),
  );
  assert.match(out.join("\n"), /No compoundHistory rows/);
});

test("renderConfigComparison — sibling rows get a rerun command", async () => {
  /*- A sibling-NFT row has no event in THIS NFT's scan, so reporting
   *  "no matching event" would read as an invented compound rather
   *  than as a row belonging to another NFT. */
  const cfg = {
    compoundHistory: [
      { tokenId: "162237", usdValue: 5.25, txHash: "0xa" },
      { tokenId: "162237", usdValue: 3.1, txHash: "0xb" },
    ],
  };
  const { out } = await captureConsole(() =>
    renderConfigComparison(cfg, [], TOK, "162980"),
  );
  const text = out.join("\n");
  assert.match(text, /belong to earlier NFTs/);
  assert.match(text, /--token-id 162237\s+\(2 rows\)/);
  assert.doesNotMatch(text, /no matching event/);
  assert.match(text, /No rows recorded against #162980 itself/);
});

test("renderConfigComparison — singular row count reads '1 row'", async () => {
  const cfg = {
    compoundHistory: [{ tokenId: "162237", usdValue: 5.25, txHash: "0xa" }],
  };
  const { out } = await captureConsole(() =>
    renderConfigComparison(cfg, [], TOK, "162980"),
  );
  assert.match(out.join("\n"), /\(1 row\)/);
});

test("renderConfigComparison — own row absent from window", async () => {
  const cfg = {
    compoundHistory: [{ tokenId: "162980", usdValue: 4.2, txHash: "0xzz" }],
  };
  const { out } = await captureConsole(() =>
    renderConfigComparison(cfg, [], TOK, "162980"),
  );
  const text = out.join("\n");
  assert.match(text, /no matching event in the scan window/);
  assert.match(text, /widen with --days/);
});

test("renderConfigComparison — matched row compared to chain", async () => {
  const row = {
    tokenId: "162980",
    txHash: "0xMATCH",
    amount0Deposited: String(EV.raw0),
    amount1Deposited: String(EV.raw1),
    usdValue: (Number(EV.raw0) / 1e8) * 0.002 + (Number(EV.raw1) / 1e8) * 0.001,
    price0: 0.002,
    price1: 0.001,
  };
  const events = [{ txHash: "0xMATCH", ev: EV }];
  const { out } = await captureConsole(() =>
    renderConfigComparison({ compoundHistory: [row] }, events, TOK, "162980"),
  );
  assert.match(out.join("\n"), /recorded usdValue/);
  assert.match(out.join("\n"), /reproduces the stored figure/);
});

test("renderEvents — labels mint/compound/collect in order", async () => {
  const provider = fakeProvider({ blockTs: 1_767_225_600 });
  const scan = {
    il: [
      { amount0: 1n, amount1: 1n, blockNumber: 100, txHash: "0xm" },
      { amount0: 2n, amount1: 2n, blockNumber: 300, txHash: "0xc" },
    ],
    dl: [],
    collect: [{ amount0: 3n, amount1: 3n, blockNumber: 200, txHash: "0xk" }],
    mintInWindow: true,
  };
  const res = await captureConsole(() =>
    renderEvents(provider, scan, POS, 0.002, 0.001),
  );
  const kinds = res.value.map((e) => e.kind);
  assert.deepEqual(kinds, ["mint", "collect", "compound"]);
  assert.match(res.out.join("\n"), /On-chain liquidity events/);
});

test("renderEvents — warns when the mint predates the window", async () => {
  const provider = fakeProvider({});
  const scan = {
    il: [{ amount0: 1n, amount1: 1n, blockNumber: 100, txHash: "0xa" }],
    dl: [],
    collect: [],
    mintInWindow: false,
  };
  const res = await captureConsole(() =>
    renderEvents(provider, scan, POS, 0.002, 0.001),
  );
  assert.match(res.out.join("\n"), /mint predates the window/);
  assert.equal(res.value[0].kind, "compound");
});

test("renderEvents — a failed getBlock still renders the row", async () => {
  const provider = {
    async getBlock() {
      throw new Error("rpc down");
    },
  };
  const scan = {
    il: [{ amount0: 1n, amount1: 1n, blockNumber: 100, txHash: "0xa" }],
    dl: [],
    collect: [],
    mintInWindow: true,
  };
  const res = await captureConsole(() =>
    renderEvents(provider, scan, POS, 0.002, 0.001),
  );
  assert.equal(res.value.length, 1);
  assert.match(res.out.join("\n"), /—/);
});

test("scanEvents — chunks window, parses each event type", async () => {
  /*- 25 000 blocks at CHUNK_SIZE 10 000 = 3 chunks × 4 topic filters. */
  const provider = fakeProvider({ logs: [] });
  const res = await scanEvents(provider, "162980", 1, 25_000);
  assert.equal(provider.calls.getLogs.length, 12);
  assert.deepEqual(res.il, []);
  assert.deepEqual(res.dl, []);
  assert.deepEqual(res.collect, []);
  assert.equal(res.mintInWindow, false);
});

test("scanEvents — a getLogs failure degrades, does not throw", async () => {
  const provider = fakeProvider({ getLogsError: new Error("boom") });
  const res = await captureConsole(() => scanEvents(provider, "1", 1, 10_000));
  assert.deepEqual(res.value.il, []);
  assert.match(res.err.join("\n"), /boom/);
});

test("printHelp — lists every option", async () => {
  const { out } = await captureConsole(() => printHelp());
  const text = out.join("\n");
  for (const flag of [
    "--token-id",
    "--usd",
    "--days",
    "--from-block",
    "--moralis-key",
    "--help",
  ]) {
    assert.ok(text.includes(flag), `help must document ${flag}`);
  }
});
