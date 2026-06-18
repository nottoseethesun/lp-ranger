/**
 * @file src/pool-state-validate.js
 * @description Error classes and per-field validation predicates used
 *   by `getPoolState` in `src/rebalancer-pools.js`.  Extracted here so
 *   `rebalancer-pools.js` stays under the 500-line cap and so the
 *   validation rules live in one easily-auditable spot.
 *
 *   The rules guard against silent NaN cascades downstream — see the
 *   `project_nan_deposit_decimals_bug` memory and the
 *   `getpoolstate-validate-retry-fail-dialog` PR for the motivating
 *   prod incident.
 */

"use strict";

/**
 * Error thrown when a single RPC attempt returns pool-state data that
 * fails per-field validation.  Captures the failing field, the bad
 * value, and which RPC URL produced it so the retry orchestrator can
 * log it and surface it in the eventual user-facing modal if the
 * attempt budget is exhausted.
 */
class PoolStateInvalidError extends Error {
  constructor(field, value, rpcUrl) {
    super(
      `getPoolState: ${field} failed validation (got ${String(value)}) via RPC ${rpcUrl}`,
    );
    this.name = "PoolStateInvalidError";
    this.field = field;
    this.value = value;
    this.rpcUrl = rpcUrl;
  }
}

/**
 * Error thrown after every configured RPC has been exhausted (each
 * attempted twice, with a delay between retries) and the call still
 * produced either an invalid response or an RPC error.  `cause` is
 * the most recent underlying error; `attempts` is the total attempts
 * made across all RPCs.
 */
class PoolStateUnavailableError extends Error {
  constructor(attempts, lastError) {
    super(
      `getPoolState: exhausted ${attempts} RPC attempt(s); last error: ` +
        (lastError?.message || String(lastError)),
    );
    this.name = "PoolStateUnavailableError";
    this.attempts = attempts;
    this.cause = lastError;
  }
}

/** Validate a single field, throwing `PoolStateInvalidError` on predicate failure. */
function validateField(field, value, predicate, rpcUrl) {
  if (!predicate(value)) throw new PoolStateInvalidError(field, value, rpcUrl);
}

/*- Address-string: must be a non-empty string that starts with `0x`.
 *  We intentionally DON'T enforce the strict 40-hex EIP-55 shape here
 *  because (a) the user's spec was datatype + not-null only, (b) some
 *  forks return non-canonical address strings, and (c) test fixtures
 *  use sentinel addresses like `0xPOOL…` that wouldn't be valid hex
 *  but are still valid string types.  The ZeroAddress check (separate)
 *  catches the actual "no pool exists" sentinel. */
function isAddressString(x) {
  return typeof x === "string" && x.length > 0 && x.startsWith("0x");
}

/** Finite positive integer. */
function isPositiveInteger(x) {
  return (
    typeof x === "number" && Number.isFinite(x) && Number.isInteger(x) && x > 0
  );
}

/** Integer in `[lo, hi]` (inclusive). */
function isIntegerInRange(x, lo, hi) {
  return typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;
}

/** Any signed integer (Number.isInteger handles non-number short-circuit). */
function isAnyInteger(x) {
  return typeof x === "number" && Number.isInteger(x);
}

/** Finite positive number (handles NaN / Infinity / non-number rejection). */
function isFinitePositive(x) {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

/*- Coerces to BigInt inside a try/catch — `BigInt(null)`,
 *  `BigInt(undefined)`, `BigInt("garbage")` all throw `TypeError` /
 *  `SyntaxError`, which the catch maps to a clean `false` so the
 *  validator throws a uniform `PoolStateInvalidError` instead of a
 *  raw thrown TypeError from the predicate. */
function isPositiveBigIntish(x) {
  try {
    return BigInt(x) > 0n;
  } catch {
    return false;
  }
}

module.exports = {
  PoolStateInvalidError,
  PoolStateUnavailableError,
  validateField,
  isAddressString,
  isPositiveInteger,
  isIntegerInRange,
  isAnyInteger,
  isFinitePositive,
  isPositiveBigIntish,
};
