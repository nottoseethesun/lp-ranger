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
const { loadShippedDefaults } = require("../src/load-merged-defaults");

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
    /*- A null on disk (hand-edited config, or a key cleared by the
     *  null-sweep in src/server-routes.js POST /api/config before it
     *  was deleted) reads as "no override": the truthy check omits the
     *  key and the rebalancer falls back to preserveRange(). */
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
    /*- `buildRebalanceOpts` must derive from config only.  A stale
     *  caller can still stamp `customRangeWidthPct` on state — a
     *  partial deploy, say — and reading it would apply a width the
     *  user never saved. */
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
      if (k === "slippagePctToken1") return 1.25;
      if (k === "offsetToken0Pct") return 60;
      if (k === "gasFeePct") return 0.5;
      if (k === "approvalMultiple") return 10;
      return undefined;
    });
    const opts = buildRebalanceOpts(deps, {});
    assert.equal(opts.slippagePctToken1, 1.25);
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

  it("omits per-token fields when config holds null", () => {
    const deps = makeDeps(() => null);
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(!("slippagePctToken0" in opts));
    assert.ok(!("slippagePctToken1" in opts));
  });

  it("carries no single slippage figure at all", () => {
    /*- Slippage is two settings and nothing else. `opts.slippagePct`
     *  used to be a third — read from the position, passed into the
     *  rebalance opts, ignored by the rebalance swap and honoured by
     *  the compound one. A position could swap at two different
     *  slippages depending on which move it was making. */
    const deps = makeDeps((k) => {
      if (k === "slippagePct") return 2.5;
      if (k === "slippagePctToken0") return 1;
      return undefined;
    });
    const opts = buildRebalanceOpts(deps, {});
    assert.ok(!("slippagePct" in opts));
    assert.strictEqual(opts.slippagePctToken0, 1);
  });
});

describe("buildRebalanceOpts — the Range section's No Override toggle", () => {
  /*- The toggle gates all three Range settings at once.  These tests
   *  drive `buildRebalanceOpts` through its exact entry point rather
   *  than re-asserting `resolveRangeOverrideEnabled` (covered in
   *  test/range-override.test.js) — what matters here is that the
   *  resolved answer actually reaches the rebalancer's opts bag. */

  /*- The shipped centred offset, read the way the SUT reads it so this
   *  file holds no second literal. */
  const CENTERED_OFFSET = loadShippedDefaults(
    "bot-config-defaults.json",
  ).offsetToken0Pct;

  function makeRangeDeps(cfg) {
    return makeDeps((k) => cfg[k]);
  }

  it("withholds every Range setting when the toggle is on", () => {
    /*- Badge reads "Re-Use Existing Position Range".  The saved values
     *  are still on disk — the toggle never clears them — so the ONLY
     *  thing keeping them out of the rebalance is this gate. */
    const opts = buildRebalanceOpts(
      makeRangeDeps({
        rangeOverrideEnabled: false,
        rebalanceRangeWidthPct: 80,
        fullRangeRebalanceEnabled: true,
        offsetToken0Pct: 70,
      }),
      {},
    );
    assert.ok(
      !("customRangeWidthPct" in opts),
      "saved Price Range Extension must not reach the rebalancer",
    );
    assert.ok(
      !("fullRangeRebalanceEnabled" in opts),
      "saved Full-Range flag must not reach the rebalancer",
    );
    assert.equal(
      opts.offsetToken0Pct,
      CENTERED_OFFSET,
      "offset must be pinned to centred so preserveRange() re-centres",
    );
  });

  it("pins the offset to centred even when a skewed one is saved", () => {
    /*- The bug this closes: `_computeRange` passes the offset into BOTH
     *  branches, so before the toggle a saved non-centred offset shifted
     *  the range through preserveRange() even with no width override.
     *  "Re-use the existing range" has to mean exactly that. */
    const opts = buildRebalanceOpts(
      makeRangeDeps({ rangeOverrideEnabled: false, offsetToken0Pct: 0 }),
      {},
    );
    assert.equal(opts.offsetToken0Pct, CENTERED_OFFSET);
  });

  it("applies every Range setting when the toggle is off", () => {
    /*- Badge reads "Use Settings Below". */
    const opts = buildRebalanceOpts(
      makeRangeDeps({
        rangeOverrideEnabled: true,
        rebalanceRangeWidthPct: 12.5,
        fullRangeRebalanceEnabled: true,
        offsetToken0Pct: 70,
      }),
      {},
    );
    assert.equal(opts.customRangeWidthPct, 12.5);
    assert.equal(opts.fullRangeRebalanceEnabled, true);
    assert.equal(opts.offsetToken0Pct, 70);
  });

  it("a brand-new position gets No Override without any saved key", () => {
    /*- Nothing on the slot at all: the position is the first of its
     *  kind, so the bot must re-use its existing on-chain range. */
    const opts = buildRebalanceOpts(
      makeDeps(() => undefined),
      {},
    );
    assert.ok(!("customRangeWidthPct" in opts));
    assert.ok(!("fullRangeRebalanceEnabled" in opts));
    assert.equal(opts.offsetToken0Pct, CENTERED_OFFSET);
  });

  it("a slot saved before the toggle existed keeps applying its settings", () => {
    /*- Upgrade path.  `rangeOverrideEnabled` is absent because the key
     *  did not exist when this position was configured; the derive tier
     *  must keep the user's width in force rather than silently
     *  switching a live position to preserve-range. */
    const opts = buildRebalanceOpts(
      makeRangeDeps({ rebalanceRangeWidthPct: 80, offsetToken0Pct: 60 }),
      {},
    );
    assert.equal(opts.customRangeWidthPct, 80);
    assert.equal(opts.offsetToken0Pct, 60);
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
