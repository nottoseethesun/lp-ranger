"use strict";

/**
 * @file test/dashboard-data-kpi-breakdown.test.js
 * @description Tests for `updateNetBreakdown` in
 *   `public/dashboard-data-kpi-breakdown.js`.  The module writes the
 *   six Lifetime Net P&L breakdown rows (Fees Compounded, Gas, Price
 *   Change, Wallet Residual, Initial Residual, Realized Gains) with
 *   sign-appropriate colour coding.  A minimal `document.getElementById`
 *   stub is installed so the module can be imported directly via ESM
 *   without pulling in jsdom.
 *
 *   Pins the row-write dispatch: colour classes (`pos` / `neg` / `neu`),
 *   the em-dash null token, the true minus-sign on subtracted rows
 *   (U+2212 vs `-`), the neutral render on Initial Residual (positive
 *   value, no leading minus, `neu` class), and coordinated LT_BD_IDS
 *   coverage.
 */

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let updateNetBreakdown;
let LT_BD_IDS;

/** Row IDs written by `updateNetBreakdown`. */
const ROW_IDS = [
  "ltBdCompounded",
  "ltBdGas",
  "ltBdPriceChange",
  "ltBdResidual",
  "ltBdInitialResidual",
  "ltBdRealized",
];

let _els;

function _makeFakeElement() {
  const classes = new Set();
  return {
    textContent: "",
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      _snapshot: () => Array.from(classes),
    },
  };
}

before(async () => {
  // Install the minimum-viable document stub BEFORE importing the module.
  globalThis.document = {
    getElementById: (id) => _els[id] || null,
  };
  ({ updateNetBreakdown, LT_BD_IDS } =
    await import("../public/dashboard-data-kpi-breakdown.js"));
});

beforeEach(() => {
  _els = {};
  for (const id of ROW_IDS) _els[id] = _makeFakeElement();
});

describe("LT_BD_IDS", () => {
  it("enumerates every breakdown row id (aligned with reset paths)", () => {
    assert.deepStrictEqual(LT_BD_IDS.slice().sort(), ROW_IDS.slice().sort());
  });
});

describe("updateNetBreakdown()", () => {
  // Signature: updateNetBreakdown(priceChange, realized, gas, residual,
  //                              compounded, initialResidual)

  it("positive values render in the 'pos' colour class", () => {
    updateNetBreakdown(50, 10, 3, 25, 40, 5);
    // Compounded / Price Change / Residual / Realized are 'normal' rows.
    assert.strictEqual(_els.ltBdCompounded.classList.contains("pos"), true);
    assert.strictEqual(_els.ltBdPriceChange.classList.contains("pos"), true);
    assert.strictEqual(_els.ltBdResidual.classList.contains("pos"), true);
    assert.strictEqual(_els.ltBdRealized.classList.contains("pos"), true);
  });

  it("negative values render in the 'neg' colour class", () => {
    // priceChange=-50, realized=-10, gas=5 (positive → subtracted → neg),
    // residual=-25, compounded=-30, initialResidual=0.
    updateNetBreakdown(-50, -10, 5, -25, -30, 0);
    assert.strictEqual(_els.ltBdCompounded.classList.contains("neg"), true);
    assert.strictEqual(_els.ltBdPriceChange.classList.contains("neg"), true);
    assert.strictEqual(_els.ltBdResidual.classList.contains("neg"), true);
    assert.strictEqual(_els.ltBdRealized.classList.contains("neg"), true);
  });

  it("Gas is always rendered as subtracted (red) with a true minus sign (U+2212)", () => {
    updateNetBreakdown(0, 0, 15, 0, 0, 0);
    // Gas class is 'neg' (subtracted, positive-input → shown as $usd −15).
    assert.strictEqual(_els.ltBdGas.classList.contains("neg"), true);
    // Minus goes BETWEEN "$usd " and the numeric body (the raw hyphen
    // from _fmtUsd is swapped in-place for U+2212 MINUS SIGN).
    assert.strictEqual(_els.ltBdGas.textContent, "$usd −15.00");
  });

  it(
    "Initial Residual is neutral: positive value, no leading minus, " +
      "'neu' class — avoids implying a 'negative wallet balance'",
    () => {
      // initialResidual is the 6th param.
      updateNetBreakdown(0, 0, 0, 0, 0, 40);
      assert.strictEqual(
        _els.ltBdInitialResidual.classList.contains("neu"),
        true,
      );
      assert.strictEqual(_els.ltBdInitialResidual.textContent, "$usd 40.00");
    },
  );

  it("null / undefined values render as em-dash with 'neu' class", () => {
    updateNetBreakdown(null, null, null, null, null, null);
    for (const id of ROW_IDS) {
      assert.strictEqual(_els[id].textContent, "—", `${id} textContent`);
      assert.strictEqual(
        _els[id].classList.contains("neu"),
        true,
        `${id} class`,
      );
    }
  });

  it("gas=null renders em-dash (subtracted-row null path)", () => {
    updateNetBreakdown(10, 5, null, 20, 30, 5);
    assert.strictEqual(_els.ltBdGas.textContent, "—");
    assert.strictEqual(_els.ltBdGas.classList.contains("neu"), true);
  });

  it("skips gracefully when a row element is missing (defensive)", () => {
    delete _els.ltBdCompounded;
    // priceChange=50 → ltBdPriceChange textContent = "$usd 50.00".
    assert.doesNotThrow(() => updateNetBreakdown(50, 5, 3, 25, 40, 5));
    assert.strictEqual(_els.ltBdPriceChange.textContent, "$usd 50.00");
  });
});
