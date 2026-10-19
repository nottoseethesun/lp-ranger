/**
 * @file src/timer-bounds.js
 * @module timerBounds
 * @description
 * The one place that decides whether a configured number of seconds may
 * become a `setTimeout` or `setInterval` delay.
 *
 * **Why one module.** Such a value arrives by two roads, and an operator
 * may take either: a JSON file under
 * `app-config/app-defaults-for-user-configurable/` with the operator's
 * copy under `app-config/user-configurable/`, and `.env`. No dashboard
 * field sets one. Three copies of the rule once gave three different
 * answers to the same question — a poll interval of two hours was
 * silently discarded on one road and accepted on the others. One
 * module, one answer.
 *
 * **Why it throws.** A value silently replaced by a default leaves the
 * bot running on a schedule nobody chose, and the schedule is then the
 * last thing anyone would think to check. At startup the throw stops the
 * app, naming the setting; after startup the lenient reader of
 * bot-config-defaults.json catches it and keeps the shipped default.
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

const { SETTING_BOUNDS } = require("./setting-bounds");

/*-
 *  The rule's figures, from setting-bounds.json → timers: the least a
 *  timer setting may be, how far above its own shipped default it may be
 *  set, and the ceiling over any of them whatever its default. The
 *  ceiling and the multiple combine by taking the LESSER. The greater
 *  would not do: 1000x `txCancelSec`'s hour is 41 days, past the limit
 *  above.
 *
 *  `settings` holds the ranges a setting declares for itself, where its
 *  own sensible range differs from the general rule: declared once,
 *  rather than at each of the three call sites, which is how they came
 *  to disagree in the first place.
 */
const _TIMERS = SETTING_BOUNDS.timers;

/**
 * The least and the most a timer setting may be, in its own unit: the
 * rule `assertTimerSec` enforces, given out so a settings file's schema
 * can carry the same figures (src/settings-file-rules.js).
 *
 * @param {object} o
 * @param {string} o.key  Canonical setting name, e.g. `checkIntervalSec`;
 *   a name ending in "ms" is milliseconds, any other seconds.
 * @param {number} [o.defaultSec]  Shipped default, which sets the general
 *   ceiling at 1000x itself. Left out for a value that has none, such as
 *   a timer of a chain an operator adds: what such a value is bounded by
 *   is the 48-hour ceiling and any range of its own.
 * @returns {{min: number, max: number, unit: string}}
 */
function timerRange({ key, defaultSec }) {
  const explicit = _TIMERS.settings[key];
  const min =
    typeof explicit?.min === "number" ? explicit.min : _TIMERS.minimum;
  /*-
   *  The cap is the LESSER of 48 hours and 1000x the default; this is
   *  the 48-hour half of it, expressed in whatever unit the setting
   *  uses. The key name says which: a name ending in "ms" is
   *  milliseconds, anything else seconds. Matched without regard to
   *  case because this file spells it both ways —
   *  `rpcAllEndpointsDownPauseMS` beside `priceCacheTtlMs` — and
   *  reading one of those as seconds would put this half a thousand
   *  times too low without saying so. The messages below name the same
   *  unit.
   */
  const inMs = /ms$/i.test(key);
  const capSec = _TIMERS.maxHours * 60 * 60;
  const max = Math.min(
    defaultSec === undefined
      ? Infinity
      : defaultSec * _TIMERS.maxDefaultMultiple,
    inMs ? capSec * 1000 : capSec,
    typeof explicit?.max === "number" ? explicit.max : Infinity,
  );
  return { min, max, unit: inMs ? "milliseconds" : "seconds" };
}

/**
 * Accept `sec` as a timer delay, or throw explaining why not.
 *
 * @param {object} o
 * @param {*} o.sec          The resolved value: seconds, or milliseconds
 *   for a key whose name ends in "ms".
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
  const { min: minSec, max: maxSec, unit } = timerRange({ key, defaultSec });
  /*- Checked before the ceiling, so a negative is reported as what it
   *  is: the ceiling of a negative default is itself negative, and
   *  checking that first would call -60 "above its maximum of
   *  -60000". */
  if (!Number.isInteger(sec) || sec < minSec) {
    throw _badTimerValue(
      `${name} resolves to ${String(sec)}, which is not a whole number of ` +
        `${unit} of at least ${minSec}.`,
      remedy,
    );
  }
  if (sec > maxSec) {
    throw _badTimerValue(
      `${name} resolves to ${sec} ${unit}, above its maximum of ${maxSec}.`,
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

module.exports = { assertTimerSec, timerRange };
