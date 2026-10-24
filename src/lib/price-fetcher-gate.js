/**
 * @file src/lib/price-fetcher-gate.js
 * @module price-fetcher-gate
 * @description
 * State + helpers for the idle-driven price-lookup pause described in
 * docs/architecture.md "Idle-Driven Price-Lookup Pause".  Lives in its own
 * module so `src/lib/price-fetcher.js` stays under the 500-line cap.
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
 * The three cache lifetimes come from bot-config.json's `global` section,
 * with the defaults (`readBotConfigDefaults()`) for any it does not set.
 * They are read when a program's entry point calls
 * `readPriceCacheSettings`, never when this file is loaded; until then
 * each is its default. The server and the bot call it as they start. A
 * tool under util/ that needs them passes `skipBackups`, so its read
 * leaves LP Ranger's backups of its settings files alone. The
 * dust-unit-price TTL is derived as `priceTtl * multiplier`; an assertion
 * guards the integer-multiple invariant against future hand-edits.
 */

"use strict";

const { log } = require("./log");
const { readBotConfigDefaults } = require("./bot-config-defaults");
const { loadConfig } = require("./bot-config-v2");

let _priceLookupsPaused = false;
let _allowOverrideCount = 0;

/*-
 *  The three cache lifetimes `readPriceCacheSettings` read from the
 *  settings, or null until a program's entry point calls it.
 */
let _settingsTtls = null;

/**
 * The three cache lifetimes from bot-config.json's `global` section,
 * each the default (bot-config-defaults.json) where the section does not
 * set it.
 * @param {object} cfg  The `global` section, or `{}` for the defaults.
 * @returns {{priceTtl: number, dustTtl: number, moveTtl: number}}
 */
function _ttlsFrom(cfg) {
  const defaults = readBotConfigDefaults();
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
  const moveTtl =
    typeof cfg.moveCacheTtlMs === "number" && cfg.moveCacheTtlMs > 0
      ? cfg.moveCacheTtlMs
      : defaults.moveCacheTtlMs;
  return { priceTtl, dustTtl, moveTtl };
}

/**
 * Read the price library's three cache lifetimes from bot-config.json's
 * `global` section, for the rest of the run: the price cache's
 * (`priceCacheTtlMs`), the dust-unit price's (that times
 * `dustUnitPriceCacheMultiplier`) and the one inside a move
 * (`moveCacheTtlMs`). A program's entry point calls it as it starts.
 * There is no live reload: a change applies at the next start, as with
 * every other global key. A setting that is missing, or a file that
 * cannot be read, leaves the default.
 *
 * The read is `loadConfig`'s, which copies the settings files over their
 * backups unless told not to. The server and the bot let it; a tool under
 * util/ passes `skipBackups`, since its copy would replace the app's while
 * LP Ranger runs.
 * @param {boolean} [skipBackups]  True to make no backup copies, as
 *   `loadConfig` takes it. Default false.
 */
function readPriceCacheSettings(skipBackups = false) {
  let cfg;
  try {
    cfg = loadConfig(undefined, skipBackups).global || {};
  } catch {
    cfg = {};
  }
  _settingsTtls = _ttlsFrom(cfg);
}

/** The lifetimes read from the settings, or the defaults until then. */
function _ttls() {
  return _settingsTtls === null ? _ttlsFrom({}) : _settingsTtls;
}

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
    log.info(
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
    log.info(
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
 * the pause flag as `false` AND shortens the cache-TTL freshness window
 * to `moveCacheTtlMs` (default 4_000 ms) for the duration of the call,
 * so consecutive same-token fetches in the rebalance pipeline collapse
 * onto a single cached value instead of producing a 4-6× burst against
 * the price source.  Counter is decremented in `finally` so a thrown
 * error still restores the prior state.
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
  return _ttls().priceTtl;
}

/** Configured dust-unit-price cache TTL (ms). */
function getDustUnitPriceCacheTtlMs() {
  return _ttls().dustTtl;
}

/** Configured in-move cache TTL (ms). */
function getMoveCacheTtlMs() {
  return _ttls().moveTtl;
}

module.exports = {
  pausePriceLookups,
  unpausePriceLookups,
  isPaused,
  inMove,
  withFreshPricesAllowed,
  readPriceCacheSettings,
  getPriceCacheTtlMs,
  getDustUnitPriceCacheTtlMs,
  getMoveCacheTtlMs,
  _resetPauseStateForTests,
};
