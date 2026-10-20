"use strict";

/**
 * @file util/bookkeeping/coins-in-transactions-on-wallet/dates.js
 * @description
 * The calendar side of a wallet's bookkeeping report: reading the dates
 * and the time zone the operator names, turning a range of whole days in
 * that zone into the instants it starts and ends, and writing an instant
 * as that zone's wall clock. Node's own `Intl` knows every IANA time zone
 * and its daylight-saving rules, so the report needs nothing installed for
 * them.
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
 * Accept an IANA time zone name, such as America/Chicago, or reject it
 * naming the option. `Intl` refuses a name it does not know.
 * @param {string} value  The raw option value.
 * @returns {string}  The same value.
 * @throws {InvalidArgumentError} When it is not a time zone.
 */
function parseTimeZone(value) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new InvalidArgumentError(`not a time zone: ${value}`);
  }
  return value;
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

module.exports = {
  parseDate,
  parseTimeZone,
  localTimeZone,
  offsetAt,
  midnightIn,
  nextDay,
  rangeIn,
  formatIn,
};
