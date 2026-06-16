/**
 * @file public/dashboard-log.js
 * @description Browser-side mirror of `src/log.js`.  Opt-in logger that
 *   prefixes every line with a UTC timestamp via thin wrappers around
 *   `console.log` / `info` / `warn` / `error` / `debug` — **never
 *   modifies the standard `console` object itself**.
 *
 * Usage:
 *
 *   import { log } from "./dashboard-log.js";
 *   log.info("[poll] tick", n);
 *   // → [poll] [2026-06-16 20:32:02] tick 5
 */

"use strict";

function _utcTimestamp() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

/*- Skip leading ANSI CSI escapes (`\x1b[<params>m`).  Devtools strips
 *  these from display but pre-color-wrapped banners can still arrive
 *  with them prefixed (e.g. shared format strings between server and
 *  dashboard). */
function _skipAnsi(s, start) {
  let i = start;
  while (s.startsWith("\x1b[", i)) {
    const m = s.indexOf("m", i + 2);
    if (m < 0) break;
    i = m + 1;
  }
  return i;
}

function _withTimestamp(first) {
  if (typeof first !== "string") return first;
  const ts = _utcTimestamp();
  const tagStart = _skipAnsi(first, 0);
  if (first.charCodeAt(tagStart) !== 0x5b /* [ */) return `[${ts}] ${first}`;
  const closeIdx = first.indexOf("]", tagStart);
  if (closeIdx < 0 || closeIdx - tagStart > 80) return `[${ts}] ${first}`;
  const head = first.slice(0, closeIdx + 1);
  const tail = first.slice(closeIdx + 1);
  return `${head} [${ts}]${tail}`;
}

export const log = {
  info: (first, ...rest) => console.log(_withTimestamp(first), ...rest),
  warn: (first, ...rest) => console.warn(_withTimestamp(first), ...rest),
  error: (first, ...rest) => console.error(_withTimestamp(first), ...rest),
  debug: (first, ...rest) => console.debug(_withTimestamp(first), ...rest),
};
