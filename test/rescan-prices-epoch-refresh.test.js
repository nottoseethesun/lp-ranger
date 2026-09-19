/**
 * @file test/rescan-prices-epoch-refresh.test.js
 * @description The opt-in half of Re-scan Prices — re-pricing the
 *   Per-Day P&L table.
 *
 *   The failure this file exists for is the quiet one. Every stage of
 *   the request can work — the checkbox ticks, the flag travels, the
 *   rebuild is forced, each NFT's history is read again — and the table
 *   can still come back byte-identical, because the stage that decides
 *   whether to *fetch* a price sees one already on the record and keeps
 *   it. The operator gets a success message and the bad figure they
 *   asked to replace. Nothing logs, nothing throws.
 *
 *   So the decision is driven directly rather than inferred from the
 *   request completing.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  _needsPriceFill,
  _needsExitFromChain,
} = require("../src/position-history");
const { requestPriceRevalue } = require("../src/server-rescan-prices");

/** A period with both ends dated and both ends already priced. */
function pricedRecord() {
  return {
    mintDate: "2026-03-15T10:00:00Z",
    closeDate: "2026-03-16T10:00:00Z",
    token0UsdPriceAtOpen: 0.00184,
    token0UsdPriceAtClose: 0.00191,
  };
}

describe("_needsPriceFill — the stage that decides whether to re-read", () => {
  it("does nothing for an already-priced period when not refreshing", () => {
    /*-
     *  The ordinary path, and the reason the refresh flag has to reach
     *  this far: left alone, this is a no-op.
     */
    const r = _needsPriceFill(pricedRecord(), false);
    assert.deepEqual(r, { needOpen: false, needClose: false });
  });

  it("re-reads the same period when refreshing", () => {
    /*-
     *  Without this, the whole opt-in does nothing: the request runs,
     *  reports success, and leaves the suspect price exactly where it
     *  was. A stored price is precisely what the operator is replacing,
     *  so it cannot also be the reason not to fetch.
     */
    const r = _needsPriceFill(pricedRecord(), true);
    assert.deepEqual(r, { needOpen: true, needClose: true });
  });

  it("still fills a missing price when not refreshing", () => {
    /*-
     *  The refresh flag must not be the only route to a fetch, or an
     *  ordinary scan would stop filling gaps.
     */
    const rec = { ...pricedRecord(), token0UsdPriceAtOpen: null };
    const r = _needsPriceFill(rec, false);
    assert.equal(r.needOpen, true);
    assert.equal(r.needClose, false, "the priced end stays untouched");
  });

  it("asks for nothing at an end it has no date for", () => {
    /*-
     *  A refresh cannot conjure a moment to price against. An open
     *  period has no close date, and asking anyway would send a NaN
     *  timestamp to the price source.
     */
    const rec = { ...pricedRecord(), closeDate: null };
    assert.equal(_needsPriceFill(rec, true).needClose, false);
    assert.equal(_needsPriceFill(rec, true).needOpen, true);
  });

  it("treats an absent date the same as a null one", () => {
    const r = _needsPriceFill({ token0UsdPriceAtOpen: 1 }, true);
    assert.deepEqual(r, { needOpen: false, needClose: false });
  });
});

describe("_needsExitFromChain — the largest term in a row", () => {
  /*-
   *  The exit value is the same trap as the prices above, one layer
   *  down. For an NFT the bot rebalanced itself, the rebalance log has
   *  already supplied a figure, so the ordinary gate is false and the
   *  recorded dollars stand.
   *
   *  Leaving it at that under a re-value would be worse than doing
   *  nothing: `priceChangePnl` is `exitValue − entryValue − fees`, and
   *  entry and fees ARE re-priced. The row would come back corrected in
   *  two terms and stale in the one that dominates it.
   */
  const logged = () => ({
    exitValueUsd: 295.4,
    token0UsdPriceAtClose: 0.00191,
  });

  it("leaves a logged exit value alone when not refreshing", () => {
    assert.equal(_needsExitFromChain(logged(), false), false);
  });

  it("re-derives that same value when refreshing", () => {
    assert.equal(_needsExitFromChain(logged(), true), true);
  });

  it("still reads a missing exit value off the chain", () => {
    const r = { ...logged(), exitValueUsd: null };
    assert.equal(_needsExitFromChain(r, false), true);
  });

  it("treats a recorded zero as no figure at all", () => {
    /*-
     *  A zero exit value is what an unreadable close leaves behind, not
     *  a position that exited worthless.
     */
    const r = { ...logged(), exitValueUsd: 0 };
    assert.equal(_needsExitFromChain(r, false), true);
  });

  it("asks for nothing without a close price to value it at", () => {
    /*-
     *  The chain gives amounts; turning them into dollars needs the
     *  close price. Without one there is nothing to compute.
     */
    const r = { exitValueUsd: null, token0UsdPriceAtClose: null };
    assert.equal(_needsExitFromChain(r, true), false);
  });
});

describe("requestPriceRevalue — the table is opt-in", () => {
  it("leaves the epoch rebuild alone by default", () => {
    /*-
     *  The expensive half. A plain Re-scan Prices rebuilds a handful of
     *  stored figures; this one re-reads every NFT in the chain, so it
     *  must never be what an unticked box asks for.
     */
    const st = {};
    requestPriceRevalue(st);
    assert.equal(st._needsPriceRevalue, true);
    assert.equal(st.lifetimeScanComplete, false);
    assert.equal(st._needsEpochPriceRevalue, undefined);
  });

  it("asks for it when the caller opts in", () => {
    const st = {};
    requestPriceRevalue(st, true);
    assert.equal(st._needsEpochPriceRevalue, true);
    assert.equal(st._needsPriceRevalue, true, "the narrow half still runs");
  });

  it("does not opt in on a value that merely looks true", () => {
    /*-
     *  The flag arrives from a JSON body, where a checkbox can reach the
     *  server as the string "true" or as 1. Only a real boolean should
     *  commit the operator to minutes of chain reads.
     */
    for (const v of ["true", 1, "on", {}]) {
      const st = {};
      requestPriceRevalue(st, v);
      assert.equal(
        st._needsEpochPriceRevalue,
        undefined,
        `opted in on ${JSON.stringify(v)}`,
      );
    }
  });
});
