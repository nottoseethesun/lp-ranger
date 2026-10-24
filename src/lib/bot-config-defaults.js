/**
 * @file src/lib/bot-config-defaults.js
 * @module botConfigDefaults
 * @description
 * Reads `bot-config-defaults.json` (via the layered defaults+user-
 * override loader — see `src/lib/load-merged-defaults.js`). These are
 * *defaults* for user-editable Bot Config settings: the bot falls back
 * to them for a key that isn't present in `bot-config.json`, and the
 * dashboard shows them as the initial input value when the user hasn't
 * saved an override yet. The dashboard receives them through
 * `src/lib/resolved-settings.js` (`GET /api/bot-config-defaults`), which
 * puts `.env`'s value on top for the settings `.env` can set.
 *
 * Keys match the bot-config-v2 POSITION_KEYS / GLOBAL_KEYS naming so
 * the same string flows end-to-end (defaults file → dashboard input →
 * saved config → bot reader).
 *
 * New user-setting defaults should be added here (and wired through
 * the normal config save path) rather than each getting its own
 * dedicated tunable file.  The file is read once, and an operator's
 * edit to `app-config/user-configurable/bot-config-defaults.json` is
 * picked up on restart.  When `src/lib/config.js` reads it at startup, a
 * value outside its range stops the app with a message naming it; a
 * reader that does not ask for that check keeps the shipped default in
 * its place instead.  Read or parse failures fall back to the built-in
 * defaults below so the endpoint never 500s.
 */

"use strict";

const { log } = require("./log");
const {
  loadMergedDefaults,
  loadShippedDefaults,
} = require("./load-merged-defaults");
const { assertTimerSec } = require("./timer-bounds");
const { SETTING_BOUNDS } = require("./setting-bounds");
const { withinBound, boundText } = require("./range-check");

const _FILENAME = "bot-config-defaults.json";

/*- Single-source baseline: read the shipped JSON once at module init.
 *  Throws on missing/malformed file (install error, fail loudly).  Used
 *  as the per-key fallback when an operator's live user-configurable
 *  override contains an out-of-range value (the runtime then falls
 *  back to the last-known-good shipped value rather than propagating
 *  the bad override).  See feedback_one_literal_per_shipped_default —
 *  every default value lives in the JSON, nowhere else in code. */
const _FALLBACK = Object.freeze(loadShippedDefaults(_FILENAME));

/**
 * A value inside the setting's range in setting-bounds.json, or null to
 * leave the shipped default standing. A value outside it is not moved to
 * the nearest allowed figure, and a fraction is not rounded to a whole
 * number: a corrected value is one nobody chose.
 *
 * @param {*} v       The value read from the file.
 * @param {string} key  The setting, as named in both files.
 * @returns {*} `v`, or null.
 */
function _inRange(v, key) {
  return withinBound(v, SETTING_BOUNDS[key]) ? v : null;
}

/**
 * A timer setting's value, or null to leave the shipped default
 * standing.  The bounds are `src/lib/timer-bounds.js`'s — the same rule
 * `.env` is held to, with the lenient policy this reader needs.
 */
function _timerOrNull(v, key) {
  try {
    return assertTimerSec({ sec: v, key, defaultSec: _FALLBACK[key] });
  } catch {
    return null;
  }
}

/**
 * Refuse a timer setting the operator has written out of range.
 *
 * Separate from the normalizer above because the two have different
 * jobs. The normalizer runs on every read — a poll cycle and an HTTP
 * route among them — so it must never throw. This runs once, at
 * startup, from `src/lib/config.js`, where refusing means the app does not
 * come up on a schedule nobody chose.
 *
 * Reads the value as written rather than as normalized, since the
 * normalizer has already replaced a bad one by then.
 * @param {object} parsed  The merged file, before normalizing.
 * @throws {Error} Tagged `badTimerValue`.
 */
function _assertTimerKeys(parsed) {
  for (const key of [
    "checkIntervalSec",
    "gasDeferRetrySec",
    "globalRPCRequestRateIntervalMS",
    "rpcAllEndpointsDownPauseMS",
    "boundedReadRetryDelayMs",
  ]) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    assertTimerSec({
      sec: v,
      key,
      defaultSec: _FALLBACK[key],
      remedy:
        "Correct it in app-config/user-configurable/" +
        "bot-config-defaults.json and restart.",
    });
  }
}

/**
 * Refuse any setting with a range that the operator has written outside
 * it, naming each one.
 *
 * The companion of the timer check above, for the settings whose range is
 * in setting-bounds.json: every top-level key that has one, each member
 * of a group, and each entry of a list. The normalizers keep the shipped
 * default in place of such a value, because they run on every read and
 * must not throw. At startup a value the bot would never use is refused
 * instead, so the operator hears of it rather than running on a figure
 * they did not choose.
 *
 * Whether a value was refused is the normalizers' own answer, read off
 * their result rather than worked out again: a setting written in the
 * file whose value did not come through. A kept value comes through as
 * itself, a list as the same list, so one rule decides both what is kept
 * and what is refused. The on/off settings have no range and are not
 * checked here.
 *
 * @param {object} parsed  The merged file, before normalizing.
 * @param {object} out     What the normalizers made of it.
 * @throws {Error} Tagged `badSettingValue`.
 */
function _assertRangedKeys(parsed, out) {
  const refused = [];
  for (const key of Object.keys(_NORMALIZERS)) {
    const bound = SETTING_BOUNDS[key];
    const v = parsed[key];
    if (bound === undefined || v === undefined || v === null) continue;
    if (_isGroup(key)) refused.push(..._refusedInGroup(key, v, out[key]));
    else if (out[key] !== v) refused.push(_refusal(key, v));
  }
  if (refused.length === 0) return;
  const err = new Error(
    "[config] In app-config/user-configurable/bot-config-defaults.json, " +
      refused.join(" ") +
      " Correct each there, or remove it to use the shipped default," +
      " and restart.",
  );
  err.badSettingValue = true;
  throw err;
}

/**
 * A group is a setting whose shipped value is an object of settings,
 * each with its own range.
 */
function _isGroup(key) {
  const shipped = _FALLBACK[key];
  return (
    shipped !== null && typeof shipped === "object" && !Array.isArray(shipped)
  );
}

/**
 * The members of a group the operator wrote outside their ranges.
 *
 * @param {string} group  The group's name.
 * @param {*} v           The group as written.
 * @param {object} kept   The group as normalized.
 * @returns {string[]} One sentence per refused member.
 */
function _refusedInGroup(group, v, kept) {
  if (typeof v !== "object" || Array.isArray(v))
    return [`${group} must be a set of named values; it is ${_show(v)}.`];
  const refused = [];
  for (const [key, bound] of Object.entries(SETTING_BOUNDS[group])) {
    if (key.startsWith("_")) continue;
    const member = v[key];
    if (member === undefined || member === null) continue;
    if (kept[key] !== member)
      refused.push(
        `${group}.${key} must be ${boundText(bound)}; it is ${_show(member)}.`,
      );
  }
  return refused;
}

/**
 * Say what a top-level setting must be, and what it was. A list's range
 * is each entry's.
 */
function _refusal(key, v) {
  const range = boundText(SETTING_BOUNDS[key]);
  const must = Array.isArray(_FALLBACK[key])
    ? `a list, each entry ${range}`
    : range;
  return `${key} must be ${must}; it is ${_show(v)}.`;
}

// A written value as the file shows it: text in quotes, a list in brackets.
function _show(v) {
  return JSON.stringify(v);
}

/**
 * A nested group, sub-key by sub-key: each value inside its range in
 * setting-bounds.json replaces the shipped one, and any other leaves the
 * shipped one standing, so a partly edited group still comes out whole.
 *
 * @param {*} v          The group as read from the file.
 * @param {string} group The group's name, as named in both files.
 * @returns {object} The whole group.
 */
function _normalizeGroup(v, group) {
  const out = { ..._FALLBACK[group] };
  if (v === null || typeof v !== "object") return out;
  for (const [key, bound] of Object.entries(SETTING_BOUNDS[group])) {
    if (withinBound(v[key], bound)) out[key] = v[key];
  }
  return out;
}

/*-
 *  Mapping of JSON key → normalizer producing the cleaned value or null.
 *  Every range is in setting-bounds.json, beside the reason for it.
 */
const _NORMALIZERS = {
  approvalMultiple: (v) => _inRange(v, "approvalMultiple"),
  gasFeePct: (v) => _inRange(v, "gasFeePct"),
  rebalanceGasDeferPct: (v) => _inRange(v, "rebalanceGasDeferPct"),
  // The wait before looking again at a rebalance deferred for gas; timer-bounds.js decides it.
  gasDeferRetrySec: (v) => _timerOrNull(v, "gasDeferRetrySec"),
  priceCacheTtlMs: (v) => _inRange(v, "priceCacheTtlMs"),
  /*-
   *  A whole multiple, so the dust cache's lifetime is always a clean
   *  multiple of the price cache's.
   */
  dustUnitPriceCacheMultiplier: (v) =>
    _inRange(v, "dustUnitPriceCacheMultiplier"),
  moveCacheTtlMs: (v) => _inRange(v, "moveCacheTtlMs"),
  /*- Moralis on/off.  Anything that is not an explicit false means on,
   *  so a malformed override cannot silently disable a price source the
   *  operator is paying for. */
  moralisEnabled: (v) => (typeof v === "boolean" ? v : true),
  getLogsChunkSize: (v) => _inRange(v, "getLogsChunkSize"),
  /*-
   *  Minimum gap between any two JSON-RPC requests, and how long every
   *  request is held once failover has exhausted the endpoint list. Both
   *  become timer delays, so timer-bounds.js decides them, and both take
   *  zero to mean off: no pacing, no outage pause.
   */
  globalRPCRequestRateIntervalMS: (v) =>
    _timerOrNull(v, "globalRPCRequestRateIntervalMS"),
  rpcAllEndpointsDownPauseMS: (v) =>
    _timerOrNull(v, "rpcAllEndpointsDownPauseMS"),
  rpcFailoverRatePercentage: (v) => _inRange(v, "rpcFailoverRatePercentage"),
  rpcFailoverRateDurationMinutes: (v) =>
    _inRange(v, "rpcFailoverRateDurationMinutes"),
  /*-
   *  Delays between retries of one 429-refused request, in order. An
   *  empty list disables the retry; each entry is checked on its own.
   */
  rpcRetryOn429DelaysMs: (v) =>
    Array.isArray(v) &&
    v.every((n) => withinBound(n, SETTING_BOUNDS.rpcRetryOn429DelaysMs))
      ? v
      : null,
  rpcMax429PenaltyMs: (v) => _inRange(v, "rpcMax429PenaltyMs"),
  /*-
   *  A deadline compared against the clock, not a timer, which is why
   *  its range is its own rather than timer-bounds.js's.
   */
  rpcFailoverStickyMs: (v) => _inRange(v, "rpcFailoverStickyMs"),
  boundedReadAttemptsPerEndpoint: (v) =>
    _inRange(v, "boundedReadAttemptsPerEndpoint"),
  // The wait before asking an endpoint again; timer-bounds.js decides it.
  boundedReadRetryDelayMs: (v) => _timerOrNull(v, "boundedReadRetryDelayMs"),
  // Compared against the clock rather than set as a timer.
  feeDataLogIntervalMs: (v) => _inRange(v, "feeDataLogIntervalMs"),
  historyLookbackYears: (v) => _inRange(v, "historyLookbackYears"),
  eventCacheTtlMs: (v) => _inRange(v, "eventCacheTtlMs"),
  poolScanReuseMs: (v) => _inRange(v, "poolScanReuseMs"),
  rebalancePairingWindowSec: (v) => _inRange(v, "rebalancePairingWindowSec"),
  pricePauseExceptionPollWindowMultiple: (v) =>
    _inRange(v, "pricePauseExceptionPollWindowMultiple"),
  positionBalancedBandPct: (v) => _inRange(v, "positionBalancedBandPct"),
  positionBalancedCooldownMs: (v) => _inRange(v, "positionBalancedCooldownMs"),
  rescanPricesRecentWindowDays: (v) =>
    _inRange(v, "rescanPricesRecentWindowDays"),
  impermanentLossGuardPct: (v) => _inRange(v, "impermanentLossGuardPct"),
  rebalanceOutOfRangeThresholdPercent: (v) =>
    _inRange(v, "rebalanceOutOfRangeThresholdPercent"),
  rebalanceTimeoutMin: (v) => _inRange(v, "rebalanceTimeoutMin"),
  /*-
   *  Exposed via /api/bot-config-defaults so the "Default" button in
   *  Bot Settings can put it in the input; the bot itself does NOT fall
   *  back to this value at rebalance time (an unset width still means
   *  preserveRange()). Full range is its own boolean below, not a
   *  sentinel width.
   */
  rebalanceRangeWidthPct: (v) => _inRange(v, "rebalanceRangeWidthPct"),
  /*- Full-Range rebalance toggle: when true, every rebalance mints at
   *  `MIN_TICK` / `MAX_TICK` regardless of the Price Range Extension
   *  value.  An explicit boolean rather than a sentinel width, because
   *  `rebalanceRangeWidthPct === 100` is also a legal user-chosen width
   *  and the two intents cannot be told apart. */
  fullRangeRebalanceEnabled: (v) => (typeof v === "boolean" ? v : false),
  /*- Range section "No Override" toggle default for a position that has
   *  never been configured.  `false` = re-use the existing on-chain
   *  range; the Range fields are disabled and none of them applies.
   *  See src/lib/range-override.js for the full resolution rule. */
  rangeOverrideEnabled: (v) => (typeof v === "boolean" ? v : false),
  slippagePct: (v) => _inRange(v, "slippagePct"),
  /*-
   *  Per-token slippage overrides. The dashboard also warns past one
   *  figure and asks for a typed confirmation past another (see
   *  src/client/web/dashboard-per-token-slippage.js); neither is a range.
   */
  slippagePctToken0: (v) => _inRange(v, "slippagePctToken0"),
  slippagePctToken1: (v) => _inRange(v, "slippagePctToken1"),
  /*-
   *  How a swap is split when the aggregator refuses it at full size
   *  for its price impact, the least a swap is worth sending, and the
   *  headroom a "raise slippage to" message adds to the impact it saw.
   */
  swapChunkCount: (v) => _inRange(v, "swapChunkCount"),
  minSwapAmountRaw: (v) => _inRange(v, "minSwapAmountRaw"),
  slippageSuggestionMarginPct: (v) =>
    _inRange(v, "slippageSuggestionMarginPct"),
  // The most corrective swaps one rebalance makes after its main swap.
  correctiveSwapMaxRounds: (v) => _inRange(v, "correctiveSwapMaxRounds"),
  /*-
   *  The poll interval becomes a `setTimeout` delay, so its bounds come
   *  from `src/lib/timer-bounds.js` — the same module `.env` asks, because
   *  separate copies of this rule once gave different answers to the
   *  same question.
   *
   *  Lenient HERE, and refused at startup by
   *  `readBotConfigDefaultsStrict` instead. This function runs on every
   *  read, and those include a poll cycle and an HTTP route; throwing
   *  from it would turn an edit made while the bot is running into a
   *  broken poll and a 500.
   */
  checkIntervalSec: (v) => _timerOrNull(v, "checkIntervalSec"),
  minRebalanceIntervalMin: (v) => _inRange(v, "minRebalanceIntervalMin"),
  maxRebalancesPerDay: (v) => _inRange(v, "maxRebalancesPerDay"),
  offsetToken0Pct: (v) => _inRange(v, "offsetToken0Pct"),
  lowGasThresholds: (v) => _normalizeGroup(v, "lowGasThresholds"),
  ilGuardRetry: (v) => _normalizeGroup(v, "ilGuardRetry"),
  residualCleanup: (v) => _normalizeGroup(v, "residualCleanup"),
  throttleDoubling: (v) => _normalizeGroup(v, "throttleDoubling"),
};

/*- The one read of the file, held for the life of the process. */
let _memo = null;

/**
 * Read and parse the Bot Config defaults JSON, stripping `_comment` and
 * `_migration`.  Each known key passes through its normalizer; a value
 * outside its rule falls back to the shipped default for that key.
 *
 * **The file is read once and the answer is kept.** Parsing and merging
 * it costs about 46 microseconds of synchronous file I/O, and callers
 * include a poll cycle and a per-request path, so a reader that went to
 * disk every time would put that I/O in front of the bot's work. Once
 * is also the semantics the file documents: these are operator-tunable
 * plumbing, overridden in `app-config/user-configurable/` and picked up
 * on restart.
 *
 * The result is frozen because every caller now shares one object; a
 * caller that mutated its own copy before would silently change the
 * value every other caller sees.
 *
 * @returns {object}  Defaults object with the same keys as `_FALLBACK`.
 */
function readBotConfigDefaults() {
  if (_memo === null) _memo = Object.freeze(_read({ strict: false }));
  return _memo;
}

/**
 * The same values, but refusing a setting written outside its range
 * rather than quietly standing the shipped default in its place: a timer
 * setting, by the timer rule, and any other setting with a range in
 * setting-bounds.json.
 *
 * **Call this once, at startup, and nowhere else.** `src/lib/config.js` does,
 * and that is the right place: refusing there means the app does not come
 * up on settings nobody chose, which is the whole point — a silently
 * corrected value is the last thing anyone would think to check.
 *
 * The lenient reader is what every other caller wants, because several
 * of them are a poll cycle or an HTTP route. Throwing from those would
 * turn an edit made while the bot is running into a broken poll and a
 * 500.
 *
 * Reads the file itself rather than taking the memo, because the memo
 * may have been filled by a lenient caller that accepted a value this
 * one must refuse. The answer then becomes the memo, so the file is
 * still read once in the ordinary boot order.
 *
 * @returns {object} Same shape as `readBotConfigDefaults`.
 * @throws {Error} Tagged `badTimerValue`, when a timer setting is set
 *   and out of range, or `badSettingValue`, naming every other setting
 *   set outside its range.
 */
function readBotConfigDefaultsStrict() {
  _memo = Object.freeze(_read({ strict: true }));
  return _memo;
}

/** Forget the memo, so the next read goes to disk again (tests only). */
function _resetMemoForTests() {
  _memo = null;
}

function _read({ strict }) {
  try {
    const parsed = loadMergedDefaults(_FILENAME);
    const out = { ..._FALLBACK };
    for (const [key, normalize] of Object.entries(_NORMALIZERS)) {
      const v = normalize(parsed[key]);
      if (v !== null) out[key] = v;
    }
    if (strict) {
      _assertTimerKeys(parsed);
      _assertRangedKeys(parsed, out);
    }
    return out;
  } catch (err) {
    /*-
     *  A value this reader must refuse is not the same as a file it
     *  merely failed to read. Falling back on the first would discard
     *  every other override alongside the bad one, and leave the bot on
     *  settings nobody chose — the thing the checks exist to prevent.
     *  So it propagates; only read and parse failures fall back, which
     *  is what keeps `GET /api/bot-config-defaults` off a 500.
     */
    if (err.badTimerValue || err.badSettingValue) throw err;
    log.warn(
      "[bot-config-defaults] Falling back to built-in defaults: %s",
      err.message,
    );
    return { ..._FALLBACK };
  }
}

module.exports = {
  readBotConfigDefaults,
  readBotConfigDefaultsStrict,
  _resetMemoForTests,
};
