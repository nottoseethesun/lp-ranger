"use strict";

/**
 * @file test/alerts-per-position.test.js
 * @description Tests the per-position dispatch in
 * public/dashboard-alerts.js :: showPerPositionAlerts() and
 * public/dashboard-post-rebalance-modal.js :: showPostRebalanceWarnings().
 *
 * Bug history: the "Rebalance Failed" / "Rebalance Paused" /
 * "Position Recovered" / "Range Width Adjusted" / "Residual Above
 * Threshold" modals all labeled their body via _posContextHtml(), which
 * read posStore.getActive() — the currently-VIEWED tab, NOT the
 * position the server event was about. A failure on position A while
 * viewing position B would show a dialog labeled "Position B". The fix
 * walks `_allPositionStates`, fires one modal per position whose
 * state matches the trigger, and derives the label from each
 * iterated key+state.
 *
 * These tests mirror the dispatch + dedup + label-derivation logic
 * rather than loading the real modules (the real ones pull DOM +
 * ES-module deps that node:test can't load).
 */

const { describe, it } = require("node:test");
const assert = require("assert");

/*- Mirror of the key-indexed dispatch + dedup pattern. We record every
 *  (title, key, body) triple the real module would pass to _createModal
 *  so assertions can verify WHICH positions got surfaced and with what
 *  label. Labels are derived from the iterated key+state, not from any
 *  external "active position" notion. */
function labelFor(key, st) {
  const tokenId = key.split("-").pop();
  const fee = st.activePosition?.fee;
  const pair =
    (st.activePosition?.token0Symbol || "?") +
    "/" +
    (st.activePosition?.token1Symbol || "?");
  return `${pair} #${tokenId}${fee ? " " + (fee / 10000).toFixed(2) + "%" : ""}`;
}

function clearStale(allStates, errShown, recShown, rrShown) {
  for (const key of Array.from(errShown)) {
    if (!allStates[key]?.rebalancePaused) errShown.delete(key);
  }
  for (const key of Array.from(recShown)) {
    if (!(allStates[key]?.oorRecoveredMin > 0)) recShown.delete(key);
  }
  for (const key of Array.from(rrShown)) {
    if (!allStates[key]?.rangeRounded) rrShown.delete(key);
  }
}

function dispatchOne(key, st, sets, fired) {
  const { errShown, recShown, rrShown, rwShownAt } = sets;
  if (st.oorRecoveredMin > 0 && !st.rebalancePaused && !recShown.has(key)) {
    fired.push({ kind: "recovery", key, label: labelFor(key, st) });
    recShown.add(key);
  }
  if (st.rebalancePaused && !errShown.has(key)) {
    fired.push({
      kind: "error",
      key,
      label: labelFor(key, st),
      message: st.rebalanceError,
    });
    errShown.add(key);
  }
  const rrNew = st.rangeRounded && !rrShown.has(key);
  const rwAt = st.residualWarning?.at || null;
  const rwNew = st.residualWarning && rwAt !== rwShownAt.get(key);
  if (!rrNew && !rwNew) return;
  fired.push({
    kind: "postRebalance",
    key,
    label: labelFor(key, st),
    rrNew,
    rwNew,
  });
  if (rrNew) rrShown.add(key);
  if (rwNew) rwShownAt.set(key, rwAt);
}

function runDispatch(allStates, errShown, recShown, rrShown, rwShownAt) {
  const fired = [];
  clearStale(allStates, errShown, recShown, rrShown);
  const sets = { errShown, recShown, rrShown, rwShownAt };
  for (const [key, st] of Object.entries(allStates)) {
    dispatchOne(key, st, sets, fired);
  }
  return fired;
}

const KEY_A = "pulsechain-0xwalletaaaa-0xcontract-71544";
const KEY_B = "pulsechain-0xwalletaaaa-0xcontract-159045";
const KEY_C = "pulsechain-0xwalletaaaa-0xcontract-159049";

describe("showPerPositionAlerts — per-position dispatch", () => {
  it("labels a paused-position modal with the paused position, not the viewed tab", () => {
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
    const fired = runDispatch(
      states,
      new Set(),
      new Set(),
      new Set(),
      new Map(),
    );
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].kind, "error");
    assert.strictEqual(fired[0].key, KEY_B);
    assert.ok(
      fired[0].label.includes("#159045"),
      "dialog must name the paused position #159045, not #71544",
    );
    assert.ok(fired[0].label.includes("eHEX"));
  });

  it("labels a recovery modal with the recovered position, not the viewed tab", () => {
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
    const fired = runDispatch(
      states,
      new Set(),
      new Set(),
      new Set(),
      new Map(),
    );
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].kind, "recovery");
    assert.strictEqual(fired[0].key, KEY_B);
    assert.ok(
      fired[0].label.includes("#159045"),
      "dialog must name the recovered position #159045, not #71544",
    );
    assert.ok(fired[0].label.includes("eHEX"));
  });

  it("fires one modal per concurrently-paused position with distinct labels", () => {
    const states = {
      [KEY_A]: {
        rebalancePaused: true,
        rebalanceError: "insufficient gas",
        activePosition: {
          token0Symbol: "HEX",
          token1Symbol: "WPLS",
          fee: 3000,
        },
      },
      [KEY_B]: {
        rebalancePaused: true,
        rebalanceError: "liquidity is too thin",
        activePosition: {
          token0Symbol: "eHEX",
          token1Symbol: "HEX",
          fee: 10000,
        },
      },
    };
    const fired = runDispatch(
      states,
      new Set(),
      new Set(),
      new Set(),
      new Map(),
    );
    assert.strictEqual(fired.length, 2);
    const keys = fired.map((f) => f.key).sort();
    assert.deepStrictEqual(keys, [KEY_A, KEY_B].sort());
    assert.ok(fired.find((f) => f.key === KEY_A).label.includes("#71544"));
    assert.ok(fired.find((f) => f.key === KEY_B).label.includes("#159045"));
  });

  it("does not re-fire the error modal on the same key until pause clears", () => {
    const states = {
      [KEY_B]: {
        rebalancePaused: true,
        rebalanceError: "x",
        activePosition: {},
      },
    };
    const errShown = new Set();
    const first = runDispatch(
      states,
      errShown,
      new Set(),
      new Set(),
      new Map(),
    );
    assert.strictEqual(first.length, 1);
    const second = runDispatch(
      states,
      errShown,
      new Set(),
      new Set(),
      new Map(),
    );
    assert.strictEqual(second.length, 0, "dedup within same pause");
  });

  it("re-fires on a subsequent pause of the same key after recovery", () => {
    const errShown = new Set();
    const rec = new Set();
    /*- First: paused. */
    runDispatch(
      { [KEY_B]: { rebalancePaused: true, activePosition: {} } },
      errShown,
      rec,
      new Set(),
      new Map(),
    );
    /*- Pause clears on server. */
    runDispatch(
      { [KEY_B]: { rebalancePaused: false, activePosition: {} } },
      errShown,
      rec,
      new Set(),
      new Map(),
    );
    assert.strictEqual(errShown.has(KEY_B), false, "dedup cleared on unpause");
    /*- Re-pause — must fire again. */
    const fired = runDispatch(
      { [KEY_B]: { rebalancePaused: true, activePosition: {} } },
      errShown,
      rec,
      new Set(),
      new Map(),
    );
    assert.strictEqual(fired.length, 1);
  });

  it("suppresses recovery modal while paused, fires it after unpause", () => {
    const rec = new Set();
    const paused = runDispatch(
      {
        [KEY_B]: {
          rebalancePaused: true,
          oorRecoveredMin: 15,
          activePosition: {},
        },
      },
      new Set(),
      rec,
      new Set(),
      new Map(),
    );
    assert.ok(
      paused.every((f) => f.kind !== "recovery"),
      "recovery must not fire while paused",
    );
    const recovered = runDispatch(
      {
        [KEY_B]: {
          rebalancePaused: false,
          oorRecoveredMin: 15,
          activePosition: {},
        },
      },
      new Set(),
      rec,
      new Set(),
      new Map(),
    );
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].kind, "recovery");
    assert.strictEqual(recovered[0].key, KEY_B);
  });

  it("fires rangeRounded warning once per rebalance per position", () => {
    const rrShown = new Set();
    const rwShownAt = new Map();
    const first = runDispatch(
      {
        [KEY_B]: {
          rangeRounded: { requested: 10, effective: 10.5 },
          activePosition: {},
        },
      },
      new Set(),
      new Set(),
      rrShown,
      rwShownAt,
    );
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].key, KEY_B);
    /*- Same rangeRounded still present → no re-fire. */
    const second = runDispatch(
      {
        [KEY_B]: {
          rangeRounded: { requested: 10, effective: 10.5 },
          activePosition: {},
        },
      },
      new Set(),
      new Set(),
      rrShown,
      rwShownAt,
    );
    assert.strictEqual(second.length, 0);
    /*- Server clears rangeRounded after 5s, then a new rebalance sets it again. */
    runDispatch(
      { [KEY_B]: { activePosition: {} } },
      new Set(),
      new Set(),
      rrShown,
      rwShownAt,
    );
    const third = runDispatch(
      {
        [KEY_B]: {
          rangeRounded: { requested: 10, effective: 10.5 },
          activePosition: {},
        },
      },
      new Set(),
      new Set(),
      rrShown,
      rwShownAt,
    );
    assert.strictEqual(third.length, 1, "new rangeRounded must re-fire");
  });

  it("residualWarning dedup uses `at` — new `at` re-fires on same key", () => {
    const rwShownAt = new Map();
    const first = runDispatch(
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
      new Set(),
      new Set(),
      new Set(),
      rwShownAt,
    );
    assert.strictEqual(first.length, 1);
    /*- Same timestamp → no re-fire. */
    const second = runDispatch(
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
      new Set(),
      new Set(),
      new Set(),
      rwShownAt,
    );
    assert.strictEqual(second.length, 0);
    /*- New `at` → re-fire. */
    const third = runDispatch(
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
      new Set(),
      new Set(),
      new Set(),
      rwShownAt,
    );
    assert.strictEqual(third.length, 1);
  });
});
