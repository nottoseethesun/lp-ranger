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

describe("buildRebalanceOpts — per-token slippage source", () => {
  it("threads slippagePctToken0 through when set on the position", () => {
    const deps = makeDeps((k) =>
      k === "slippagePctToken0" ? 1.25 : undefined,
    );
    const opts = buildRebalanceOpts(deps, {});
    assert.strictEqual(opts.slippagePctToken0, 1.25);
  });

  it("threads slippagePctToken1 through when set on the position", () => {
    const deps = makeDeps((k) => (k === "slippagePctToken1" ? 3.5 : undefined));
    const opts = buildRebalanceOpts(deps, {});
    assert.strictEqual(opts.slippagePctToken1, 3.5);
  });

  it("threads both when both are set", () => {
    const deps = makeDeps((k) => {
      if (k === "slippagePctToken0") return 2;
      if (k === "slippagePctToken1") return 0.5;
      return undefined;
    });
    const opts = buildRebalanceOpts(deps, {});
    assert.strictEqual(opts.slippagePctToken0, 2);
    assert.strictEqual(opts.slippagePctToken1, 0.5);
  });

  it("omits both when unset (legacy single-slippage path)", () => {
    /*- Regression guard: when neither per-token field is set, the opts
     *  MUST NOT carry either key.  The presence of either key is what
     *  the resolver uses to detect opt-in.  A stray `undefined` value
     *  wouldn't switch the mode (isFinite check) but would still make
     *  the opts uglier. */
    const deps = makeDeps(() => undefined);
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(!("slippagePctToken0" in opts));
    assert.ok(!("slippagePctToken1" in opts));
  });

  it("omits per-token fields when null (No Override was clicked)", () => {
    const deps = makeDeps(() => null);
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(!("slippagePctToken0" in opts));
    assert.ok(!("slippagePctToken1" in opts));
  });

  it("legacy slippagePct still flows through untouched", () => {
    /*- Whether or not per-token overrides are set, opts.slippagePct
     *  should carry the config value.  The slippage-resolver picks
     *  between them at swap time. */
    const deps = makeDeps((k) => {
      if (k === "slippagePct") return 2.5;
      if (k === "slippagePctToken0") return 1;
      return undefined;
    });
    const opts = buildRebalanceOpts(deps, {});
    assert.strictEqual(opts.slippagePct, 2.5);
    assert.strictEqual(opts.slippagePctToken0, 1);
  });
});

describe("buildRebalanceOpts — fullRangeRebalanceEnabled source", () => {
  it("includes fullRangeRebalanceEnabled=true when config says true", () => {
    /*- Full-Range checkbox is checked; the rebalancer will mint at
     *  MIN_TICK/MAX_TICK via rangeMath.fullRange() regardless of any
     *  saved Price Range Extension. */
    const deps = makeDeps((k) =>
      k === "fullRangeRebalanceEnabled" ? true : undefined,
    );
    const opts = buildRebalanceOpts(deps, {});
    assert.strictEqual(opts.fullRangeRebalanceEnabled, true);
  });

  it("omits fullRangeRebalanceEnabled when config is false", () => {
    /*- Explicit false → do not thread through opts at all (rebalancer
     *  reads absence as false).  Keeps the log line and destructure
     *  simple. */
    const deps = makeDeps((k) =>
      k === "fullRangeRebalanceEnabled" ? false : undefined,
    );
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(!("fullRangeRebalanceEnabled" in opts));
  });

  it("omits fullRangeRebalanceEnabled when config is undefined", () => {
    /*- Unset (never touched by user) → same as false. */
    const deps = makeDeps(() => undefined);
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(!("fullRangeRebalanceEnabled" in opts));
  });

  it("only accepts strict boolean true (regression guard on truthy coercion)", () => {
    /*- Non-boolean truthy values like "true" or 1 must NOT enable
     *  full-range — safety measure so a stray string in bot-config.json
     *  can't accidentally force full-range rebalances. */
    const strings = ["true", "yes", "1"];
    for (const s of strings) {
      const deps = makeDeps((k) =>
        k === "fullRangeRebalanceEnabled" ? s : undefined,
      );
      const opts = buildRebalanceOpts(deps, {});
      assert.ok(
        !("fullRangeRebalanceEnabled" in opts),
        `truthy non-boolean "${s}" must not enable full-range`,
      );
    }
  });

  it("full-range and Price Range Extension can be set simultaneously (both flow through)", () => {
    /*- The rebalancer's precedence logic (fullRange wins over crw)
     *  lives in _computeRange, not here.  buildRebalanceOpts's job is
     *  just to plumb both through — leave the arbitration to the
     *  rebalancer. */
    const deps = makeDeps((k) => {
      if (k === "fullRangeRebalanceEnabled") return true;
      if (k === "rebalanceRangeWidthPct") return 25;
      return undefined;
    });
    const opts = buildRebalanceOpts(deps, {});
    assert.strictEqual(opts.fullRangeRebalanceEnabled, true);
    assert.strictEqual(opts.customRangeWidthPct, 25);
  });
});
