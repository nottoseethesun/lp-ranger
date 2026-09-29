"use strict";

/**
 * @file src/utc-timestamp.js
 * @module utc-timestamp
 * @description
 * The one definition of a log line's timestamp.
 *
 * Two loggers print them — `src/log.js` for the server and
 * `public/dashboard-log.js` for the browser console — and an operator
 * reads both side by side when tracing something through the app. They
 * have to agree on the format down to the character, which two copies
 * of the same function cannot promise.
 *
 * The zone is named in the string rather than left implied. A bare
 * `2026-09-29 07:06:22` is three different instants depending on
 * whether the reader assumes their own clock, the chain's, or the
 * server's, and the operator comparing a log line against a block
 * explorer has no way to tell which was meant.
 *
 * Dependency-free on purpose, so esbuild can bundle it into the browser
 * build — the same constraint `src/pool-key.js` is written to.
 */

/**
 * The zone designator, taken from what a `Date` itself emits.
 *
 * Not written out. A `Date` is an instant and carries no zone, so the
 * decision to render in UTC is ours — but the *name* for that decision
 * need not be. `toISOString` ends with the designator for the zone it
 * rendered in, so reading the last character of one is the platform
 * telling us what it just called that zone.
 *
 * Asking `Intl` instead would only look derived: it requires the zone
 * as input (`timeZone: "UTC"`) and hands the same string back, so the
 * literal would still be ours. Its own zero-offset names are `Z` here
 * and `GMT` from `toUTCString`; neither spells out "UTC".
 */
const UTC_LABEL = new Date(0).toISOString().slice(-1);

/**
 * Regex source matching one timestamp, for the tests and helpers that
 * assert on a log line or strip the prefix from one.
 *
 * Exported so they describe the format by reference rather than
 * restating it: a pattern copied into each file is a second definition
 * that stops matching the first without anything failing to say so.
 */
const UTC_TIMESTAMP_PATTERN = `\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}${UTC_LABEL}`;

/**
 * The current instant as `YYYY-MM-DD HH:MM:SSZ`.
 *
 * Every part comes from the `Date`'s own canonical rendering —
 * `2026-09-29T07:06:22.000Z` — with the `T` traded for a space and the
 * milliseconds dropped, both of which cost a log line width for
 * nothing. The trailing designator is the one the `Date` emitted, so
 * the zone in the string is the zone that produced the digits rather
 * than a separate claim about them.
 *
 * @param {Date} [now]  The instant to format; defaults to this one.
 * @returns {string}
 */
function utcTimestamp(now) {
  const iso = (now instanceof Date ? now : new Date()).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${iso.slice(-1)}`;
}

module.exports = { UTC_LABEL, UTC_TIMESTAMP_PATTERN, utcTimestamp };
