/**
 * @file test/bot-cycle-opts.test.js
 * @description Tests for `buildRebalanceOpts` in `src/bot-cycle-opts.js`.
 *
 * Focus: the persistent per-position range-width override.  The seam
 * moved on 2026-07-11 (per the "Migrate Rebalance UI dialog into Bot
 * Settings" plan) from `state.customRangeWidthPct` (one-shot,
 * stamped by /api/rebalance body-parsing, cleared after use) to
 * `deps._getConfig("rebalanceRangeWidthPct")` (persistent,
 * per-position, read every rebalance).  These tests lock in the new
 * source of the value so a future refactor doesn't regress it.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildRebalanceOpts } = require("../src/bot-cycle-opts");

/*- Minimal deps: only the fields buildRebalanceOpts actually reads.
 *  `state` is passed through (kept in the signature for callers that
 *  still hand it in) but no longer read for range-width. */
function makeDeps(getConfig) {
  return {
    position: {
      token0: "0xA000000000000000000000000000000000000001",
      token1: "0xB000000000000000000000000000000000000002",
      fee: 3000,
      tickLower: -100,
      tickUpper: 100,
    },
    _getConfig: getConfig,
  };
}

describe("buildRebalanceOpts — rebalanceRangeWidthPct source", () => {
  it("includes customRangeWidthPct when _getConfig returns a positive number", () => {
    /*- Bot Settings has a saved override; the rebalancer will use
     *  exactly this width and log "using saved override" at Step 4. */
    const deps = makeDeps((k) =>
      k === "rebalanceRangeWidthPct" ? 7.5 : undefined,
    );
    const opts = buildRebalanceOpts(deps, {});
    assert.equal(opts.customRangeWidthPct, 7.5);
  });

  it("omits customRangeWidthPct when _getConfig returns undefined", () => {
    /*- No override saved.  Rebalancer falls back to
     *  rangeMath.preserveRange() and logs "preserving tick spread". */
    const deps = makeDeps(() => undefined);
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(
      !("customRangeWidthPct" in opts),
      "omitted, not present with an undefined value",
    );
  });

  it("omits customRangeWidthPct when _getConfig returns null", () => {
    /*- The No Override button on the Bot Settings Range Width row
     *  POSTs null to clear the config; the null-sweep in
     *  src/server-routes.js POST /api/config deletes the key from disk
     *  so on the next read _getConfig returns undefined.  If it ever
     *  returns null (e.g., before the null-sweep runs), the truthy
     *  check still omits the key. */
    const deps = makeDeps(() => null);
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(!("customRangeWidthPct" in opts));
  });

  it("omits customRangeWidthPct when _getConfig returns 0", () => {
    /*- 0 is not a legitimate range width (min is 0.1%).  Truthy check
     *  correctly rejects it so the rebalancer falls back to
     *  preserveRange(). */
    const deps = makeDeps(() => 0);
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(!("customRangeWidthPct" in opts));
  });

  it("ignores the state argument (the one-shot code path is dead)", () => {
    /*- Regression guard: buildRebalanceOpts no longer reads
     *  state.customRangeWidthPct.  Even if a stale caller stamps it on
     *  state (e.g., a partial-deploy sequence), the opts must derive
     *  from config only. */
    const deps = makeDeps(() => undefined);
    const staleState = { customRangeWidthPct: 999 };
    const opts = buildRebalanceOpts(deps, staleState);
    assert.ok(
      !("customRangeWidthPct" in opts),
      "state.customRangeWidthPct must not leak into opts anymore",
    );
  });

  it("preserves the other opts fields (slippage, offset, gasFeePct, symbols)", () => {
    /*- Sanity check: the seam refactor didn't disturb any other
     *  option the rebalancer consumes. */
    const deps = makeDeps((k) => {
      if (k === "slippagePct") return 1.25;
      if (k === "offsetToken0Pct") return 60;
      if (k === "gasFeePct") return 0.5;
      if (k === "approvalMultiple") return 10;
      return undefined;
    });
    const opts = buildRebalanceOpts(deps, {});
    assert.equal(opts.slippagePct, 1.25);
    assert.equal(opts.offsetToken0Pct, 60);
    assert.equal(opts.approvalMultiple, 10);
    assert.equal(opts.gasFeePct, 0.5);
    assert.equal(opts.position, deps.position);
  });
});
