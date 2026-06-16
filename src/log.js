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

/*- ANSI color table for known log tag prefixes.  Folded in from the
 *  legacy `installColorLogger()` in `src/logger.js` so colorization
 *  happens inside the opt-in `log.*` chain instead of via a
 *  `console.*` monkey-patch (see Core Essentials in
 *  docs/claude/CLAUDE-BEST-PRACTICES.md).  Lines that don't begin with
 *  a known tag pass through with ANSI untouched. */
const _COLORS = {
  "[server]": "\x1b[38;2;0;191;255m", // azure blue
  "[bot]": "\x1b[38;2;200;160;255m", // light purple
  "[rebalance]": "\x1b[38;2;255;250;205m", // Lemon Chiffon (#FFFACD)
  "[event-scanner]": "\x1b[38;2;60;80;180;48;2;255;228;196m", // dark blue on bisque
  "[history]": "\x1b[38;2;160;120;80m", // light brown
  "[pos-mgr]": "\x1b[35;48;2;242;242;242m", // magenta on 95% white
  "[pos-route]": "\x1b[35;48;2;255;255;255m", // magenta on white
  "[pos-state]": "\x1b[35;48;2;230;230;230m", // magenta on 90% white
  "[compound]": "\x1b[38;2;163;255;43m", // neon green #a3ff2b
  "[pnl]": "\x1b[38;2;0;130;0m", // dark green
  "[position details]": "\x1b[38;2;225;217;209m", // dark white (#E1D9D1)
  "[native]": "\x1b[33m", // yellow
  "[aggregator]": "\x1b[33m", // yellow (same as [rebalance])
  "[price-fetcher]": "\x1b[38;2;124;252;0m", // lawn green
  "[wallet]": "\x1b[38;2;211;211;211;48;2;15;70;15m", // light gray on dark forest green
  "[gas-monitor]": "\x1b[38;2;255;255;0;48;2;139;0;0m", // yellow on dull red
  "[moralis]": "\x1b[38;2;232;228;201m", // Dirty White (#E8E4C9)
  "[telegram]": "\x1b[38;2;232;228;201m", // Dirty White (#E8E4C9)
  // Classic Burgundy (#800020) on Metallic Gold (#D4AF37)
  "[dust-unit-price]": "\x1b[38;2;128;0;32;48;2;212;175;55m",
  // Black (#000000) on Dollar Bill Green (#85BB65)
  "[deposit]": "\x1b[38;2;0;0;0;48;2;133;187;101m",
};
const _RESET = "\x1b[0m";

/*- Substring highlights: bold/colored text on colored backgrounds.
 *  `toEnd: true` extends the highlight to end-of-line. */
const _HIGHLIGHTS = [
  { text: "Rebalance requested", style: "\x1b[1;30;48;2;255;140;0m" }, // bold black on chevrolet orange
  {
    text: "Manual rebalance",
    style: "\x1b[38;2;60;60;60;48;2;255;140;0m",
    toEnd: true,
  }, // dark grey on chevrolet orange (rest of line)
  { text: "Rebalance OK", style: "\x1b[48;2;0;60;120m", toEnd: true }, // light purple text (from [bot] prefix) on deep azure bg
  {
    text: "Position selected:",
    style: "\x1b[38;2;80;40;0;48;2;124;252;0m",
    toEnd: true,
  }, // dark brown text on lawn green bg
];

/*- Apply tag-prefix coloring + substring highlight, if any.  Non-string
 *  first args pass through untouched.  Returns the (possibly modified)
 *  first arg; later args are unchanged. */
function _colorize(first) {
  if (typeof first !== "string") return first;
  let out = first;
  for (const [tag, color] of Object.entries(_COLORS)) {
    if (out.startsWith(tag)) {
      out = color + out + _RESET;
      break;
    }
  }
  for (const h of _HIGHLIGHTS) {
    const idx = out.indexOf(h.text);
    if (idx >= 0) {
      if (h.toEnd) out = out.slice(0, idx) + h.style + out.slice(idx) + _RESET;
      else out = out.replace(h.text, h.style + h.text + _RESET);
      break;
    }
  }
  return out;
}

/**
 * Timestamped + colorized logger — call instead of `console.*` when you
 * want every line to carry a UTC timestamp and a tag-prefix color.
 * Matches the `console.log` / `warn` / `error` arity and `printf`-style
 * substitution semantics.  Composition order is timestamp-then-colorize
 * so the color wraps the timestamped string (preserving the legacy
 * behaviour from `installColorLogger`).
 */
const log = {
  info: (first, ...rest) =>
    _sink.log(_colorize(_withTimestamp(first)), ...rest),
  warn: (first, ...rest) =>
    _sink.warn(_colorize(_withTimestamp(first)), ...rest),
  error: (first, ...rest) =>
    _sink.error(_colorize(_withTimestamp(first)), ...rest),
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
  _colorize, // exported for tests
  _setSinkForTests,
};
