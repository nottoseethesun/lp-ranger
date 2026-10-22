"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/dates.js
 * @description
 * The calendar side of a wallet's bookkeeping report: the time zones it
 * takes, reading the dates and the time zone the operator names, turning
 * a range of whole days in that zone into the instants it starts and ends,
 * and writing an instant as that zone's wall clock. Node's own `Intl` holds
 * the IANA time zone database and its daylight-saving rules, so the report
 * needs nothing installed for them.
 */

const { InvalidArgumentError } = require("commander");

/** A calendar date as the options take it. */
const DATE_FORM = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Accept a calendar date written YYYY-MM-DD, or reject it naming the
 * option. A date that does not exist, such as 2026-02-30, is refused.
 * @param {string} value  The raw option value.
 * @returns {string}  The same value.
 * @throws {InvalidArgumentError} When it is not a real date in that form.
 */
function parseDate(value) {
  const match = DATE_FORM.exec(value);
  if (match !== null) {
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.toISOString().slice(0, 10) === value) return value;
  }
  throw new InvalidArgumentError(`not a date written YYYY-MM-DD: ${value}`);
}

/**
 * Every time zone a report takes, sorted: the names Node's time zone
 * database lists (`Intl.supportedValuesOf`), each a region such as
 * America/Chicago, and UTC, which that list leaves out. A designation such
 * as CDT is not among them: one can name several clocks (CST is US
 * Central, China and Cuba Standard Time), and each of a report's days must
 * start at one known midnight. `Intl` itself would let some through, the
 * legacy EST among them, so the report checks names against this list,
 * never against `Intl`.
 * @returns {string[]}
 */
function validTimeZones() {
  return [...Intl.supportedValuesOf("timeZone"), "UTC"].sort();
}

/** Each valid time zone, by its name in lower case. */
const VALID_BY_LOWER_CASE = new Map(
  validTimeZones().map((zone) => [zone.toLowerCase(), zone]),
);

/**
 * Whether a name is on the list of valid time zones, in any letter case.
 * @param {string} name
 * @returns {boolean}
 */
function isValidTimeZone(name) {
  return VALID_BY_LOWER_CASE.has(name.toLowerCase());
}

/**
 * Accept a time zone from the valid list, in any letter case, or reject it
 * naming the option and the way to see the list.
 * @param {string} value  The raw option value.
 * @returns {string}  The zone as the list spells it.
 * @throws {InvalidArgumentError} When it is not on the list.
 */
function parseTimeZone(value) {
  const zone = VALID_BY_LOWER_CASE.get(value.toLowerCase());
  if (zone !== undefined) return zone;
  throw new InvalidArgumentError(
    `not a valid time zone: ${value}. Run with --list-valid-timezones ` +
      "to see every valid one.",
  );
}

/**
 * The time zone this computer is set to, offered when none is given.
 * @returns {string}  An IANA time zone name.
 */
function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A time zone's wall clock at an instant, each part zero-padded.
 * @param {number} ms  The instant, in milliseconds since 1970 (UTC).
 * @param {string} timeZone  An IANA time zone name.
 * @returns {{year: string, month: string, day: string, hour: string,
 *   minute: string, second: string}}
 */
function wallClock(ms, timeZone) {
  const parts = Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const part = (type) => parts.find((p) => p.type === type).value;
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/**
 * How far a time zone's clocks are ahead of UTC at an instant: its wall
 * clock read as if it were UTC, less the instant itself.
 * @param {number} ms  The instant, in milliseconds since 1970 (UTC).
 * @param {string} timeZone  An IANA time zone name.
 * @returns {number}  Milliseconds; negative west of Greenwich.
 */
function offsetAt(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  const asIfUtc = Date.UTC(
    Number(w.year),
    Number(w.month) - 1,
    Number(w.day),
    Number(w.hour),
    Number(w.minute),
    Number(w.second),
  );
  return asIfUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a date's first moment falls at in a time zone. The zone's
 * offset is read first at a guess and then at the answer itself, so a
 * date whose clocks change during the night still lands on its own
 * midnight.
 * @param {string} date  YYYY-MM-DD.
 * @param {string} timeZone  An IANA time zone name.
 * @returns {number}  Milliseconds since 1970 (UTC).
 */
function midnightIn(date, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day);
  const guess = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(guess, timeZone);
}

/**
 * The day after a date.
 * @param {string} date  YYYY-MM-DD.
 * @returns {string}  YYYY-MM-DD.
 */
function nextDay(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * The span of time a report covers: from the first moment of its first
 * day to the first moment of the day after its last, in the time zone.
 * @param {string} startDate  The first day, YYYY-MM-DD.
 * @param {string} endDate    The last day, YYYY-MM-DD, included.
 * @param {string} timeZone   An IANA time zone name.
 * @returns {{startMs: number, endMs: number}}  `endMs` itself is outside.
 */
function rangeIn(startDate, endDate, timeZone) {
  return {
    startMs: midnightIn(startDate, timeZone),
    endMs: midnightIn(nextDay(endDate), timeZone),
  };
}

/**
 * An instant as a time zone's wall clock.
 * @param {number} ms  Milliseconds since 1970 (UTC).
 * @param {string} timeZone  An IANA time zone name.
 * @returns {string}  YYYY-MM-DD HH:MM:SS.
 */
function formatIn(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  return `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}:${w.second}`;
}

/** Milliseconds in a UTC day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The day before a date.
 * @param {string} date  YYYY-MM-DD.
 * @returns {string}  YYYY-MM-DD.
 */
function previousDay(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * The moment a day in a time zone becomes whole: the first UTC midnight
 * at or after its end. A price is kept for a UTC day, and a UTC day's
 * closing price is known only once that day has ended. So a day in a zone
 * west of Greenwich, whose last hours fall on the next UTC day, waits for
 * that UTC day to end too.
 * @param {string} date  YYYY-MM-DD.
 * @param {string} timeZone  An IANA time zone name.
 * @returns {number}  Milliseconds since 1970 (UTC).
 */
function wholeFrom(date, timeZone) {
  const end = midnightIn(nextDay(date), timeZone);
  return Math.ceil(end / DAY_MS) * DAY_MS;
}

/**
 * The last whole day in a time zone at a moment: the last day that ended,
 * along with the UTC day of its last hour, before the moment's UTC day
 * began. The day holding the moment just before that UTC midnight is
 * whole only when it ends exactly there; otherwise the day before it is
 * the last.
 * @param {number} nowMs  The moment, in milliseconds since 1970 (UTC).
 * @param {string} timeZone  An IANA time zone name.
 * @returns {string}  YYYY-MM-DD.
 */
function lastWholeDay(nowMs, timeZone) {
  const utcDayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const w = wallClock(utcDayStart - 1, timeZone);
  const date = `${w.year}-${w.month}-${w.day}`;
  return wholeFrom(date, timeZone) <= utcDayStart ? date : previousDay(date);
}

module.exports = {
  parseDate,
  validTimeZones,
  isValidTimeZone,
  parseTimeZone,
  localTimeZone,
  offsetAt,
  midnightIn,
  nextDay,
  previousDay,
  rangeIn,
  formatIn,
  wholeFrom,
  lastWholeDay,
};
