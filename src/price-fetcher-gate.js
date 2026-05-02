/**
 * @file src/price-fetcher-gate.js
 * @module price-fetcher-gate
 * @description
 * State + helpers for the idle-driven price-lookup pause described in
 * docs/architecture.md "Idle-Driven Price-Lookup Pause".  Lives in its own
 * module so `src/price-fetcher.js` stays under the 500-line cap.
 *
 * Four sources mutate `_priceLookupsPaused`:
 *  1. Server-side idle tracker (15 min no /api/* traffic).
 *  2. Browser-side idle detection (POST /api/pause-price-lookups,
 *     POST /api/unpause-price-lookups).
 *  3. Move-scoped fresh-prices override — `withFreshPricesAllowed(fn)`
 *     increments a counter; the gate treats the flag as `false` while
 *     count > 0.  Purely scoped — no "remember to re-pause".
 *  4. Headless `bot.js` start state — `pausePriceLookups()` is called at
 *     startup unless `--start-with-price-lookups-unpaused` is passed.
 *
 * TTLs are read once at module init via `loadConfig().global` with
 * fallback to `readBotConfigDefaults()`.  The dust-unit-price TTL is
 * derived as `priceTtl * multiplier`; an assertion guards the integer-
 * multiple invariant against future hand-edits.
 */

"use strict";

const { readBotConfigDefaults } = require("./bot-config-defaults");
const { loadConfig } = require("./bot-config-v2");

let _priceLookupsPaused = false;
let _allowOverrideCount = 0;

/*- Read the configurable TTL pair once at module-load time.  No live
 *  reload — operators must restart to apply changes (matches how every
 *  other global key is consumed).  Falls back to bot-config-defaults
 *  when the key is missing or the disk file is unreadable. */
function _loadTtlsAtInit() {
  const defaults = readBotConfigDefaults();
  let cfg;
  try {
    cfg = loadConfig().global || {};
  } catch {
    cfg = {};
  }
  const priceTtl =
    typeof cfg.priceCacheTtlMs === "number" && cfg.priceCacheTtlMs > 0
      ? cfg.priceCacheTtlMs
      : defaults.priceCacheTtlMs;
  const mult =
    typeof cfg.dustUnitPriceCacheMultiplier === "number" &&
    cfg.dustUnitPriceCacheMultiplier >= 1
      ? cfg.dustUnitPriceCacheMultiplier
      : defaults.dustUnitPriceCacheMultiplier;
  const dustTtl = priceTtl * Math.floor(mult);
  /*- Structural by construction (priceTtl × integer = integer multiple).
   *  The assertion guards against future hand-edits to either constant
   *  that might break the invariant downstream consumers assume. */
  if (dustTtl % priceTtl !== 0) {
    throw new Error(
      "[price-fetcher] dust TTL (" +
        dustTtl +
        ") must be an integer multiple of price TTL (" +
        priceTtl +
        ")",
    );
  }
  return { priceTtl, dustTtl };
}

const { priceTtl: _PRICE_TTL_MS, dustTtl: _DUST_TTL_MS } = _loadTtlsAtInit();

/**
 * Idempotent — log only on transition.  The optional `reason` is a
 * short human-readable tag identifying the source of the pause (e.g.
 * `"browser blur 2m"`, `"server idle 15m"`, `"headless startup"`) so
 * operators can correlate the server log with the browser console.
 *
 * @param {string} [reason]  Pause source.  Defaults to `"unspecified"`.
 */
function pausePriceLookups(reason) {
  if (!_priceLookupsPaused) {
    _priceLookupsPaused = true;
    console.log(
      "[price-fetcher] paused (%s) — non-essential price fetching is now paused",
      reason || "unspecified",
    );
  }
}

/**
 * Idempotent — log only on transition.  Same `reason` semantics as
 * `pausePriceLookups`.
 *
 * @param {string} [reason]  Unpause source.  Defaults to `"unspecified"`.
 */
function unpausePriceLookups(reason) {
  if (_priceLookupsPaused) {
    _priceLookupsPaused = false;
    console.log(
      "[price-fetcher] unpaused (%s) — fetches resumed",
      reason || "unspecified",
    );
  }
}

/** Current pause flag — independent of the move-scoped override. */
function isPaused() {
  return _priceLookupsPaused;
}

/** True while at least one `withFreshPricesAllowed` scope is active. */
function inMove() {
  return _allowOverrideCount > 0;
}

/**
 * Run `asyncFn` with the move-scope override engaged: the gate treats
 * the pause flag as `false` AND bypasses cache-TTL freshness checks for
 * the duration of the call.  Counter is decremented in `finally` so a
 * thrown error still restores the prior state.
 *
 * @template T
 * @param {() => Promise<T>} asyncFn
 * @returns {Promise<T>}
 */
async function withFreshPricesAllowed(asyncFn) {
  _allowOverrideCount++;
  try {
    return await asyncFn();
  } finally {
    _allowOverrideCount--;
  }
}

/** Tests only: clear the pause flag and override counter. */
function _resetPauseStateForTests() {
  _priceLookupsPaused = false;
  _allowOverrideCount = 0;
}

/** Configured price-cache TTL (ms). */
function getPriceCacheTtlMs() {
  return _PRICE_TTL_MS;
}

/** Configured dust-unit-price cache TTL (ms). */
function getDustUnitPriceCacheTtlMs() {
  return _DUST_TTL_MS;
}

module.exports = {
  pausePriceLookups,
  unpausePriceLookups,
  isPaused,
  inMove,
  withFreshPricesAllowed,
  getPriceCacheTtlMs,
  getDustUnitPriceCacheTtlMs,
  _resetPauseStateForTests,
};
