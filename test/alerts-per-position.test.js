"use strict";

/**
 * @file test/alerts-per-position.test.js
 * @description Tests the per-position dispatch decisions extracted
 *   from `showPerPositionAlerts` in `src/client/web/dashboard-alerts.js` and
 *   `showPostRebalanceWarnings` in
 *   `src/client/web/dashboard-post-rebalance-modal.js`.  The prior file
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
  alerts = await import("../src/client/web/dashboard-alerts.js");
  postReb = await import("../src/client/web/dashboard-post-rebalance-modal.js");
});

function _emptyCoreDedup() {
  return {
    recShown: new Set(),
    errShown: new Set(),
    compoundErrShown: new Set(),
    catastrophicShown: new Set(),
    ilGuardShown: new Set(),
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

// ── Impermanent Loss Guard block ───────────────────────────────────────

describe("_computeCoreAlertDispatch — Impermanent Loss Guard", () => {
  /*- Without an alert a rejection is invisible on screen: the position
   *  sits out of range, no rebalance happens, and the only explanation
   *  is in Telegram or the server log.  The server publishes
   *  `ilGuardBlocked` on the rejection transition and nulls it when the
   *  position is let through again. */

  /*- The real published shape: the server composes the wording once
   *  (src/lib/il-guard.js `_publishBlocked`) and the modal renders it, so
   *  the phone alert and the dialog cannot word one rejection two
   *  different ways.  Nothing else travels — a figure the modal does
   *  not render would be dead weight on every /api/status poll. */
  const blocked = { message: "This position is worth $usd 480.00 — …" };

  it("fires for a blocked position", () => {
    const fired = alerts._computeCoreAlertDispatch(
      { [KEY_A]: { ilGuardBlocked: blocked } },
      _emptyCoreDedup(),
    );
    assert.deepEqual(fired, [{ kind: "ilGuardBlocked", key: KEY_A }]);
  });

  it("does not re-fire while the block persists", () => {
    /*- The gate re-evaluates on its own backoff schedule; the modal must
     *  not reappear after the user dismisses it. */
    const dedup = _emptyCoreDedup();
    dedup.ilGuardShown.add(KEY_A);
    assert.deepEqual(
      alerts._computeCoreAlertDispatch(
        { [KEY_A]: { ilGuardBlocked: blocked } },
        dedup,
      ),
      [],
    );
  });

  it("labels the blocked position, not another one", () => {
    /*- Same per-position correctness the rest of this file exists for:
     *  the alert must name the position the server blocked, whatever tab
     *  is being viewed. */
    const fired = alerts._computeCoreAlertDispatch(
      {
        [KEY_A]: { rebalancePaused: false },
        [KEY_B]: { ilGuardBlocked: blocked },
        [KEY_C]: {},
      },
      _emptyCoreDedup(),
    );
    assert.deepEqual(fired, [{ kind: "ilGuardBlocked", key: KEY_B }]);
  });

  it("stays silent when nothing is blocked", () => {
    assert.deepEqual(
      alerts._computeCoreAlertDispatch(
        { [KEY_A]: { ilGuardBlocked: null }, [KEY_B]: {} },
        _emptyCoreDedup(),
      ),
      [],
    );
  });

  it("fires alongside an unrelated alert on another position", () => {
    const fired = alerts._computeCoreAlertDispatch(
      {
        [KEY_A]: { ilGuardBlocked: blocked },
        [KEY_B]: { compoundError: "boom" },
      },
      _emptyCoreDedup(),
    );
    assert.equal(fired.length, 2);
    assert.ok(
      fired.some((f) => f.kind === "ilGuardBlocked" && f.key === KEY_A),
    );
    assert.ok(fired.some((f) => f.kind === "compoundError" && f.key === KEY_B));
  });
});

describe("showPerPositionAlerts — Impermanent Loss Guard modal", () => {
  /*- Drives the real render, not just the dispatch decision: the modal
   *  shows the wording the SERVER composed, so a change to
   *  `_ilGuardMessage` reaches the dialog without anyone editing the
   *  dashboard.  Rendered with createElement + textContent, so server
   *  text never reaches innerHTML. */
  /*- `_createModal` builds its shell by cloning the `tplStatusModal`
   *  <template> from index.html.  jsdom starts with a bare document, so
   *  without the real template the overlay renders empty and this test
   *  would pass on markup nobody ships.  Lifted from index.html rather
   *  than retyped, so a change to the shell is felt here. */
  const TPL = (() => {
    const html = require("node:fs").readFileSync(
      require("node:path").join(
        __dirname,
        "..",
        "src",
        "client",
        "web",
        "index.html",
      ),
      "utf8",
    );
    const m = html.match(/<template id="tplStatusModal"[\s\S]*?<\/template>/);
    assert.ok(m, "tplStatusModal template not found in index.html");
    return m[0];
  })();

  const MESSAGE =
    "This position is worth $usd 480.00 — 52.0% below the $usd 1000.00 " +
    "it was worth when this NFT was minted.\n\nNo rebalance was " +
    "attempted. The position was not touched.";

  it("renders the published message, one paragraph per block", () => {
    alerts._resetAlertsState();
    document.body.innerHTML = TPL;
    alerts.showPerPositionAlerts({
      _allPositionStates: {
        [KEY_A]: { ilGuardBlocked: { message: MESSAGE }, activePosition: {} },
      },
    });
    const text = document.body.textContent;
    for (const block of MESSAGE.split("\n\n"))
      assert.ok(text.includes(block), `missing: ${block.slice(0, 40)}…`);
    /*- getElementsByClassName, not a selector: these class names start
     *  with a digit, which is invalid in CSS unless escaped (the reason
     *  the stylesheets carry `\39 mm-pos-mgr-…`). */
    const body = document.getElementsByClassName("9mm-pos-mgr-modal-body")[0];
    assert.equal(
      body.getElementsByTagName("p").length,
      2,
      "one paragraph per blank-line block",
    );
  });

  it("does not double-render while the block persists", () => {
    alerts._resetAlertsState();
    document.body.innerHTML = TPL;
    const d = {
      _allPositionStates: {
        [KEY_A]: { ilGuardBlocked: { message: MESSAGE }, activePosition: {} },
      },
    };
    alerts.showPerPositionAlerts(d);
    alerts.showPerPositionAlerts(d);
    /*- The overlay only.  An `id*=` match would also catch the body
     *  div, whose id is the overlay's plus a suffix. */
    const overlays = Array.from(
      document.getElementsByClassName("9mm-pos-mgr-modal-overlay"),
    ).filter((el) => el.id.startsWith("ilGuardBlockedModal"));
    assert.equal(overlays.length, 1);
  });
});

describe("showPerPositionAlerts — a rebalance the price outran", () => {
  /*- The user's ruling, 2026-10-23: a yellow warning advising the owner
   *  to weigh the impermanent loss and, if acceptable, click Rebalance
   *  Now; the same words the Telegram alert sends. The real template, as
   *  for the Guard's dialog above. */
  const TPL = (() => {
    const html = require("node:fs").readFileSync(
      require("node:path").join(
        __dirname,
        "..",
        "src",
        "client",
        "web",
        "index.html",
      ),
      "utf8",
    );
    return html.match(/<template id="tplStatusModal"[\s\S]*?<\/template>/)[0];
  })();
  const { priceMovedStopMessage } = require("../src/lib/price-moved-stop");

  /** Open the dialog for a held position whose error is `message`. */
  function open(message) {
    alerts._resetAlertsState();
    document.body.innerHTML = TPL;
    alerts.showPerPositionAlerts({
      _allPositionStates: {
        [KEY_A]: {
          rebalancePaused: true,
          rebalanceError: message,
          activePosition: {},
        },
      },
    });
    return Array.from(
      document.getElementsByClassName("9mm-pos-mgr-modal-overlay"),
    ).find((el) => el.id.startsWith("rebalanceErrorModal"));
  }

  it("opens as a warning, with the bot's advice and no footer of its own", () => {
    const overlay = open(priceMovedStopMessage());
    assert.ok(overlay, "the dialog opened");
    assert.ok(
      overlay.getElementsByClassName("9mm-pos-mgr-warning-modal").length > 0 ||
        overlay.classList.contains("9mm-pos-mgr-warning-modal"),
      "the yellow warning shell",
    );
    assert.ok(
      overlay.textContent.includes("Rebalance stopped — the price moved"),
    );
    assert.ok(overlay.textContent.includes("click Rebalance Now"));
    assert.equal(
      overlay.getElementsByClassName("9mm-pos-mgr-text-muted").length,
      0,
      "the advice is the bot's, said once",
    );
  });

  it("shows the server's words as text, never as markup", () => {
    const overlay = open("Price moved out of the new range <b>x</b>");
    assert.equal(overlay.getElementsByTagName("b").length, 0);
    assert.ok(overlay.textContent.includes("<b>x</b>"));
  });

  it("keeps the plain shell and its footer for other stops", () => {
    const overlay = open("Swap aborted: price impact 3% exceeds slippage 1%");
    assert.equal(
      overlay.getElementsByClassName("9mm-pos-mgr-warning-modal").length,
      0,
    );
    assert.ok(overlay.textContent.includes("Adjust the slippage setting"));
  });
});
