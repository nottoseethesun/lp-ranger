"use strict";

/**
 * @file test/alerts-per-position-compound.test.js
 * @description Parity tests for the Compound-failure modal in
 * src/client/web/dashboard-alerts.js :: showPerPositionAlerts().  Rebalance and
 * compound failures are the two alert kinds users MUST see, so each
 * needs its own per-position label + dedup coverage.  Mirrors the
 * dispatch logic the way alerts-per-position.test.js does — real
 * modules pull DOM + ES-module deps that node:test cannot load.
 *
 * Split from alerts-per-position.test.js to stay under the 500-line
 * cap per feedback_never_compact_code.
 */

const { describe, it } = require("node:test");
const assert = require("assert");

function labelFor(key, st) {
  const tokenId = key.split("-").pop();
  const fee = st.activePosition?.fee;
  const pair =
    (st.activePosition?.token0Symbol || "?") +
    "/" +
    (st.activePosition?.token1Symbol || "?");
  return `${pair} #${tokenId}${fee ? " " + (fee / 10000).toFixed(2) + "%" : ""}`;
}

/*- Minimal mirror: only the branches the compound tests exercise
 *  (rebalancePaused and compoundError).  Full dispatch is covered by
 *  alerts-per-position.test.js. */
function runDispatch(allStates, errShown, compoundErrShown) {
  const fired = [];
  for (const key of Array.from(errShown)) {
    if (!allStates[key]?.rebalancePaused) errShown.delete(key);
  }
  for (const key of Array.from(compoundErrShown)) {
    if (!allStates[key]?.compoundError) compoundErrShown.delete(key);
  }
  for (const [key, st] of Object.entries(allStates)) {
    if (st.rebalancePaused && !errShown.has(key)) {
      fired.push({
        kind: "error",
        key,
        label: labelFor(key, st),
        message: st.rebalanceError,
      });
      errShown.add(key);
    }
    if (st.compoundError && !compoundErrShown.has(key)) {
      fired.push({
        kind: "compoundError",
        key,
        label: labelFor(key, st),
        message: st.compoundError,
      });
      compoundErrShown.add(key);
    }
  }
  return fired;
}

const KEY_A = "pulsechain-0xwalletaaaa-0xcontract-71544";
const KEY_B = "pulsechain-0xwalletaaaa-0xcontract-159045";

describe("showPerPositionAlerts — compound-error dispatch", () => {
  it("fires a compoundError modal labeled with the failing position", () => {
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
        compoundError: "collect reverted: STF",
        activePosition: {
          token0Symbol: "eHEX",
          token1Symbol: "HEX",
          fee: 10000,
        },
      },
    };
    const fired = runDispatch(states, new Set(), new Set());
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].kind, "compoundError");
    assert.strictEqual(fired[0].key, KEY_B);
    assert.ok(
      fired[0].label.includes("#159045"),
      "dialog must name the failing position #159045, not #71544",
    );
    assert.ok(fired[0].label.includes("eHEX"));
    assert.strictEqual(fired[0].message, "collect reverted: STF");
  });

  it("dedups compoundError modal until server clears the error", () => {
    const compoundErrShown = new Set();
    const states = {
      [KEY_B]: {
        compoundError: "nonce too low",
        activePosition: {},
      },
    };
    const first = runDispatch(states, new Set(), compoundErrShown);
    assert.strictEqual(first.length, 1);
    const second = runDispatch(states, new Set(), compoundErrShown);
    assert.strictEqual(second.length, 0, "dedup while error persists");
    /*- Server clears compoundError on next successful compound. */
    runDispatch(
      { [KEY_B]: { compoundError: null, activePosition: {} } },
      new Set(),
      compoundErrShown,
    );
    assert.strictEqual(
      compoundErrShown.has(KEY_B),
      false,
      "dedup cleared when compoundError clears",
    );
    /*- Subsequent compound failure must re-fire. */
    const third = runDispatch(
      { [KEY_B]: { compoundError: "again", activePosition: {} } },
      new Set(),
      compoundErrShown,
    );
    assert.strictEqual(third.length, 1);
  });

  it("fires separate modals for concurrent rebalance-pause and compound-error on different positions", () => {
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
        compoundError: "aggregator 500",
        activePosition: {
          token0Symbol: "eHEX",
          token1Symbol: "HEX",
          fee: 10000,
        },
      },
    };
    const fired = runDispatch(states, new Set(), new Set());
    assert.strictEqual(fired.length, 2);
    const byKind = Object.fromEntries(fired.map((f) => [f.kind, f]));
    assert.strictEqual(byKind.error.key, KEY_A);
    assert.strictEqual(byKind.compoundError.key, KEY_B);
  });
});
