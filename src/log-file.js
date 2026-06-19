/**
 * @file src/log-file.js
 * @module log-file
 * @description
 * Opt-in log-to-file feature.  When `enableLogFile(path)` is called at
 * process startup, every byte subsequently written to `process.stdout`
 * or `process.stderr` is ALSO appended to the file at `path` with ANSI
 * color escape sequences stripped (so the on-disk log is grep-friendly
 * while the terminal still shows colors).
 *
 * Trigger sources (see server.js / bot.js boot):
 *   1. CLI flag `--log-file [optional path]` (path optional — falls
 *      through to the static-tunable default when omitted).
 *   2. `app-config/static-tunables/logging.json` with `enabled: true`
 *      (operators set this once for a long-lived production tail).
 *
 * Why wrap process.stdout/stderr instead of the `log.*` helpers?
 * The user explicitly asked for "the entire log to disk as it is
 * printed out to the console" — including raw `console.*` calls from
 * any module, native runtime warnings, and stack traces from unhandled
 * errors.  Wrapping only the `log` helpers would miss all of those.
 * Per the [[feedback-no-global-monkey-patch]] rule, this is an OPT-IN
 * wrapper at the Node I/O layer (not modification of a JS-standard
 * global like console.* / Array.prototype / fetch), and it is a
 * transparent tee — the original write is always called with the same
 * arguments, so downstream consumers see identical behaviour.
 *
 * Idempotency: `enableLogFile(path)` is a no-op when already active
 * with the same path.  Calling with a different path closes the
 * current stream and opens the new one.  `disableLogFile()` restores
 * the originals and closes the stream (used by tests).
 */

"use strict";

const fs = require("fs");
const path = require("path");

/*- Synchronous file descriptor (fs.openSync + fs.writeSync) instead of
 *  a streaming Writable.  Two reasons:
 *
 *  1. Log integrity on crash: a buffered Writable can lose pending
 *     output if the process exits abnormally (segfault, OOM kill,
 *     SIGKILL).  fs.writeSync forces the byte to the OS write buffer
 *     before returning so an unexpected exit loses at most one syscall
 *     of data, not whatever a Writable had queued.
 *
 *  2. Caller semantics: process.stdout.write is documented as having
 *     synchronous-from-the-caller's-POV semantics for line-buffered
 *     output to a TTY.  The tee should match — if the caller reads the
 *     log file right after a write(), the bytes must be there.
 *     Otherwise tests (and human operators tailing the file) see
 *     missing lines.
 *
 *  Throughput cost is negligible: ext4 sustains millions of small
 *  appends per second; LP Ranger emits a few hundred log lines/min. */
/** @type {number | null} */
let _fd = null;
/** @type {Function | null} */
let _origStdoutWrite = null;
/** @type {Function | null} */
let _origStderrWrite = null;
/** @type {string | null} */
let _activePath = null;

/*- Strip CSI escape sequences (color, cursor, formatting).  Sequences
 *  look like `ESC [ <params> <final-byte>` where ESC is 0x1b, params
 *  are typically digits and semicolons, and the final byte is in the
 *  range 0x40 ('@') - 0x7E ('~').  Implemented as a hand-rolled scanner
 *  rather than a regex for two reasons:
 *    (a) eslint `no-control-regex` rejects a literal `\x1b` in a regex
 *        source, and
 *    (b) `security/detect-non-literal-regexp` rejects RegExp constructor
 *        calls whose source isn't a literal — so the only available
 *        regex form (built via String.fromCharCode) is also rejected.
 *  Hand-rolled scanning sidesteps both rules and is also faster on the
 *  common no-escape line (no engine startup, no allocation). */
const _ESC = 0x1b;
const _OPEN = 0x5b; // '['

function _stripAnsi(s) {
  if (typeof s !== "string") return s;
  const len = s.length;
  if (len === 0) return s;
  /*- Fast path: no ESC byte → return original unchanged. */
  let hasEsc = false;
  for (let k = 0; k < len; k++) {
    if (s.charCodeAt(k) === _ESC) {
      hasEsc = true;
      break;
    }
  }
  if (!hasEsc) return s;
  let out = "";
  let i = 0;
  while (i < len) {
    if (s.charCodeAt(i) === _ESC && s.charCodeAt(i + 1) === _OPEN) {
      let j = i + 2;
      while (j < len) {
        const c = s.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          j++;
          break;
        }
        j++;
      }
      i = j;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/*- Write a chunk to the file, normalising Buffer → utf8 string and
 *  stripping ANSI escapes.  Silently no-ops when the fd is closed
 *  (defensive: writes can race a disable). */
function _writeToFile(chunk) {
  if (_fd === null) return;
  let s;
  if (typeof chunk === "string") s = chunk;
  else if (Buffer.isBuffer(chunk)) s = chunk.toString("utf8");
  else return;
  try {
    fs.writeSync(_fd, _stripAnsi(s));
  } catch {
    /*- File handle was closed between the null-check and the write
     *  (rare race in process-exit teardown).  Swallow so the original
     *  process.stdout.write still runs and the terminal still sees
     *  the output. */
  }
}

/**
 * Enable log-to-file teeing.  Wraps process.stdout.write and
 * process.stderr.write to ALSO append every byte to `filePath`
 * (ANSI escapes stripped for the file copy).
 *
 * @param {string} filePath  Absolute path or relative to process.cwd().
 * @returns {string}  The absolute path of the active log file.
 */
function enableLogFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new TypeError("enableLogFile requires a filePath string");
  }
  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  if (_fd !== null && _activePath === abs) return _activePath;
  if (_fd !== null) disableLogFile();
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  _fd = fs.openSync(abs, "a");
  fs.writeSync(
    _fd,
    "\n[log-file] Opened at " +
      new Date().toISOString() +
      " (pid " +
      process.pid +
      ")\n",
  );
  _activePath = abs;
  /*- Save the original write functions WITHOUT binding so that
   *  disableLogFile() can restore the exact same function reference
   *  the caller had before enable.  `.bind()` returns a new function
   *  object — restoring a bound copy would leave consumers comparing
   *  process.stdout.write against the pre-enable reference unhappy. */
  _origStdoutWrite = process.stdout.write;
  _origStderrWrite = process.stderr.write;
  /*- Use rest-args so all three signatures of write(chunk[, encoding]
   *  [, callback]) round-trip untouched.  Forward the return value so
   *  back-pressure semantics are preserved.  Invoke via .apply with the
   *  stream as `this` to compensate for not binding above. */
  process.stdout.write = function (...args) {
    _writeToFile(args[0]);
    return _origStdoutWrite.apply(process.stdout, args);
  };
  process.stderr.write = function (...args) {
    _writeToFile(args[0]);
    return _origStderrWrite.apply(process.stderr, args);
  };
  return abs;
}

/**
 * Disable log-to-file teeing.  Restores the original process.stdout
 * and process.stderr write functions and closes the file stream.
 * @returns {string | null}  The path that was active before disabling,
 *   or null if none was active.
 */
function disableLogFile() {
  if (_origStdoutWrite) {
    process.stdout.write = _origStdoutWrite;
    _origStdoutWrite = null;
  }
  if (_origStderrWrite) {
    process.stderr.write = _origStderrWrite;
    _origStderrWrite = null;
  }
  if (_fd !== null) {
    try {
      fs.closeSync(_fd);
    } catch {
      /* fd already closed by a prior teardown */
    }
    _fd = null;
  }
  const prev = _activePath;
  _activePath = null;
  return prev;
}

/**
 * @returns {string | null}  Absolute path of the active log file,
 *   or null if log-to-file is not currently enabled.
 */
function getActiveLogFilePath() {
  return _activePath;
}

module.exports = {
  enableLogFile,
  disableLogFile,
  getActiveLogFilePath,
  _stripAnsi, // exported for tests
};
