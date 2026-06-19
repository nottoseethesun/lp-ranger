/**
 * @file test/dashboard-log.test.js
 * @description Tests for the browser-side opt-in logger in
 * `public/dashboard-log.js`.  Covers the rules introduced to fix the
 * user-reported browser-console issues:
 *
 *   1. Every browser log line MUST start with the `[lp-ranger]` app
 *      scope so iframes / extensions can't pollute the stream.  The
 *      logger auto-prefixes when the call site didn't supply it.
 *   2. The timestamp is ALWAYS last in the prefix group — after every
 *      consecutive `[tag]`.  No more `[lp-ranger] [<ts>] [subscope]
 *      msg`; the correct shape is `[lp-ranger] [subscope] [<ts>] msg`.
 *   3. Leading `%c<spec>` style directives and ANSI escapes are
 *      skipped during tag detection so styled lines route correctly.
 *   4. Format strings whose tag is hidden behind a `%s` substitution
 *      cannot be auto-fixed by the logger — callers must inline the
 *      namespace via template literal.  These tests pin the policy
 *      so we notice if a refactor regresses it.
 *
 * The browser module is loaded directly via Node's ESM machinery —
 * `dashboard-log.js` has no DOM dependencies, so importing it works
 * the same way the existing browser bundle imports it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const TS = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/;
const _ESC = String.fromCharCode(0x1b);

let _withTimestamp, _scanTags, _skipFormatNoise, APP_TAG, APP_TAG_PREFIX, log;

test("dynamically load the ESM browser module under test", async () => {
  /*- node:test doesn't expose `before`/`beforeEach` from `node:test`
   *  as named helpers, so we just inline the import in a leading
   *  test that runs before the others (tests run in file order). */
  const mod = await import("../public/dashboard-log.js");
  _withTimestamp = mod._withTimestamp;
  _scanTags = mod._scanTags;
  _skipFormatNoise = mod._skipFormatNoise;
  APP_TAG = mod.APP_TAG;
  APP_TAG_PREFIX = mod.APP_TAG_PREFIX;
  log = mod.log;
  assert.equal(typeof _withTimestamp, "function");
  assert.equal(APP_TAG, "[lp-ranger]");
  assert.equal(APP_TAG_PREFIX, "[lp-ranger");
});

// ── _scanTags ────────────────────────────────────────────────────────

test("_scanTags walks consecutive [tag] segments", () => {
  const { endOfTags, hasAppTag } = _scanTags("[lp-ranger] [poll] msg", 0);
  assert.equal(hasAppTag, true);
  /*- endOfTags lands at the start of the message body. */
  assert.equal("[lp-ranger] [poll] msg".slice(endOfTags), "msg");
});

test("_scanTags detects [lp-ranger app] startup-banner variant as app-tag", () => {
  const { hasAppTag } = _scanTags("[lp-ranger app] 🚀 Started.", 0);
  assert.equal(hasAppTag, true);
});

test("_scanTags reports hasAppTag=false when first tag is something else", () => {
  const { hasAppTag } = _scanTags("[posList] activating idx=175", 0);
  assert.equal(hasAppTag, false);
});

test("_scanTags is bounded — runaway [ with no ] stops the scan", () => {
  const long = "[" + "x".repeat(120) + "] tail";
  const { endOfTags } = _scanTags(long, 0);
  assert.equal(endOfTags, 0, "no valid tag; endOfTags stays at the start");
});

// ── _skipFormatNoise (ANSI + %c) ─────────────────────────────────────

test("_skipFormatNoise skips a leading %c directive", () => {
  const i = _skipFormatNoise("%c[lp-ranger] [poll] msg", 0);
  assert.equal(i, 2);
});

test("_skipFormatNoise skips a leading ANSI escape", () => {
  const input = _ESC + "[30;47m[bot] msg";
  const i = _skipFormatNoise(input, 0);
  assert.equal(input.slice(i), "[bot] msg");
});

test("_skipFormatNoise composes %c after ANSI", () => {
  const input = _ESC + "[31m%c[bot] msg";
  const i = _skipFormatNoise(input, 0);
  assert.equal(input.slice(i), "[bot] msg");
});

test("_skipFormatNoise leaves bare '[' alone", () => {
  assert.equal(_skipFormatNoise("[bot] msg", 0), 0);
});

// ── _withTimestamp: auto-prefix [lp-ranger] ──────────────────────────

test("auto-prefixes [lp-ranger] when first tag is something else", () => {
  const out = _withTimestamp("[posList] activating idx=175");
  assert.match(
    out,
    /^\[lp-ranger\] \[posList\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] activating idx=175$/,
  );
});

test("does NOT double-prefix when [lp-ranger] is already first", () => {
  const out = _withTimestamp("[lp-ranger] [poll] tick=5");
  assert.equal(
    (out.match(/\[lp-ranger\]/g) || []).length,
    1,
    "exactly one [lp-ranger] in the output",
  );
});

test("does NOT double-prefix the [lp-ranger app] banner variant", () => {
  const out = _withTimestamp("[lp-ranger app] 🚀 Started.");
  assert.match(
    out,
    /^\[lp-ranger app\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 🚀 Started\.$/,
  );
});

test("auto-prefixes on bracket-less message (no tag at all)", () => {
  const out = _withTimestamp("plain text no brackets");
  assert.match(
    out,
    /^\[lp-ranger\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] plain text no brackets$/,
  );
});

// ── _withTimestamp: timestamp LAST in the prefix group ──────────────

test("timestamp comes after BOTH tags when subscope is present", () => {
  /*- Regression for the user-reported `[lp-ranger] [2026-06-19 ...] [js heap] ...`
   *  shape (timestamp between app + subscope).  Correct shape is
   *  `[lp-ranger] [js heap] [<ts>] ...`. */
  const out = _withTimestamp("[lp-ranger] [js heap] 75.9 MB used");
  assert.match(
    out,
    /^\[lp-ranger\] \[js heap\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 75\.9 MB used$/,
  );
});

test("timestamp comes after [lp-ranger] when no subscope exists", () => {
  const out = _withTimestamp("[lp-ranger] LP Ranger commit=abc");
  assert.match(
    out,
    /^\[lp-ranger\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] LP Ranger commit=abc$/,
  );
});

test("timestamp comes after three stacked tags too (no truncation)", () => {
  const out = _withTimestamp("[lp-ranger] [a] [b] message");
  assert.match(
    out,
    /^\[lp-ranger\] \[a\] \[b\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] message$/,
  );
});

// ── _withTimestamp: %c-styled call sites ─────────────────────────────

test("%c[lp-ranger] [tag] msg keeps the %c at the head, injects ts last", () => {
  const out = _withTimestamp("%c[lp-ranger] [poll] #%s hasPosData=%s");
  assert.equal(
    out,
    "%c[lp-ranger] [poll] " + out.match(TS)[0] + " #%s hasPosData=%s",
  );
});

test("%c[tag] msg auto-prefixes [lp-ranger] after the %c directive", () => {
  const out = _withTimestamp("%c[scan] 181 NFTs returned");
  assert.match(
    out,
    /^%c\[lp-ranger\] \[scan\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] 181 NFTs returned$/,
  );
});

// ── _withTimestamp: non-string + Error passthrough ──────────────────

test("non-string first args pass through untouched", () => {
  assert.equal(_withTimestamp(42), 42);
  assert.equal(_withTimestamp(null), null);
  const err = new Error("boom");
  assert.equal(_withTimestamp(err), err);
});

// ── end-to-end via log.* + console capture ───────────────────────────

test("log.info / warn / error route to matching console methods", () => {
  const calls = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  /*- Direct console swap is necessary here because dashboard-log.js
   *  has no sink-injector (kept minimal vs src/log.js).  Restore in
   *  finally so a failing assertion can't leak state into the next
   *  test. */
  console.log = (...a) => calls.push(["log", ...a]);
  console.warn = (...a) => calls.push(["warn", ...a]);
  console.error = (...a) => calls.push(["error", ...a]);
  try {
    log.info("[poll] tick");
    log.warn("[server] heads up");
    log.error("[bot] boom");
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origErr;
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], "log");
  assert.match(calls[0][1], /^\[lp-ranger\] \[poll\] \[.*\] tick$/);
  assert.equal(calls[1][0], "warn");
  assert.match(calls[1][1], /^\[lp-ranger\] \[server\] \[.*\] heads up$/);
  assert.equal(calls[2][0], "error");
  assert.match(calls[2][1], /^\[lp-ranger\] \[bot\] \[.*\] boom$/);
});

test("log.* forwards extra printf args untouched", () => {
  const calls = [];
  const orig = console.log;
  console.log = (...a) => calls.push(a);
  try {
    log.info("[poll] count=%d name=%s", 5, "alice");
  } finally {
    console.log = orig;
  }
  assert.equal(calls.length, 1);
  /*- format string + 2 substitution args = 3 total */
  assert.equal(calls[0].length, 3);
  assert.match(calls[0][0], /^\[lp-ranger\] \[poll\] \[.*\] count=%d name=%s$/);
  assert.equal(calls[0][1], 5);
  assert.equal(calls[0][2], "alice");
});

// ── policy pin: %s NS pattern still produces wrong output ───────────

test("PIN: '%s msg' + NS-as-arg cannot be auto-fixed by the logger", () => {
  /*- This is the broken pattern that motivated the call-site fix in
   *  dashboard-unlock-log.js + server-unlock-log.js.  The logger sees
   *  `%s` (not `[`) at position 0, can't tell that NS will substitute
   *  to a bracketed tag, and so prepends + auto-prefixes.  Pin the
   *  behaviour with a regression test so a future refactor that tries
   *  to "fix" the logger to peek inside `%s` doesn't ship without a
   *  matching policy update. */
  const out = _withTimestamp("%s submitUnlock ENTRY");
  /*- `%s` is content-producing, so the logger treats it as message
   *  body.  Output: `[lp-ranger] [<ts>] %s submitUnlock ENTRY`. */
  assert.match(
    out,
    /^\[lp-ranger\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] %s submitUnlock ENTRY$/,
  );
});
