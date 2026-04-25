/**
 * @file test/rebalancer-pools-impact.test.js
 * @description Tests for _checkSwapImpact guard.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  _checkSwapImpact,
  _bestAttemptError,
  _deadline,
} = require("../src/rebalancer-pools");

describe("_checkSwapImpact", () => {
  it("does not throw when impact is within slippage", () => {
    assert.doesNotThrow(() => _checkSwapImpact(0.3, 0.5));
  });

  it("throws when impact exceeds slippage", () => {
    assert.throws(
      () => _checkSwapImpact(1.2, 0.5),
      /Swap aborted.*exceeds slippage/,
    );
  });

  it("throws on non-finite impact", () => {
    assert.throws(() => _checkSwapImpact(NaN, 0.5), /price impact is NaN/);
    assert.throws(
      () => _checkSwapImpact(Infinity, 0.5),
      /price impact is Infinity/,
    );
  });

  it("suggests a higher slippage in the error message", () => {
    try {
      _checkSwapImpact(2.3, 0.5);
      assert.fail("should have thrown");
    } catch (e) {
      assert.match(e.message, /Increase to at least/);
      assert.match(e.message, /2\.8%/);
    }
  });

  it("records each call to attempts array (passing case)", () => {
    const attempts = [];
    _checkSwapImpact(0.3, 0.5, attempts, "agg");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].label, "agg");
    assert.equal(attempts[0].impactPct, 0.3);
  });

  it("records the attempt before throwing (aborting case)", () => {
    const attempts = [];
    assert.throws(() => _checkSwapImpact(6, 0.5, attempts, "agg-full"));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].label, "agg-full");
    assert.equal(attempts[0].impactPct, 6);
  });

  it("marks slippage-abort errors with isSwapImpactAbort=true", () => {
    try {
      _checkSwapImpact(6, 0.5);
      assert.fail("should have thrown");
    } catch (e) {
      assert.equal(e.isSwapImpactAbort, true);
    }
  });

  it("does not mark non-finite errors as slippage aborts", () => {
    try {
      _checkSwapImpact(NaN, 0.5);
      assert.fail("should have thrown");
    } catch (e) {
      assert.notEqual(e.isSwapImpactAbort, true);
    }
  });

  it("uses fallback label '(unknown)' when label omitted", () => {
    const attempts = [];
    _checkSwapImpact(0.1, 0.5, attempts);
    assert.equal(attempts[0].label, "(unknown)");
  });
});

describe("_bestAttemptError", () => {
  it("returns null on empty / missing attempts", () => {
    assert.equal(_bestAttemptError([], 0.5), null);
    assert.equal(_bestAttemptError(undefined, 0.5), null);
    assert.equal(_bestAttemptError(null, 0.5), null);
  });

  it("returns null when no finite-impact entries", () => {
    assert.equal(
      _bestAttemptError([{ label: "x", impactPct: NaN }], 0.5),
      null,
    );
  });

  it("picks the lowest-impact attempt", () => {
    const err = _bestAttemptError(
      [
        { label: "agg-full", impactPct: 6 },
        { label: "chunk 1/3", impactPct: 4 },
        { label: "V3 router", impactPct: 30 },
      ],
      0.5,
    );
    assert.match(err.message, /4\.0%/);
    assert.match(err.message, /chunk 1\/3/);
    assert.match(err.message, /3 attempts tried/);
    assert.equal(err.isSwapImpactAbort, true);
  });

  it("suggests slippage based on the lowest impact, not the largest", () => {
    const err = _bestAttemptError(
      [
        { label: "agg", impactPct: 6 },
        { label: "router", impactPct: 30 },
      ],
      0.5,
    );
    // Ceil(6 * 10) / 10 + 0.5 = 6.5
    assert.match(err.message, /Increase to at least 6\.5%/);
    // Should NOT mention 30%
    assert.ok(!/30/.test(err.message), "must not surface the 30% number");
  });

  it("ignores non-finite entries when picking the minimum", () => {
    const err = _bestAttemptError(
      [
        { label: "broken", impactPct: NaN },
        { label: "good", impactPct: 2 },
      ],
      0.5,
    );
    assert.match(err.message, /2\.0%/);
    assert.match(err.message, /good/);
  });
});

describe("_deadline", () => {
  it("returns a bigint in the future", () => {
    const dl = _deadline();
    const now = BigInt(Math.floor(Date.now() / 1000));
    assert.ok(typeof dl === "bigint");
    assert.ok(dl > now, "deadline should be in the future");
    assert.ok(dl - now <= 600n, "default offset should be ≤ 600s");
  });

  it("accepts a custom offset", () => {
    const dl = _deadline(60);
    const now = BigInt(Math.floor(Date.now() / 1000));
    assert.ok(dl - now >= 59n && dl - now <= 61n);
  });
});
