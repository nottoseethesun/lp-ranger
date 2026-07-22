"use strict";

/**
 * @file test/dashboard-data-kpi-breakdown.test.js
 * @description Tests for `updateNetBreakdown` in
 *   `public/dashboard-data-kpi-breakdown.js`.  The module writes the
 *   six Lifetime Net P&L breakdown rows (Fees Compounded, Gas, Price
 *   Change, Wallet Residual, Initial Residual, Realized Gains) with
 *   sign-appropriate colour coding.  Uses jsdom to provide real
 *   `document` + real DOM elements — no hand-rolled stubs.
 *
 *   Pins the row-write dispatch: colour classes (`pos` / `neg` / `neu`),
 *   the em-dash null token, the true minus-sign on subtracted rows
 *   (U+2212 vs `-`), the neutral render on Initial Residual (positive
 *   value, no leading minus, `neu` class), and coordinated LT_BD_IDS
 *   coverage.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;

/** Row IDs written by `updateNetBreakdown`. */
const ROW_IDS = [
  "ltBdCompounded",
  "ltBdGas",
  "ltBdPriceChange",
  "ltBdResidual",
  "ltBdInitialResidual",
  "ltBdRealized",
];

before(async () => {
  mod = await import("../public/dashboard-data-kpi-breakdown.js");
});

beforeEach(() => {
  // Rebuild the six breakdown rows in the DOM before every test — the
  // module reads them by ID via document.getElementById.
  document.body.innerHTML = ROW_IDS.map(
    (id) => `<span id="${id}"></span>`,
  ).join("");
});

describe("LT_BD_IDS", () => {
  it("enumerates every breakdown row id (aligned with reset paths)", () => {
    assert.deepStrictEqual(
      mod.LT_BD_IDS.slice().sort(),
      ROW_IDS.slice().sort(),
    );
  });
});

describe("updateNetBreakdown()", () => {
  // Signature: updateNetBreakdown(priceChange, realized, gas, residual,
  //                              compounded, initialResidual)

  it("positive values render in the 'pos' colour class", () => {
    mod.updateNetBreakdown(50, 10, 3, 25, 40, 5);
    for (const id of [
      "ltBdCompounded",
      "ltBdPriceChange",
      "ltBdResidual",
      "ltBdRealized",
    ]) {
      assert.ok(
        document.getElementById(id).classList.contains("pos"),
        `${id} should have 'pos' class`,
      );
    }
  });

  it("negative values render in the 'neg' colour class", () => {
    // priceChange=-50, realized=-10, gas=5 (positive → subtracted → neg),
    // residual=-25, compounded=-30, initialResidual=0.
    mod.updateNetBreakdown(-50, -10, 5, -25, -30, 0);
    for (const id of [
      "ltBdCompounded",
      "ltBdPriceChange",
      "ltBdResidual",
      "ltBdRealized",
    ]) {
      assert.ok(
        document.getElementById(id).classList.contains("neg"),
        `${id} should have 'neg' class`,
      );
    }
  });

  it("Gas is always rendered as subtracted (red) with a true minus sign (U+2212)", () => {
    mod.updateNetBreakdown(0, 0, 15, 0, 0, 0);
    const el = document.getElementById("ltBdGas");
    assert.ok(el.classList.contains("neg"));
    // Minus goes BETWEEN "$usd " and the numeric body (raw hyphen from
    // _fmtUsd is swapped in-place for U+2212 MINUS SIGN).
    assert.strictEqual(el.textContent, "$usd −15.00");
  });

  it(
    "Initial Residual is neutral: positive value, no leading minus, " +
      "'neu' class — avoids implying a 'negative wallet balance'",
    () => {
      // initialResidual is the 6th param.
      mod.updateNetBreakdown(0, 0, 0, 0, 0, 40);
      const el = document.getElementById("ltBdInitialResidual");
      assert.ok(el.classList.contains("neu"));
      assert.strictEqual(el.textContent, "$usd 40.00");
    },
  );

  it("null / undefined values render as em-dash with 'neu' class", () => {
    mod.updateNetBreakdown(null, null, null, null, null, null);
    for (const id of ROW_IDS) {
      const el = document.getElementById(id);
      assert.strictEqual(el.textContent, "—", `${id} textContent`);
      assert.ok(el.classList.contains("neu"), `${id} should have 'neu' class`);
    }
  });

  it("gas=null renders em-dash (subtracted-row null path)", () => {
    mod.updateNetBreakdown(10, 5, null, 20, 30, 5);
    const el = document.getElementById("ltBdGas");
    assert.strictEqual(el.textContent, "—");
    assert.ok(el.classList.contains("neu"));
  });

  it("skips gracefully when a row element is missing (defensive)", () => {
    document.getElementById("ltBdCompounded").remove();
    // priceChange=50 → ltBdPriceChange textContent = "$usd 50.00".
    assert.doesNotThrow(() => mod.updateNetBreakdown(50, 5, 3, 25, 40, 5));
    assert.strictEqual(
      document.getElementById("ltBdPriceChange").textContent,
      "$usd 50.00",
    );
  });
});
