/**
 * @file public/dashboard-log.js
 * @description Browser-side mirror of `src/log.js`.  Opt-in logger that
 *   prefixes every line with `[lp-ranger]` (app scope) and a UTC
 *   timestamp via thin wrappers around `console.log` / `info` / `warn`
 *   / `error` / `debug` — **never modifies the standard `console`
 *   object itself**.
 *
 * Output shape, uniform across every call site:
 *
 *   [lp-ranger] [<subscope>] [<timestamp>] <message>
 *   [lp-ranger] [<timestamp>] <message>                   (no subscope)
 *
 * Always-first `[lp-ranger]` is required because the browser console
 * mixes logs from extensions, iframes, and other apps — the prefix
 * lets the user filter LP Ranger's stream cleanly.  Timestamp is
 * always LAST in the prefix group (after every consecutive `[tag]`)
 * so app, subscope, and time read left-to-right: app → feature → when
 * → message.
 *
 * Two transparent fix-ups handle the call sites that don't already
 * start with `[lp-ranger]`:
 *
 *   1. Leading ANSI CSI escape sequences (`\x1b[...m`) are skipped
 *      when scanning for the tag.  Some shared format strings retain
 *      server-style color wrapping.
 *   2. Leading `%c<spec>` console-style directives are skipped — most
 *      dashboard logs use `%c[lp-ranger] [poll] ...` so the first
 *      bytes are `%c`, not `[`.  Without skipping, the scanner would
 *      miss the tag and prepend the timestamp.
 *
 * What the logger CANNOT auto-fix: format strings that defer the tag
 * to a `%s` substitution (e.g. `log.info("%s msg", NS)`).  The
 * substituted value isn't visible at format-string-parse time, so
 * call sites using that pattern must inline the namespace via
 * template literal: `` log.info(`${NS} msg`) `` — see
 * `dashboard-unlock-log.js` for the reference fix.
 *
 * Usage:
 *
 *   import { log } from "./dashboard-log.js";
 *   log.info("[poll] tick", n);
 *   // → [lp-ranger] [poll] [2026-06-19 23:13:29] tick 5
 */

"use strict";

const APP_TAG = "[lp-ranger]";
/*- Treat any first tag whose text starts with `[lp-ranger` as
 *  "already prefixed".  Covers both the bare `[lp-ranger]` and the
 *  startup banner's `[lp-ranger app]` so the banner doesn't end up
 *  with a stuttering `[lp-ranger] [lp-ranger app]`. */
const APP_TAG_PREFIX = "[lp-ranger";

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

/*- Skip leading ANSI CSI escapes (`\x1b[<params>m`).  DevTools strips
 *  these from display, but pre-color-wrapped banners can still arrive
 *  with them prefixed (shared format strings between server and
 *  dashboard).  Returns the index of the first non-escape byte. */
function _skipAnsi(s, start) {
  let i = start;
  while (s.startsWith("\x1b[", i)) {
    const m = s.indexOf("m", i + 2);
    if (m < 0) break;
    i = m + 1;
  }
  return i;
}

/*- Skip leading console-style directives.  Only `%c` is skipped
 *  (consumes one style-string argument; produces no output content
 *  itself).  Other format specifiers (`%s`, `%d`, `%i`, `%f`, `%o`,
 *  `%O`) substitute values into the rendered output and so cannot be
 *  safely skipped — their substituted value WOULD become visible
 *  content at that position. */
function _skipStyleDirectives(s, start) {
  let i = start;
  while (
    s.charCodeAt(i) === 0x25 /* % */ &&
    s.charCodeAt(i + 1) === 0x63 /* c */
  ) {
    i += 2;
  }
  return i;
}

/*- Combined skip: ANSI escapes interleaved with %c directives.  In
 *  practice only one or the other appears, but applying both in a
 *  loop keeps the scanner robust against future format combinations. */
function _skipFormatNoise(s, start) {
  let i = start;
  for (;;) {
    const after = _skipStyleDirectives(s, _skipAnsi(s, i));
    if (after === i) return i;
    i = after;
  }
}

/*- Advance past all consecutive `[tag]` segments starting at `i`,
 *  including the single space separator between tags and (optionally)
 *  the trailing space after the last tag.  Each tag is bounded by
 *  80 chars to guard against runaway scans on text that happens to
 *  contain `[` but no matching `]`.  Returns
 *  `{ endOfTags, hasAppTag }` where `endOfTags` points at the first
 *  byte AFTER the trailing-space separator (so it's the start of the
 *  message body), and `hasAppTag` is true when the FIRST tag's text
 *  starts with `APP_TAG_PREFIX`. */
function _scanTags(s, i) {
  let hasAppTag = false;
  let firstTag = true;
  let pos = i;
  while (s.charCodeAt(pos) === 0x5b /* [ */) {
    const closeIdx = s.indexOf("]", pos);
    if (closeIdx < 0 || closeIdx - pos > 80) break;
    if (firstTag) {
      const tagText = s.slice(pos, closeIdx + 1);
      if (tagText.startsWith(APP_TAG_PREFIX)) hasAppTag = true;
      firstTag = false;
    }
    pos = closeIdx + 1;
    /*- Eat one space separator between tags (or after the last tag
     *  before the message body). */
    if (s.charCodeAt(pos) === 0x20 /* space */) pos += 1;
  }
  return { endOfTags: pos, hasAppTag };
}

/*- Compose the rewritten format string.
 *  `head` = bytes 0..i (ANSI + %c noise we preserved verbatim).
 *  `tagsSection` = the consecutive `[tag]` block (may be empty).
 *  `body` = the rest of the message. */
function _composeOutput(s, i, endOfTags, hasAppTag, ts) {
  const head = s.slice(0, i);
  if (endOfTags === i) {
    /*- No tags at all — emit `[lp-ranger] [ts] <body>` (the auto-
     *  prefix is always required for browser logs). */
    return head + APP_TAG + ` [${ts}] ` + s.slice(i);
  }
  const tagsSection = s.slice(i, endOfTags);
  const body = s.slice(endOfTags);
  const prefix = hasAppTag ? "" : APP_TAG + " ";
  return head + prefix + tagsSection + `[${ts}] ` + body;
}

/**
 * Inject `[lp-ranger]` and `[timestamp]` into a log format string per
 * the rules described in the file-header.  Non-string first args pass
 * through untouched (so callers can `log.error(err)` with an Error
 * object and not lose the original).
 *
 * @param {*} first  The first argument passed to a `log.*` method.
 * @returns {*} The rewritten format string, or `first` unchanged if
 *   it isn't a string.
 */
function _withTimestamp(first) {
  if (typeof first !== "string") return first;
  const ts = _utcTimestamp();
  const i = _skipFormatNoise(first, 0);
  const { endOfTags, hasAppTag } = _scanTags(first, i);
  return _composeOutput(first, i, endOfTags, hasAppTag, ts);
}

export const log = {
  info: (first, ...rest) => console.log(_withTimestamp(first), ...rest),
  warn: (first, ...rest) => console.warn(_withTimestamp(first), ...rest),
  error: (first, ...rest) => console.error(_withTimestamp(first), ...rest),
  debug: (first, ...rest) => console.debug(_withTimestamp(first), ...rest),
};

/*- Exports below are test-only.  Production code uses `log.*`. */
export {
  _withTimestamp,
  _utcTimestamp,
  _scanTags,
  _skipFormatNoise,
  APP_TAG,
  APP_TAG_PREFIX,
};
