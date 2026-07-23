"use strict";

/**
 * @file test/alerts-per-position.test.js
 * @description Tests the per-position dispatch decisions extracted
 *   from `showPerPositionAlerts` in `public/dashboard-alerts.js` and
 *   `showPostRebalanceWarnings` in
 *   `public/dashboard-post-rebalance-modal.js`.  The prior file
 *   mirrored the full dispatch + dedup + label derivation.  Extracts
 *   let the tests drive the real modules directly under jsdom.
 *
 *   Exports under test:
 *     - `_computeCoreAlertDispatch(allStates, dedup)` — dashboard-alerts
 *     - `_computePostRebalanceDispatch(allStates, dedup)` — post-rebalance-modal
 *
 *   Bug history: the "Rebalance Failed" / "Rebalance Paused" /
 *   "Position Recovered" / "Range Width Adjusted" / "Residual Above
 *   Threshold" modals all labeled their body via `_posContextHtml`,
 *   which read `posStore.getActive()` — the currently-VIEWED tab, NOT
 *   the position the server event was about.  A failure on position
 *   A while viewing position B would show a dialog labeled "Position
 *   B".  The fix walks `_allPositionStates`, fires one modal per
 *   position whose state matches the trigger, and derives the label
 *   from each iterated key+state — the dispatch tests here pin that
 *   each fired alert carries the correct KEY, not the viewed tab.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let alerts;
let postReb;

before(async () => {
  alerts = await import("../public/dashboard-alerts.js");
  postReb = await import("../public/dashboard-post-rebalance-modal.js");
});

function _emptyCoreDedup() {
  return {
    recShown: new Set(),
    errShown: new Set(),
    compoundErrShown: new Set(),
    catastrophicShown: new Set(),
  };
}
function _emptyPostRebDedup() {
  return { rrShown: new Set(), rwShownAt: new Map() };
}

const KEY_A = "pulsechain-0xwalletaaaa-0xcontract-71544";
const KEY_B = "pulsechain-0xwalletaaaa-0xcontract-159045";
const KEY_C = "pulsechain-0xwalletaaaa-0xcontract-159049";

// ── Core dispatch: per-position labeling correctness ────────────────────

describe("_computeCoreAlertDispatch — per-position dispatch (viewed-tab bug)", () => {
  it(
    "paused position surfaces alert keyed by the paused position, " +
      "not the viewed tab",
    () => {
      const states = {
        [KEY_A]: {
          rebalancePaused: false,
          activePosition: {
            token0Symbol: "HEX",
            token1Symbol: "WPLS",
            fee: 3000,
          },
        },
        [KEY_B]: {
          rebalancePaused: true,
          rebalanceError: "Price moved during rebalance 3 times in a row.",
          activePosition: {
            token0Symbol: "eHEX",
            token1Symbol: "HEX",
            fee: 10000,
          },
        },
      };
      const fired = alerts._computeCoreAlertDispatch(states, _emptyCoreDedup());
      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0].kind, "error");
      assert.strictEqual(
        fired[0].key,
        KEY_B,
        "alert must be keyed to the paused position, not the viewed tab",
      );
      assert.strictEqual(fired[0].message, states[KEY_B].rebalanceError);
    },
  );

  it("recovery surfaces alert keyed by the recovered position, not the viewed tab", () => {
    const states = {
      [KEY_A]: {
        rebalancePaused: false,
        activePosition: {
          token0Symbol: "HEX",
          token1Symbol: "WPLS",
          fee: 3000,
        },
      },
      [KEY_B]: {
        oorRecoveredMin: 15,
        rebalancePaused: false,
        activePosition: {
          token0Symbol: "eHEX",
          token1Symbol: "HEX",
          fee: 10000,
        },
      },
    };
    const fired = alerts._computeCoreAlertDispatch(states, _emptyCoreDedup());
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].kind, "recovery");
    assert.strictEqual(fired[0].key, KEY_B);
  });

  it("fires one alert per concurrently-paused position with distinct keys", () => {
    const states = {
      [KEY_A]: {
        rebalancePaused: true,
        rebalanceError: "insufficient gas",
        activePosition: {},
      },
      [KEY_B]: {
        rebalancePaused: true,
        rebalanceError: "liquidity is too thin",
        activePosition: {},
      },
    };
    const fired = alerts._computeCoreAlertDispatch(states, _emptyCoreDedup());
    const errors = fired.filter((f) => f.kind === "error");
    assert.strictEqual(errors.length, 2);
    const keys = errors.map((e) => e.key).sort();
    assert.deepStrictEqual(keys, [KEY_A, KEY_B].sort());
  });

  it("dedup blocks a second dispatch on the same key (already shown)", () => {
    const states = {
      [KEY_B]: {
        rebalancePaused: true,
        rebalanceError: "boom",
        activePosition: {},
      },
    };
    const dedup = _emptyCoreDedup();
    dedup.errShown.add(KEY_B);
    const fired = alerts._computeCoreAlertDispatch(states, dedup);
    assert.strictEqual(fired.length, 0);
  });

  it("recovery does NOT fire while the position is still paused", () => {
    const states = {
      [KEY_B]: {
        rebalancePaused: true,
        oorRecoveredMin: 15,
        rebalanceError: "boom",
        activePosition: {},
      },
    };
    const fired = alerts._computeCoreAlertDispatch(states, _emptyCoreDedup());
    assert.ok(fired.every((f) => f.kind !== "recovery"));
  });

  it("compound error and catastrophic errors surface independently", () => {
    const states = {
      [KEY_A]: {
        compoundError: "compound gas failure",
        activePosition: {},
      },
      [KEY_B]: {
        _catastrophicScanError: { message: "scan aborted" },
        activePosition: {},
      },
    };
    const fired = alerts._computeCoreAlertDispatch(states, _emptyCoreDedup());
    const kinds = fired.map((f) => f.kind).sort();
    assert.deepStrictEqual(kinds, ["catastrophic", "compoundError"]);
  });
});

// ── Post-rebalance dispatch: rangeRounded + residualWarning ────────────

describe("_computePostRebalanceDispatch — rangeRounded + residualWarning", () => {
  it("fires rangeRounded warning once per rebalance per position", () => {
    const dedup = _emptyPostRebDedup();
    const states = {
      [KEY_B]: {
        rangeRounded: { requested: 10, effective: 10.5 },
        activePosition: {},
      },
    };
    const first = postReb._computePostRebalanceDispatch(states, dedup);
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].key, KEY_B);
    assert.strictEqual(first[0].rrNew, true);

    // Once dedup is updated, same state does not re-fire.
    dedup.rrShown.add(KEY_B);
    const second = postReb._computePostRebalanceDispatch(states, dedup);
    assert.strictEqual(second.length, 0);
  });

  it("residualWarning dedup uses `at` — new `at` re-fires on same key", () => {
    const dedup = _emptyPostRebDedup();
    const first = postReb._computePostRebalanceDispatch(
      {
        [KEY_C]: {
          residualWarning: {
            imbalanceUsd: 30,
            thresholdUsd: 1,
            iterations: 3,
            at: 1000,
          },
          activePosition: {},
        },
      },
      dedup,
    );
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].rwNew, true);

    // Caller records at=1000.
    dedup.rwShownAt.set(KEY_C, 1000);

    // Same at → no fire.
    const second = postReb._computePostRebalanceDispatch(
      {
        [KEY_C]: {
          residualWarning: {
            imbalanceUsd: 30,
            thresholdUsd: 1,
            iterations: 3,
            at: 1000,
          },
          activePosition: {},
        },
      },
      dedup,
    );
    assert.strictEqual(second.length, 0);

    // New at → re-fire.
    const third = postReb._computePostRebalanceDispatch(
      {
        [KEY_C]: {
          residualWarning: {
            imbalanceUsd: 40,
            thresholdUsd: 1,
            iterations: 3,
            at: 2000,
          },
          activePosition: {},
        },
      },
      dedup,
    );
    assert.strictEqual(third.length, 1);
    assert.strictEqual(third[0].rwNew, true);
  });

  it("empty states → nothing fired", () => {
    assert.deepStrictEqual(
      postReb._computePostRebalanceDispatch({}, _emptyPostRebDedup()),
      [],
    );
  });

  it("both rangeRounded and residualWarning present on same key → single postRebalance entry with both flags", () => {
    const states = {
      [KEY_B]: {
        rangeRounded: { requested: 10, effective: 10.5 },
        residualWarning: {
          imbalanceUsd: 30,
          thresholdUsd: 1,
          iterations: 3,
          at: 1000,
        },
        activePosition: {},
      },
    };
    const fired = postReb._computePostRebalanceDispatch(
      states,
      _emptyPostRebDedup(),
    );
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].rrNew, true);
    assert.strictEqual(fired[0].rwNew, true);
  });
});
