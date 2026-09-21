/**
 * @file src/timer-bounds.js
 * @module timerBounds
 * @description
 * The one place that decides whether a configured number of seconds may
 * become a `setTimeout` or `setInterval` delay.
 *
 * **Why one module.** Such a value arrives by three roads, and an
 * operator may reasonably take any of them: the shipped-defaults JSON
 * under `app-config/user-configurable/`, `.env`, and the dashboard's
 * Bot Settings form via `POST /api/config`. Three copies of the rule
 * meant three different answers to the same question — a poll interval
 * of two hours was silently discarded on one road and accepted on the
 * other two. One module, one answer.
 *
 * **Why it throws.** A value silently replaced by a default leaves the
 * bot running on a schedule nobody chose, and the schedule is then the
 * last thing anyone would think to check. Callers that cannot carry on
 * let the throw stop them; `POST /api/config` catches it and answers
 * 400, so the dashboard can say what was wrong.
 *
 * **What the ceilings are protecting.** A timer holds its delay as a
 * 32-bit count of milliseconds, about 24.8 days. Asked for longer it
 * does not wait longer: it warns and fires after 1 ms. `NaN` behaves
 * the same way, and no downstream floor rescues it —
 * `Math.max(10000, NaN)` is `NaN`. An out-of-range setting therefore
 * does not make the bot slow, it makes it instant: a transaction
 * replaced a millisecond after it is sent, a poll loop with no gap
 * between polls.
 */

"use strict";

/*- Ceiling over any timer setting, whatever its default.  Two days is
 *  past anything these settings are for, and it keeps them clear of the
 *  runtime limit above: 48 hours is 172,800,000 ms against a limit of
 *  2,147,483,647, an order of magnitude inside it.
 *
 *  Combined with 1000x the default by taking the LESSER. The greater
 *  would not do: 1000x `txCancelSec`'s hour is 41 days, past the
 *  limit. */
const GENERAL_CAP_SEC = 48 * 60 * 60;

/*- How far above its own shipped default a timer setting may be set. */
const MAX_DEFAULT_MULTIPLE = 1000;

/*- Settings whose own sensible range is narrower than the general rule
 *  produces. The poll interval is the one that has such a range: an
 *  hour between looks at a position is already far beyond any use, and
 *  ten seconds is as often as it is worth asking a chain. Declared here
 *  rather than at each of the three call sites, which is how they came
 *  to disagree in the first place. */
const EXPLICIT_BOUNDS_SEC = Object.freeze({
  checkIntervalSec: Object.freeze({ min: 10, max: 3600 }),
  /*- Both of these take 0 to mean "off" — no pacing, no outage pause. */
  globalRPCRequestRateIntervalMS: Object.freeze({ min: 0 }),
  rpcAllEndpointsDownPauseMS: Object.freeze({ min: 0 }),
});

/**
 * Accept `sec` as a timer delay, or throw explaining why not.
 *
 * @param {object} o
 * @param {*} o.sec          The resolved value, in seconds.
 * @param {string} o.key     Canonical setting name, e.g. `checkIntervalSec`.
 *   Selects any explicit bounds declared above.
 * @param {number} o.defaultSec  Shipped default, which sets the general
 *   ceiling at 1000x itself.
 * @param {string} [o.label] How to name the setting in the message, when
 *   the operator knows it by another spelling — `CHECK_INTERVAL_SEC` in
 *   `.env`, for one. Defaults to `key`.
 * @param {string} [o.remedy] Where to change it, appended to the message.
 * @returns {number} `sec`, unchanged, when it is acceptable.
 * @throws {Error} Tagged `badTimerValue` so a caller can tell a rejected
 *   value from a failure to read the file it came from.
 */
function assertTimerSec({ sec, key, defaultSec, label, remedy }) {
  const name = label || key;
  /*- The maximum is derived from `defaultSec`, so a broken one does not
   *  weaken the maximum — it removes it. `Math.min(NaN, …)` is `NaN`,
   *  and `x > NaN` is false, so every value would pass, including past
   *  the explicit maximum a setting declares for itself. Reachable: the
   *  shipped default for `txSpeedupSec` is read raw from
   *  `app-runtime.json`, so an operator who mistypes it there and sets
   *  a large `.env` override would get the override accepted.
   *
   *  A broken shipped default is an install problem rather than an
   *  operator typo, so it says so. */
  if (typeof defaultSec !== "number" || !Number.isFinite(defaultSec)) {
    throw _badTimerValue(
      `${name} cannot be bounded: its shipped default is ` +
        `${String(defaultSec)}, not a number. The install's JSON defaults ` +
        `are wrong, not the value you set.`,
      remedy,
    );
  }
  const explicit = EXPLICIT_BOUNDS_SEC[key];
  const minSec = explicit && explicit.min !== undefined ? explicit.min : 1;
  /*- The cap is 48 hours expressed in whatever unit this setting uses.
   *  Keys ending in MS are milliseconds; the rest are seconds. */
  const cap = key.endsWith("MS") ? GENERAL_CAP_SEC * 1000 : GENERAL_CAP_SEC;
  const maxSec = Math.min(
    defaultSec * MAX_DEFAULT_MULTIPLE,
    cap,
    explicit && explicit.max !== undefined ? explicit.max : Infinity,
  );
  /*- Checked before the ceiling, so a negative is reported as what it
   *  is: the ceiling of a negative default is itself negative, and
   *  checking that first would call -60 "above its maximum of
   *  -60000". */
  if (!Number.isInteger(sec) || sec < minSec) {
    throw _badTimerValue(
      `${name} resolves to ${String(sec)}, which is not a whole number of ` +
        `seconds of at least ${minSec}.`,
      remedy,
    );
  }
  if (sec > maxSec) {
    throw _badTimerValue(
      `${name} resolves to ${sec} seconds, above its maximum of ${maxSec}.`,
      remedy,
    );
  }
  return sec;
}

/*- Tagged so `readBotConfigDefaults` can tell a value it must refuse
 *  from a file it merely failed to read: the second falls back to the
 *  shipped defaults, the first must not. */
function _badTimerValue(message, remedy) {
  const err = new Error(remedy ? `${message} ${remedy}` : message);
  err.badTimerValue = true;
  return err;
}

module.exports = { assertTimerSec };
