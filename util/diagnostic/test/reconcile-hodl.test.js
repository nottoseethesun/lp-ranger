/**
 * @file util/diagnostic/test/reconcile-hodl.test.js
 * @description
 * Tests for the pure helpers in reconcile-hodl.js.  The CLI `main()`
 * is gated behind `require.main === module` so it does not start
 * an RPC scan when this test file requires the tool.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseKey, totals, toFloat, fmtDelta } = require("../reconcile-hodl");

test("parseKey — splits a well-formed composite key", () => {
  const out = parseKey("pulsechain-0xWALLET-0xPM-159250");
  assert.deepEqual(out, {
    blockchain: "pulsechain",
    wallet: "0xWALLET",
    contract: "0xPM",
    tokenId: "159250",
  });
});

test("parseKey — returns null for malformed keys", () => {
  assert.equal(parseKey("only-three-parts"), null);
  assert.equal(parseKey("a-b-c-d-e"), null);
  assert.equal(parseKey(""), null);
});

test("totals — sums amount0 and amount1 across event list", () => {
  const events = [
    { args: { amount0: 1000n, amount1: 2000n } },
    { args: { amount0: 500n, amount1: 1500n } },
  ];
  assert.deepEqual(totals(events), { s0: 1500n, s1: 3500n });
});

test("totals — empty list returns zeros", () => {
  assert.deepEqual(totals([]), { s0: 0n, s1: 0n });
});

test("totals — handles BigInt inputs correctly", () => {
  /*- Realistic large 18-decimal raw values. */
  const events = [
    { args: { amount0: 123456789012345678n, amount1: 0n } },
    { args: { amount0: 876543210987654322n, amount1: 0n } },
  ];
  assert.equal(totals(events).s0, 1000000000000000000n);
});

test("toFloat — converts raw BigInt to a JS number using decimals", () => {
  assert.equal(toFloat(10n ** 18n, 18), 1);
  assert.equal(toFloat(5n * 10n ** 17n, 18), 0.5);
});

test("toFloat — returns 0 for zero input", () => {
  assert.equal(toFloat(0n, 18), 0);
  assert.equal(toFloat(0n, 6), 0);
});

test("toFloat — handles 6-decimal tokens (like USDC)", () => {
  /*- 1.5 USDC = 1_500_000 raw units. */
  assert.equal(toFloat(1_500_000n, 6), 1.5);
});

test("fmtDelta — shows actual + cached + signed delta", () => {
  /*- on-chain 1.5, cached 1.2 → Δ +0.3. */
  const out = fmtDelta(15n * 10n ** 17n, 1.2, 18);
  assert.match(out, /1\.500000/);
  assert.match(out, /cached: 1\.200000/);
  assert.match(out, /Δ \+0\.300000/);
});

test("fmtDelta — shows negative delta with a leading minus", () => {
  /*- on-chain 1.0, cached 1.5 → Δ -0.5 (no leading +). */
  const out = fmtDelta(10n ** 18n, 1.5, 18);
  assert.match(out, /Δ -0\.500000/);
});

test("fmtDelta — shows '(cached: —)' when cached value is missing", () => {
  assert.match(fmtDelta(10n ** 18n, undefined, 18), /cached: —/);
  assert.match(fmtDelta(10n ** 18n, null, 18), /cached: —/);
  assert.match(fmtDelta(10n ** 18n, NaN, 18), /cached: —/);
});
