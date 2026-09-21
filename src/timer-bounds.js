/**
 * @file src/timer-bounds.js
 * @module timerBounds
 * @description
 * The one place that decides whether a configured number of seconds may
 * become a `setTimeout` or `setInterval` delay.
 *
 * **Why a shared module rather than a check at each entry point.** A
 * value reaches a timer by more than one road: `.env` and
 * `app-runtime.json` at startup, and `POST /api/config` at runtime, via
 * a per-position `checkIntervalSec` the poll cycle re-reads. Two copies
 * of this rule would drift, and the half that drifted would be the half
 * nobody tested — while the symptom, described below, looks nothing
 * like a settings problem.
 *
 * **What is actually being guarded.** A timer holds its delay as a
 * 32-bit count of milliseconds, about 24.8 days. Asked for longer it
 * does not wait longer: it warns and fires after 1 ms. `NaN` is treated
 * the same way, and no downstream floor rescues it — `Math.max(10000,
 * NaN)` is `NaN`. So an out-of-range setting does not make the bot slow,
 * it makes it instant: a pending transaction replaced a millisecond
 * after it is sent, a poll loop with no gap between polls. That reads as
 * a bug in the rebalancer rather than as a number somebody typed, which
 * is why these values are refused rather than quietly corrected.
 *
 * **Why the reason is returned, not thrown.** The two callers need
 * different shapes. `src/config.js` refuses to start, so it throws.
 * `POST /api/config` answers 400 and keeps serving. Both want the same
 * sentence.
 */

"use strict";

/*- Ceiling over every timer setting, whatever its default.
 *
 *  Two days is past anything these settings are for, and it is also
 *  what keeps them clear of the runtime's own limit: 48 hours is
 *  172,800,000 ms against a limit of 2,147,483,647, an order of
 *  magnitude inside it, with no arithmetic needed to see that.
 *
 *  Taking the LESSER of this and 1000x the default is what guarantees
 *  it. The greater would not: 1000x `TX_CANCEL_SEC`'s hour is 41 days,
 *  past the limit. */
const TIMER_CEILING_CAP_SEC = 48 * 60 * 60;

/**
 * The ceiling for a setting whose shipped default is `fallbackSec`:
 * 1000x that default, or 48 hours, whichever is lesser.
 * @param {number} fallbackSec
 * @returns {number} Seconds.
 */
function timerCeilingSec(fallbackSec) {
  return Math.min(fallbackSec * 1000, TIMER_CEILING_CAP_SEC);
}

/**
 * Why `sec` cannot serve as a timer delay, or `null` when it can.
 *
 * The sentence names the setting, what it resolved to, and the bound
 * that actually produced its ceiling — saying "1000x the default" when
 * 48 hours is what bound it reads as arithmetic that does not add up,
 * and it reads worst in the case that needs the clearest message: a
 * default derived from other settings, where the value being refused is
 * one nobody typed.
 *
 * The caller appends its own remedy, since what to do about it differs
 * by where the value came from.
 *
 * @param {*} sec             The resolved value, in seconds.
 * @param {number} fallbackSec The shipped default, which sets the ceiling.
 * @param {string} name       Setting name, for the message.
 * @returns {string|null}
 */
function timerSecProblem(sec, fallbackSec, name) {
  /*- Checked before the ceiling, so a negative is reported as what it
   *  is: the ceiling of a negative default is itself negative, and
   *  checking that first would call -60 "above its ceiling of
   *  -60000". */
  if (!Number.isInteger(sec) || sec < 1) {
    return (
      `${name} resolves to ${String(sec)}, which is not a whole number ` +
      `of seconds of at least 1.`
    );
  }
  const ceilingSec = timerCeilingSec(fallbackSec);
  if (sec > ceilingSec) {
    const bound =
      ceilingSec === TIMER_CEILING_CAP_SEC
        ? "48 hours"
        : `1000x its default of ${fallbackSec}`;
    return (
      `${name} resolves to ${sec} seconds, above its ceiling of ` +
      `${ceilingSec} (${bound}).`
    );
  }
  return null;
}

module.exports = { TIMER_CEILING_CAP_SEC, timerCeilingSec, timerSecProblem };
