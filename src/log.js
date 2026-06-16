/**
 * @file src/log.js
 * @module log
 * @description
 * Opt-in logger that prefixes every line with a UTC timestamp.  Provides
 * `log.info` / `log.warn` / `log.error` as thin wrappers around the
 * matching `console` methods — **never modifies the standard `console`
 * object itself**.  Modules that want timestamped output import this
 * module explicitly; everything else logs through `console` unchanged.
 *
 * Format
 * ──────
 * When the first argument is a string starting with a `[tag]` prefix,
 * the timestamp is injected immediately after the tag:
 *
 *   log.info("[bot] OOR but within 5% threshold")
 *   → [bot] [2026-06-16 20:32:02] OOR but within 5% threshold
 *
 * When the first argument doesn't start with a `[`, the timestamp is
 * prepended bare:
 *
 *   log.info("plain text") → [2026-06-16 20:32:02] plain text
 *
 * Non-string first arguments pass through untouched — `printf`-style
 * extra args after the format string are forwarded as-is so existing
 * `%s` / `%d` substitution semantics still work.
 *
 * Idempotency: `log.info` is a normal function, not a global patch, so
 * there is no install step and no risk of double-wrapping.
 */

"use strict";

/** Format the current instant as `YYYY-MM-DD HH:MM:SS` in UTC. */
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

/*- Skip any leading ANSI CSI escape sequences (`\x1b[<params>m`) so a
 *  color-wrapped tag like `"\x1b[30;47m[lp-ranger server]\x1b[0m hi"`
 *  is treated as starting with `[lp-ranger server]`, not with the
 *  escape's own `[`.  Returns the index of the first non-escape byte. */
function _skipAnsi(s, start) {
  let i = start;
  while (s.startsWith("\x1b[", i)) {
    const m = s.indexOf("m", i + 2);
    if (m < 0) break;
    i = m + 1;
  }
  return i;
}

/*- Inject the timestamp after the first `[...]` prefix when the first
 *  arg is a tagged-prefix string (possibly preceded by ANSI color
 *  escapes); otherwise prepend a bare timestamp.  Bails on non-string
 *  first args (`fmt` may be an object/Error from a one-arg
 *  `log.error(err)` call site) and on lines whose `[` has no closing
 *  `]` within 80 chars from the tag start (cheap runaway-scan guard). */
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

/*- Output sink — the functions every `log.*` method ultimately calls.
 *  Defaults to the live `console.*` methods.  Tests inject a fake sink
 *  via `_setSinkForTests` to capture output WITHOUT monkey-patching
 *  the global `console` object (see [[feedback-no-global-monkey-patch]]). */
let _sink = {
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

/**
 * Timestamped logger — call instead of `console.*` when you want every
 * line to carry a UTC timestamp.  Matches the `console.log` / `warn` /
 * `error` arity and `printf`-style substitution semantics.
 */
const log = {
  info: (first, ...rest) => _sink.log(_withTimestamp(first), ...rest),
  warn: (first, ...rest) => _sink.warn(_withTimestamp(first), ...rest),
  error: (first, ...rest) => _sink.error(_withTimestamp(first), ...rest),
};

/**
 * Replace the underlying output sink for tests.  Returns a `restore`
 * function that puts the default `console.*`-backed sink back.  Tests
 * use this instead of reassigning `console.log` / `console.warn` /
 * `console.error`, so the global `console` is never touched.
 *
 * @param {{log?: Function, warn?: Function, error?: Function}} sink
 * @returns {() => void}  Restore function.
 */
function _setSinkForTests(sink) {
  const prev = _sink;
  _sink = {
    log: sink.log || prev.log,
    warn: sink.warn || prev.warn,
    error: sink.error || prev.error,
  };
  return () => {
    _sink = prev;
  };
}

module.exports = {
  log,
  _withTimestamp, // exported for tests
  _utcTimestamp, // exported for tests
  _setSinkForTests,
};
