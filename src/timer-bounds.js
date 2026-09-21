/**
 * @file src/timer-bounds.js
 * @module timerBounds
 * @description
 * The bounds on every configured number of seconds that becomes a
 * `setTimeout` or `setInterval` delay, and the check against them.
 *
 * **Why one module.** Such a value arrives by three roads, and an
 * operator may reasonably take any of them: the shipped-defaults JSON
 * under `app-config/user-configurable/`, `.env`, and the dashboard's
 * Bot Settings form via `POST /api/config`. Three copies of the rule
 * gave three different answers to the same question.
 *
 * **Why it throws.** A value silently replaced by a default leaves the
 * bot running on a schedule nobody chose, and the schedule is then the
 * last thing anyone would think to check. `POST /api/config` catches
 * the throw and answers 400; startup lets it stop the process.
 *
 * **Why the bounds are written down rather than calculated.** A maximum
 * derived from other configuration is only as sound as the numbers it
 * is derived from, and those come from files an operator can edit. Each
 * setting states its own range here instead.
 *
 * The ceiling every maximum stays under is the runtime's: a timer holds
 * its delay as a 32-bit count of milliseconds, 2,147,483,647 of them,
 * about 24.8 days. Asked for longer it does not wait longer — it warns
 * and fires after 1 ms, and `NaN` behaves the same way. So an unbounded
 * setting does not make the bot slow, it makes it instant: a
 * transaction replaced a millisecond after it is sent, a poll loop with
 * no gap between polls.
 */

"use strict";

/*- Every setting that becomes a timer delay, and its range in seconds.
 *
 *  `checkIntervalSec` — ten seconds is as often as it is worth asking a
 *  chain, and an hour between looks at a position is already past any
 *  use.
 *  `txSpeedupSec` — an unconfirmed transaction waits at most this long
 *  before a replacement goes out. An hour is generous.
 *  `txCancelSec` — total wait before the stuck nonce is freed. Two days
 *  is far past any congestion worth sitting out, and well inside the
 *  24.8 days a timer can hold. */
const BOUNDS_SEC = Object.freeze({
  checkIntervalSec: Object.freeze({ min: 10, max: 3600 }),
  txSpeedupSec: Object.freeze({ min: 1, max: 3600 }),
  txCancelSec: Object.freeze({ min: 1, max: 172_800 }),
});

/**
 * Accept `sec` as a timer delay, or throw explaining why not.
 *
 * @param {object} o
 * @param {*} o.sec       The resolved value, in seconds.
 * @param {string} o.key  Which setting, keying the table above.
 * @param {string} [o.label] How to name it in the message, when the
 *   operator knows it by another spelling — `CHECK_INTERVAL_SEC` in
 *   `.env`, for one. Defaults to `key`.
 * @param {string} [o.remedy] Where to change it, appended to the message.
 * @returns {number} `sec`, unchanged, when it is in range.
 * @throws {Error} Tagged `badTimerValue` so a caller can tell a rejected
 *   value from a failure to read the file it came from.
 */
function assertTimerSec({ sec, key, label, remedy }) {
  const name = label || key;
  const range = BOUNDS_SEC[key];
  if (!range) {
    throw _badTimerValue(`${name} has no declared range in timer-bounds.js.`);
  }
  if (!Number.isInteger(sec) || sec < range.min || sec > range.max) {
    throw _badTimerValue(
      `${name} resolves to ${String(sec)}. It must be a whole number of ` +
        `seconds from ${range.min} to ${range.max}.`,
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
