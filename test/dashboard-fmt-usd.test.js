"use strict";

/**
 * @file test/dashboard-fmt-usd.test.js
 * @description Tests for `public/dashboard-fmt-usd.js` — the USD
 *   formatter used by the Current and Lifetime panels.  Uses jsdom
 *   (via `global-jsdom/register`) so `navigator.language` and other
 *   browser globals the module inspects at load time are populated
 *   with realistic defaults, then imports the module directly.
 *
 *   Pins the currency-text literal (`$usd`), the em-dash null token,
 *   the < $0.005 zero-body suppression (no leading minus for zero),
 *   and locale-aware thousands separation.  Regressions here would
 *   silently misprice the primary user-facing panels.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let _fmtUsd;

before(async () => {
  ({ _fmtUsd } = await import("../public/dashboard-fmt-usd.js"));
});

describe("_fmtUsd()", () => {
  it("returns em-dash for null", () => {
    assert.strictEqual(_fmtUsd(null), "—");
  });

  it("returns em-dash for undefined", () => {
    assert.strictEqual(_fmtUsd(undefined), "—");
  });

  it("returns em-dash for NaN", () => {
    assert.strictEqual(_fmtUsd(NaN), "—");
  });

  it("formats zero without a minus sign", () => {
    assert.strictEqual(_fmtUsd(0), "$usd 0.00");
  });

  it("suppresses the minus sign for -0", () => {
    // -0 magnitude is < 0.005, so the isZero branch owns it.
    assert.strictEqual(_fmtUsd(-0), "$usd 0.00");
  });

  it("suppresses the minus sign for tiny sub-half-cent negatives", () => {
    // |-0.001| < 0.005 → isZero true → no leading minus per implementation.
    assert.strictEqual(_fmtUsd(-0.001), "$usd 0.00");
  });

  it("formats a positive small amount with 2 decimals", () => {
    assert.strictEqual(_fmtUsd(1.5), "$usd 1.50");
  });

  it("formats a negative amount with a leading minus", () => {
    assert.strictEqual(_fmtUsd(-42.75), "$usd -42.75");
  });

  it("applies thousands separation for large positives", () => {
    // en-US fallback locale: comma thousands separator.
    assert.strictEqual(_fmtUsd(1234.56), "$usd 1,234.56");
  });

  it("applies thousands separation for large negatives", () => {
    assert.strictEqual(_fmtUsd(-1234567.89), "$usd -1,234,567.89");
  });

  it("rounds to 2 decimals (numbric.format mantissa: 2)", () => {
    // numbro's format with mantissa: 2 uses "round half away from zero"
    // in en-US by default; assert both a round-up and round-down case.
    assert.strictEqual(_fmtUsd(1.235), "$usd 1.24");
    assert.strictEqual(_fmtUsd(1.234), "$usd 1.23");
  });
});
