/**
 * @file test/pool-state-validate.test.js
 * @description Unit coverage for the error classes + validation
 *   predicates in `src/pool-state-validate.js`.  The orchestrator and
 *   `_getPoolStateOnce` integration in `src/rebalancer-pools.js` are
 *   covered in `test/rebalancer-pools.test.js`.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PoolStateInvalidError,
  PoolStateUnavailableError,
  validateField,
  isAddressString,
  isPositiveInteger,
  isIntegerInRange,
  isAnyInteger,
  isFinitePositive,
  isPositiveBigIntish,
} = require("../src/pool-state-validate");

// ── Error class construction ────────────────────────────────────────────────

test("PoolStateInvalidError captures field, value, rpcUrl + readable message", () => {
  const e = new PoolStateInvalidError("decimals0", undefined, "http://primary");
  assert.equal(e.name, "PoolStateInvalidError");
  assert.equal(e.field, "decimals0");
  assert.equal(e.value, undefined);
  assert.equal(e.rpcUrl, "http://primary");
  /*- Message must include the failing field name (operator scan-pattern)
   *  AND the offending value (so a `NaN` vs `undefined` distinction is
   *  visible at a glance in the modal). */
  assert.match(e.message, /decimals0/);
  assert.match(e.message, /undefined/);
  assert.match(e.message, /http:\/\/primary/);
});

test("PoolStateUnavailableError captures attempts + cause chain", () => {
  const inner = new PoolStateInvalidError("tick", null, "http://x");
  const e = new PoolStateUnavailableError(4, inner);
  assert.equal(e.name, "PoolStateUnavailableError");
  assert.equal(e.attempts, 4);
  assert.equal(e.cause, inner);
  assert.match(e.message, /exhausted 4 RPC attempt/);
  /*- Last-error message must be embedded so the modal's scrollable
   *  div surfaces the actual reason without the operator having to
   *  unwrap `.cause` by hand. */
  assert.match(e.message, /tick/);
});

test("PoolStateUnavailableError handles a non-Error cause", () => {
  const e = new PoolStateUnavailableError(2, "raw string reason");
  assert.match(e.message, /raw string reason/);
});

// ── validateField ───────────────────────────────────────────────────────────

test("validateField throws PoolStateInvalidError when predicate fails", () => {
  assert.throws(
    () => validateField("decimals0", -1, (x) => x >= 0, "http://x"),
    (err) =>
      err instanceof PoolStateInvalidError &&
      err.field === "decimals0" &&
      err.value === -1 &&
      err.rpcUrl === "http://x",
  );
});

test("validateField is a no-op when predicate passes", () => {
  assert.doesNotThrow(() => validateField("decimals0", 18, (x) => x >= 0, "x"));
});

// ── isAddressString ─────────────────────────────────────────────────────────

test("isAddressString accepts mixed-case + lower-case 40-hex addresses", () => {
  assert.ok(isAddressString("0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b"));
  assert.ok(isAddressString("0xa0b73e1ff0b80914ab6fe0444e65848c4c34450b"));
});

test("isAddressString rejects non-strings / null / undefined / missing 0x / empty", () => {
  /*- Relaxed validation: we only check string + non-empty + starts
   *  with `0x` (so test sentinels like `0xPOOL…` still pass).  The
   *  separate ZeroAddress check in `_getPoolStateOnce` catches the
   *  actual "no pool exists" failure mode. */
  for (const bad of [
    null,
    undefined,
    0,
    "",
    "not an address",
    "a".repeat(42), // missing 0x
    {},
  ]) {
    assert.equal(isAddressString(bad), false, `should reject ${String(bad)}`);
  }
});

// ── isPositiveInteger / isIntegerInRange / isAnyInteger ─────────────────────

test("isPositiveInteger: only > 0 finite integers pass", () => {
  for (const ok of [1, 100, 42, 200]) assert.ok(isPositiveInteger(ok));
  for (const bad of [0, -1, 1.5, NaN, Infinity, "5", null, undefined])
    assert.equal(isPositiveInteger(bad), false, String(bad));
});

test("isIntegerInRange: inclusive bounds, only integers", () => {
  assert.ok(isIntegerInRange(0, 0, 77));
  assert.ok(isIntegerInRange(77, 0, 77));
  assert.ok(isIntegerInRange(18, 0, 77));
  assert.equal(isIntegerInRange(-1, 0, 77), false);
  assert.equal(isIntegerInRange(78, 0, 77), false);
  assert.equal(isIntegerInRange(18.5, 0, 77), false);
  assert.equal(isIntegerInRange(undefined, 0, 77), false);
  assert.equal(isIntegerInRange(NaN, 0, 77), false);
});

test("isAnyInteger: signed integers (including negative) pass; non-numbers fail", () => {
  for (const ok of [0, -1, -310200, 12345]) assert.ok(isAnyInteger(ok));
  for (const bad of [1.5, NaN, Infinity, "0", null, undefined])
    assert.equal(isAnyInteger(bad), false, String(bad));
});

// ── isFinitePositive ────────────────────────────────────────────────────────

test("isFinitePositive: only finite > 0 numbers", () => {
  for (const ok of [1, 0.001, 1e-9, 1e18, 0.000007])
    assert.ok(isFinitePositive(ok));
  for (const bad of [0, -0.1, NaN, Infinity, -Infinity, "5", null, undefined])
    assert.equal(isFinitePositive(bad), false, String(bad));
});

// ── isPositiveBigIntish ─────────────────────────────────────────────────────

test("isPositiveBigIntish accepts BigInt / numeric / decimal-string > 0", () => {
  assert.ok(isPositiveBigIntish(1n));
  assert.ok(isPositiveBigIntish(2n ** 96n));
  assert.ok(isPositiveBigIntish(42));
  assert.ok(isPositiveBigIntish("12345"));
});

test("isPositiveBigIntish rejects null / undefined / 0 / negative / garbage", () => {
  /*- Catches the BigInt() conversion failure (TypeError on null/undefined,
   *  SyntaxError on garbage strings, RangeError on non-integer numbers)
   *  via the try/catch and maps them all to false uniformly. */
  for (const bad of [
    null,
    undefined,
    0n,
    -1n,
    "0",
    "-1",
    "garbage",
    "1.5", // BigInt("1.5") throws
    1.5, // BigInt(1.5) throws
    NaN,
    {},
  ]) {
    assert.equal(
      isPositiveBigIntish(bad),
      false,
      `should reject ${String(bad)}`,
    );
  }
});
