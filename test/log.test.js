/**
 * @file test/log.test.js
 * @description Tests for the opt-in timestamped logger in `src/log.js`.
 *
 * Covers:
 *   - bracketed-prefix injection point (`[tag] msg` → `[tag] [ts] msg`)
 *   - bracket-less lines get a bare prepended timestamp
 *   - oversized "fake bracket" lines (no closing `]` in 80 chars) are
 *     treated as bracket-less and get the bare prepend
 *   - non-string first args pass through untouched
 *   - `printf`-style extra args are forwarded as-is
 *   - `log.info` / `log.warn` / `log.error` route to the right
 *     `console.*` method
 *   - `console.log` / `warn` / `error` themselves are NOT modified —
 *     importing `src/log.js` must not patch globals
 *   - `_utcTimestamp()` produces the `YYYY-MM-DD HH:MM:SS` shape
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  log,
  _withTimestamp,
  _utcTimestamp,
  _colorize,
  _setSinkForTests,
} = require("../src/log");

const TS = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/;

/*- Strip ANSI CSI escape sequences from a string for assertion purposes.
 *  Built via `String.fromCharCode(0x1b)` instead of a literal `\x1b` in
 *  the regex source to keep ESLint's `no-control-regex` happy. */
const _ESC = String.fromCharCode(0x1b);
const _ANSI = new RegExp(_ESC + "\\[[0-9;]*m", "g");
const stripAnsi = (s) => (typeof s === "string" ? s.replace(_ANSI, "") : s);

test("_withTimestamp inserts after first bracketed prefix", () => {
  const out = _withTimestamp("[bot] OOR but within 5% threshold");
  assert.match(
    out,
    /^\[bot\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] OOR but within 5% threshold$/,
  );
});

test("_withTimestamp prepends bare on bracket-less lines", () => {
  const out = _withTimestamp("plain text no brackets");
  assert.match(
    out,
    /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] plain text no brackets$/,
  );
});

test("_withTimestamp prepends bare when closing ] is past 80 chars", () => {
  const long = "[" + "x".repeat(90) + "] tail";
  const out = _withTimestamp(long);
  assert.ok(out.startsWith("["));
  assert.match(out, TS);
  assert.ok(out.endsWith(long));
});

test("_withTimestamp leaves non-string first args alone", () => {
  assert.equal(_withTimestamp(42), 42);
  assert.equal(_withTimestamp(null), null);
  assert.deepEqual(_withTimestamp({ x: 1 }), { x: 1 });
  const err = new Error("boom");
  assert.equal(_withTimestamp(err), err);
});

test("_withTimestamp handles tag-only line (no trailing content)", () => {
  const out = _withTimestamp("[bot]");
  assert.match(out, /^\[bot\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);
});

/*- Tests for ANSI-wrapped input: assert structurally (startsWith,
 *  endsWith, indexOf) so we don't have to embed `\x1b` in a regex —
 *  ESLint's `no-control-regex` flags any escape-character regex
 *  source, and a structural assertion is more readable anyway. */
test("_withTimestamp skips leading ANSI CSI escapes before finding the tag", () => {
  /*- A color-wrapped tag like the server / bot banner: the literal
   *  start is `\x1b[30;47m` (an ANSI Select-Graphic-Rendition escape),
   *  not `[`.  The timestamp must inject after the LOGICAL tag close,
   *  not be prepended bare because the bytes happen to start with
   *  `\x1b`. */
  const input = "\x1b[30;47m[lp-ranger server] hi\x1b[0m";
  const out = _withTimestamp(input);
  /*- The original prefix (`\x1b[30;47m[lp-ranger server]`) must be
   *  untouched at the head, the original tail (`hi\x1b[0m`) at the end,
   *  and the timestamp must sit between them. */
  assert.ok(out.startsWith("\x1b[30;47m[lp-ranger server] ["));
  assert.ok(out.endsWith("] hi\x1b[0m"));
  assert.match(out, TS);
});

test("_withTimestamp handles multiple stacked ANSI escapes before the tag", () => {
  const out = _withTimestamp("\x1b[1m\x1b[31m[err] boom\x1b[0m");
  assert.ok(out.startsWith("\x1b[1m\x1b[31m[err] ["));
  assert.ok(out.endsWith("] boom\x1b[0m"));
  assert.match(out, TS);
});

test("_withTimestamp prepends bare when an ANSI escape isn't followed by a tag", () => {
  const out = _withTimestamp("\x1b[31mplain red text\x1b[0m");
  /*- No `[tag]` after the ANSI escape, so timestamp goes at the very
   *  front and the original (escape included) is preserved verbatim. */
  assert.ok(out.startsWith("["));
  assert.match(out, TS);
  assert.ok(out.endsWith("] \x1b[31mplain red text\x1b[0m"));
});

test("_utcTimestamp shape: YYYY-MM-DD HH:MM:SS", () => {
  const ts = _utcTimestamp();
  assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

/*- Importing `src/log.js` must NOT modify `console` globals.  The whole
 *  point of the opt-in wrapper is that other libraries / tests / app
 *  code that call `console.log` see the unmodified built-in. */
test("require('../src/log') does NOT modify console globals", () => {
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  /*- Re-require fresh: clear cache so a prior import in this test file
   *  doesn't mask a hypothetical install-on-require side effect. */
  delete require.cache[require.resolve("../src/log")];
  require("../src/log");
  assert.equal(console.log, origLog, "console.log was modified");
  assert.equal(console.warn, origWarn, "console.warn was modified");
  assert.equal(console.error, origErr, "console.error was modified");
});

/*- Use the sink injector to capture output without touching `console`
 *  itself — see [[feedback-no-global-monkey-patch]].  The sink replaces
 *  the underlying `console.*` delegate that `log.info` / `warn` /
 *  `error` route through, so we assert on captured calls without
 *  re-assigning any built-in. */
test("log.info / warn / error route to matching console methods with timestamp", () => {
  const calls = [];
  const restore = _setSinkForTests({
    log: (...a) => calls.push(["log", ...a]),
    warn: (...a) => calls.push(["warn", ...a]),
    error: (...a) => calls.push(["error", ...a]),
  });
  try {
    log.info("[bot] hello");
    log.warn("[server] heads up");
    log.error("[bot] boom");
  } finally {
    restore();
  }
  assert.equal(calls.length, 3);
  /*- Strip ANSI from the asserted text because `log.*` now applies
   *  tag-prefix coloring on top of the timestamp injection.  The
   *  separate `_colorize` test below covers the color bytes
   *  themselves. */
  assert.equal(calls[0][0], "log");
  assert.match(stripAnsi(calls[0][1]), /^\[bot\] \[.*\] hello$/);
  assert.equal(calls[1][0], "warn");
  assert.match(stripAnsi(calls[1][1]), /^\[server\] \[.*\] heads up$/);
  assert.equal(calls[2][0], "error");
  assert.match(stripAnsi(calls[2][1]), /^\[bot\] \[.*\] boom$/);
});

test("log.info wraps known tag prefixes with ANSI color codes", () => {
  const calls = [];
  const restore = _setSinkForTests({ log: (...a) => calls.push(a) });
  try {
    log.info("[bot] colored line");
  } finally {
    restore();
  }
  /*- `[bot]` is registered in `_COLORS` with the light-purple SGR
   *  sequence `\x1b[38;2;200;160;255m`.  Assert via `startsWith` so
   *  we don't have to embed the escape byte in a regex. */
  assert.ok(
    calls[0][0].startsWith(_ESC + "[38;2;200;160;255m["),
    `expected color-wrapped output, got: ${JSON.stringify(calls[0][0])}`,
  );
  assert.ok(calls[0][0].endsWith(_ESC + "[0m"));
});

test("log.info forwards extra printf args untouched", () => {
  const calls = [];
  const restore = _setSinkForTests({ log: (...a) => calls.push(a) });
  try {
    log.info("[bot] count=%d name=%s", 5, "alice");
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 3);
  assert.match(stripAnsi(calls[0][0]), /^\[bot\] \[.*\] count=%d name=%s$/);
  assert.equal(calls[0][1], 5);
  assert.equal(calls[0][2], "alice");
});

test("_colorize wraps known tags + leaves unknown tags untouched", () => {
  /*- `[bot]` is a registered tag → wrapped.  `[noisy]` is not →
   *  untouched (third-party / unrecognized prefixes pass through). */
  const wrapped = _colorize("[bot] hello");
  assert.ok(wrapped.startsWith(_ESC + "["));
  assert.ok(wrapped.endsWith(_ESC + "[0m"));
  assert.equal(stripAnsi(wrapped), "[bot] hello");

  const passthrough = _colorize("[noisy] hello");
  assert.equal(passthrough, "[noisy] hello");
});
