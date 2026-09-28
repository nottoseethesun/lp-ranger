/**
 * @file util/test/reconcile-hodl-render.test.js
 * @description
 * Tests the presentation layer of `reconcile-hodl`.
 *
 * The report IS this tool's product: an operator reads the Δ line and
 * decides whether a HODL baseline is wrong and needs clearing. A figure
 * scaled by the wrong number of decimals, or a delta whose sign is
 * backwards, sends them to clear a baseline that was fine — or leaves a
 * broken one in place while the numbers look reassuring.
 *
 * Assertions therefore check the VALUES that reach the screen, not just
 * that some text was printed.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { captureConsole } = require("./_capture");
const render = require("../diagnostic/reconcile-hodl/render");

const SUMS = {
  ilSum0: 1_500_000_000n, // 15.0 at 8 decimals
  ilSum1: 2_000_000_000n, // 20.0
  dlSum0: 500_000_000n, // 5.0
  dlSum1: 250_000_000n, // 2.5
  colSum0: 700_000_000n, // 7.0
  colSum1: 400_000_000n, // 4.0
};

const DERIVED = {
  netPrincipal0: 1_000_000_000n, // 10.0
  netPrincipal1: 1_750_000_000n, // 17.5
  fees0: 200_000_000n, // 2.0
  fees1: 150_000_000n, // 1.5
};

/* ---------- number shaping ---------- */

test("toFloat — scales a raw BigInt by the token's decimals", () => {
  assert.equal(render.toFloat(1_500_000_000n, 8), 15);
  assert.equal(render.toFloat(1n, 8), 0.00000001);
});

test("toFloat — zero short-circuits to a plain zero", () => {
  assert.equal(render.toFloat(0n, 18), 0);
});

test("toFloat — pads values smaller than one whole unit", () => {
  /*- 123 at 8 decimals is 0.00000123, not 123.  Dropping the pad here
   *  would overstate a dust figure by eight orders of magnitude. */
  assert.equal(render.toFloat(123n, 8), 0.00000123);
});

test("fmtDelta — reports actual, cached and a signed difference", () => {
  const s = render.fmtDelta(1_500_000_000n, 12, 8);
  assert.match(s, /^15\.000000/);
  assert.match(s, /cached: 12\.000000/);
  assert.match(s, /Δ \+3\.000000/);
});

test("fmtDelta — a shortfall carries a leading minus", () => {
  assert.match(render.fmtDelta(1_000_000_000n, 12, 8), /Δ -2\.000000/);
});

test("fmtDelta — says so when there is no cached value to compare", () => {
  /*- An absent baseline must not read as a baseline of zero: one means
   *  "never recorded", the other means "recorded as nothing". */
  assert.match(render.fmtDelta(100n, undefined, 8), /cached: —/);
  assert.match(render.fmtDelta(100n, null, 8), /cached: —/);
  assert.match(render.fmtDelta(100n, NaN, 8), /cached: —/);
});

/* ---------- report blocks ---------- */

test("renderBanner — names the position under examination", async () => {
  const res = await captureConsole(() =>
    render.renderBanner("pulsechain-a-b-1"),
  );
  assert.match(res.out.join("\n"), /reconcile-hodl: pulsechain-a-b-1/);
});

test("renderTarget — prints the pool identity being filtered on", async () => {
  const res = await captureConsole(() =>
    render.renderTarget({ token0: "0xAAA", token1: "0xBBB", fee: 2500 }),
  );
  const text = res.out.join("\n");
  assert.match(text, /token0: 0xAAA/);
  assert.match(text, /token1: 0xBBB/);
  assert.match(text, /fee:\s+2500/);
});

test("renderTableHeader — labels every column of the per-NFT table", async () => {
  const res = await captureConsole(() => render.renderTableHeader());
  const text = res.out.join("\n");
  /*- Substring checks rather than built regexes: a RegExp assembled
   *  from a variable trips the security lint, and nothing here needs
   *  pattern matching. */
  for (const col of ["tokenId", "IL_count", "IL amount0", "DL_count"]) {
    assert.ok(text.includes(col), `column "${col}" must be labelled`);
  }
});

test("renderChainRow — shows scaled IL amounts and each event count", async () => {
  const ev = {
    ilEvents: [{}, {}],
    dlEvents: [{}],
    collectEvents: [{}, {}, {}],
  };
  const res = await captureConsole(() =>
    render.renderChainRow("162980", ev, { s0: 1_500_000_000n, s1: 0n }, 8, 8),
  );
  const row = res.out.join("");
  assert.match(row, /^162980/);
  assert.match(row, /15\.000000/, "IL amount0 scaled by decimals");
  assert.match(row, /\s2\s/, "IL event count");
  assert.match(row, /3\s*$/, "collect count closes the row");
});

test("renderChainRow — scales each side by its OWN decimals", async () => {
  /*- Pairs with mismatched decimals (18 vs 6) are the common case; one
   *  shared scale would make one column silently wrong. */
  const ev = { ilEvents: [{}], dlEvents: [], collectEvents: [] };
  const res = await captureConsole(() =>
    render.renderChainRow(
      "1",
      ev,
      { s0: 1_000_000_000_000_000_000n, s1: 2_000_000n },
      18,
      6,
    ),
  );
  const row = res.out.join("");
  assert.match(row, /1\.000000/);
  assert.match(row, /2\.000000/);
});

test("renderAggregates — prints all five Σ lines with scaled values", async () => {
  const res = await captureConsole(() =>
    render.renderAggregates(SUMS, DERIVED, 8, 8),
  );
  const text = res.out.join("\n");
  assert.match(text, /Σ IncreaseLiquidity\s+amount0: 15\.000000/);
  assert.match(text, /Σ DecreaseLiquidity\s+amount0: 5\.000000/);
  assert.match(text, /Σ Collect\s+amount0: 7\.000000/);
  assert.match(text, /Net principal \(IL−DL\): amount0 10\.000000/);
  assert.match(text, /Approx lifetime fees:\s+amount0 2\.000000/);
  assert.match(text, /amount1 1\.500000/);
});

test("renderReconciliation — compares on-chain Σ IL against the cache", async () => {
  const res = await captureConsole(() =>
    render.renderReconciliation(
      SUMS,
      { hodlAmount0: 15, hodlAmount1: 19 },
      8,
      8,
    ),
  );
  const text = res.out.join("\n");
  assert.match(text, /hodlAmount0:.*Δ \+0\.000000/, "in sync reads as zero Δ");
  assert.match(text, /hodlAmount1:.*Δ \+1\.000000/, "drift is surfaced");
});

test("renderReconciliation — an empty baseline renders as uncached", async () => {
  const res = await captureConsole(() =>
    render.renderReconciliation(SUMS, {}, 8, 8),
  );
  assert.equal(
    res.out.filter((l) => l.includes("cached: —")).length,
    2,
    "both sides report no cached value rather than implying zero",
  );
});

test("renderNotes — explains what a large Δ means and how to fix it", async () => {
  const res = await captureConsole(() => render.renderNotes());
  const text = res.out.join("\n");
  assert.match(text, /cache and chain disagree/);
  assert.match(text, /baseline cleared will rebuild it from chain/);
  assert.match(text, /Done\./, "the operator needs to know it finished");
});

test("renderReport — emits aggregates, reconciliation and notes together", async () => {
  const res = await captureConsole(() =>
    render.renderReport({
      sums: SUMS,
      derived: DERIVED,
      cachedHb: { hodlAmount0: 15, hodlAmount1: 20 },
      decimals0: 8,
      decimals1: 8,
    }),
  );
  const text = res.out.join("\n");
  assert.match(text, /Aggregates \(across full NFT chain\)/);
  assert.match(text, /HODL baseline reconciliation/);
  assert.match(text, /Notes: cached HODL is set once/);
  assert.match(text, /Done\./);
});
