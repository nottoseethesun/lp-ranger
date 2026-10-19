/**
 * @file test/boot-log-file.test.js
 * @description Unit tests for src/boot-log-file.js — verifies the
 * --log-file CLI flag parser, the static-tunable JSON reader, and the
 * end-to-end bootLogFile() integration with src/log-file.js.
 *
 * The cases rewrite and remove logging.json, so they do it in a copy of
 * the shipped folder that the loader reads in its place
 * (test/helpers/shipped-defaults-copy.js), and they write their logs
 * in a temp folder of their own.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { useShippedDefaultsCopy } = require("./helpers/shipped-defaults-copy");
const { makeTestTempFolder } = require("../src/test-temp-folders");

const CFG_PATH = path.join(useShippedDefaultsCopy(), "logging.json");
const TMP = makeTestTempFolder("boot-log");

/** logging.json as shipped, which each case that rewrites it starts from. */
const _origCfg = fs.readFileSync(CFG_PATH, "utf8");

/*-
 *  The shipped log path, read before any case rewrites logging.json.
 *  Relative, so it resolves against whatever the working directory is.
 */
const _SHIPPED_LOG_PATH = JSON.parse(_origCfg).path;

/*-
 *  Absolute path of the shipped log, resolved the way src/log-file.js
 *  resolves it (relative to the project root).
 */
function _absDefaultLog() {
  return path.join(process.cwd(), _SHIPPED_LOG_PATH);
}

/** File contents, or null when the file is absent. */
function _readIfPresent(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/*-
 *  Guard on the operator's live log.
 *
 *  Invariant: no test in this file may delete, truncate or overwrite
 *  `logs/lp-ranger.log`, or make one where there was none. It is the
 *  file a real `--log-file` run appends to, and `scripts/check.js` does
 *  not back up `logs/`, so a test that removes it removes it for good.
 *  It is also gitignored, so the loss shows up nowhere else and the
 *  suite still reports green, which is why the check has to be an
 *  assertion here.
 *
 *  The pull towards violating it is logging.json's shipped `path`: it
 *  is relative, and `enableLogFile` resolves it against `process.cwd()`,
 *  so any test that boots the logger from the repo root without
 *  supplying a path opens that exact file.
 *
 *  Read in `before` and compared in `after` rather than inside a test,
 *  so the guard holds whichever test does the damage and in whatever
 *  order they run. The file is never written, so a run stopped between
 *  the two leaves it as it was. Appending to it passes; losing what it
 *  held fails.
 */
let _logBefore = null;

before(() => {
  _logBefore = _readIfPresent(_absDefaultLog());
});

after(() => {
  /*- Always tear down any tee that survived a failing test. */
  const { disableLogFile } = require("../src/log-file");
  disableLogFile();
  const abs = _absDefaultLog();
  const now = _readIfPresent(abs);
  if (_logBefore === null) {
    // A log a test made where there was none is its own; it goes.
    if (now !== null) fs.rmSync(abs, { force: true });
    assert.equal(now, null, "a test made a log at " + abs);
    return;
  }
  assert.notEqual(
    now,
    null,
    "a test deleted the operator's log at " + abs + " — see the note above",
  );
  assert.ok(
    now.subarray(0, _logBefore.length).equals(_logBefore),
    "a test truncated or overwrote the operator's log at " + abs,
  );
});

describe("_parseCliFlag", () => {
  const { _parseCliFlag } = require("../src/boot-log-file");

  it("returns present=false when --log-file is absent", () => {
    const r = _parseCliFlag(["--verbose", "--help"]);
    assert.equal(r.present, false);
    assert.equal(r.pathArg, null);
  });

  it("returns present=true with no pathArg when flag is bare", () => {
    const r = _parseCliFlag(["--log-file"]);
    assert.equal(r.present, true);
    assert.equal(r.pathArg, null);
  });

  it("captures the path argument that follows --log-file", () => {
    const r = _parseCliFlag(["--log-file", "/tmp/foo.log"]);
    assert.equal(r.present, true);
    assert.equal(r.pathArg, "/tmp/foo.log");
  });

  it("treats the next arg as a flag when it starts with --", () => {
    const r = _parseCliFlag(["--log-file", "--verbose"]);
    assert.equal(r.present, true);
    assert.equal(r.pathArg, null, "next arg is another flag, not a path");
  });

  it("works in the middle of argv with other flags", () => {
    const r = _parseCliFlag(["--verbose", "--log-file", "logs/x.log", "-v"]);
    assert.equal(r.present, true);
    assert.equal(r.pathArg, "logs/x.log");
  });

  it("ignores empty string as path", () => {
    const r = _parseCliFlag(["--log-file", ""]);
    assert.equal(r.present, true);
    assert.equal(r.pathArg, null);
  });
});

describe("_readLoggingConfig", () => {
  const { _readLoggingConfig } = require("../src/boot-log-file");

  beforeEach(() => {
    fs.writeFileSync(CFG_PATH, _origCfg);
    require("../src/load-merged-defaults")._resetMemoForTests();
  });

  it("reads enabled + path from logging.json", () => {
    fs.writeFileSync(
      CFG_PATH,
      JSON.stringify({ enabled: true, path: "custom/path.log" }),
    );
    const r = _readLoggingConfig();
    assert.equal(r.enabled, true);
    assert.equal(r.path, "custom/path.log");
  });

  it("defaults to enabled=false when the file is missing", () => {
    fs.unlinkSync(CFG_PATH);
    const r = _readLoggingConfig();
    assert.equal(r.enabled, false);
    assert.equal(r.path, null);
  });

  it("defaults to enabled=false on malformed JSON", () => {
    fs.writeFileSync(CFG_PATH, "not json {{");
    const r = _readLoggingConfig();
    assert.equal(r.enabled, false);
    assert.equal(r.path, null);
  });

  it("treats non-boolean enabled as false", () => {
    fs.writeFileSync(CFG_PATH, JSON.stringify({ enabled: 1, path: "x.log" }));
    const r = _readLoggingConfig();
    assert.equal(r.enabled, false, "only literal true counts as enabled");
  });
});

describe("bootLogFile end-to-end", () => {
  const { bootLogFile } = require("../src/boot-log-file");
  const { disableLogFile, getActiveLogFilePath } = require("../src/log-file");

  let _origArgv;
  beforeEach(() => {
    _origArgv = process.argv;
    disableLogFile();
    fs.writeFileSync(CFG_PATH, _origCfg);
    require("../src/load-merged-defaults")._resetMemoForTests();
  });

  after(() => {
    process.argv = _origArgv;
    disableLogFile();
  });

  it("returns null and enables nothing when neither source opts in", () => {
    process.argv = ["node", "server.js"];
    fs.writeFileSync(CFG_PATH, JSON.stringify({ enabled: false, path: null }));
    const r = bootLogFile();
    assert.equal(r, null);
    assert.equal(getActiveLogFilePath(), null);
  });

  it("CLI flag with path overrides everything", () => {
    const filePath = path.join(TMP, "cli-override.log");
    process.argv = ["node", "server.js", "--log-file", filePath];
    fs.writeFileSync(
      CFG_PATH,
      JSON.stringify({ enabled: false, path: "ignored.log" }),
    );
    const r = bootLogFile();
    try {
      assert.equal(r, filePath);
      assert.equal(getActiveLogFilePath(), filePath);
    } finally {
      disableLogFile();
    }
  });

  it("bare CLI flag falls through to config path", () => {
    const filePath = path.join(TMP, "cfg-path.log");
    process.argv = ["node", "server.js", "--log-file"];
    fs.writeFileSync(
      CFG_PATH,
      JSON.stringify({ enabled: false, path: filePath }),
    );
    const r = bootLogFile();
    try {
      assert.equal(r, filePath);
    } finally {
      disableLogFile();
    }
  });

  it("config enabled=true with no CLI flag enables tee", () => {
    const filePath = path.join(TMP, "cfg-enabled.log");
    process.argv = ["node", "server.js"];
    fs.writeFileSync(
      CFG_PATH,
      JSON.stringify({ enabled: true, path: filePath }),
    );
    const r = bootLogFile();
    try {
      assert.equal(r, filePath);
    } finally {
      disableLogFile();
    }
  });

  it("stays off, saying so, when nothing supplies a path", () => {
    /*-
     *  logging.json is the one place the path is written down, so with
     *  no path there and none after the flag there is no file to open,
     *  rather than one the code would choose by itself.
     */
    process.argv = ["node", "server.js", "--log-file"];
    fs.writeFileSync(CFG_PATH, JSON.stringify({ enabled: false, path: null }));
    const said = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      said.push(String(chunk));
      return true;
    };
    try {
      assert.equal(bootLogFile(), null);
      assert.equal(getActiveLogFilePath(), null);
      assert.ok(
        said.some((s) => s.includes("logging.json → path")),
        "names the setting: " + said.join(""),
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe("--delete-pre-existing-log-file", () => {
  const { bootLogFile, DELETE_FLAG } = require("../src/boot-log-file");
  const { disableLogFile } = require("../src/log-file");

  let _origArgv;
  beforeEach(() => {
    _origArgv = process.argv;
    disableLogFile();
    fs.writeFileSync(CFG_PATH, _origCfg);
    require("../src/load-merged-defaults")._resetMemoForTests();
  });

  after(() => {
    process.argv = _origArgv;
    disableLogFile();
  });

  /**
   * Run `fn` with cwd inside a throwaway tree.
   *
   * Every case here writes to, or deletes, the shipped log path — the
   * same relative path the operator's own log resolves to from the repo
   * root. `scripts/check.js` does not back up `logs/`,
   * so a case that ran from the repo root would delete that file for
   * good and the suite would still report green.
   */
  function _inSandbox(fn) {
    const cwd = process.cwd();
    const sandbox = makeTestTempFolder("del-log");
    process.chdir(sandbox);
    try {
      return fn(path.join(fs.realpathSync(sandbox), _SHIPPED_LOG_PATH));
    } finally {
      disableLogFile();
      process.chdir(cwd);
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }

  it("clears a previous run's file before writing this one", () => {
    _inSandbox((logPath) => {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "lines from an earlier run\n");
      process.argv = ["node", "server.js", "--log-file", DELETE_FLAG];

      bootLogFile();

      const after = fs.readFileSync(logPath, "utf8");
      assert.equal(
        after.includes("earlier run"),
        false,
        "the previous run's lines are gone",
      );
      assert.match(after, /\[log-file\] Opened at /, "and this run opened it");
    });
  });

  it("treats an absent file as already empty", () => {
    /*- The flag asks for an empty log, and there is nothing emptier
     *  than no file. A first run must not fail for having nothing to
     *  delete. */
    _inSandbox((logPath) => {
      process.argv = ["node", "server.js", "--log-file", DELETE_FLAG];
      assert.doesNotThrow(() => bootLogFile());
      assert.ok(fs.existsSync(logPath), "the run still opened its log");
    });
  });

  it("does nothing when log-to-file is off", () => {
    /*- Asked for on its own, there is no file this run will write, so
     *  deleting would take away a previous run's log and replace it
     *  with nothing. */
    _inSandbox((logPath) => {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "keep me\n");
      fs.writeFileSync(
        CFG_PATH,
        JSON.stringify({ enabled: false, path: null }),
      );
      require("../src/load-merged-defaults")._resetMemoForTests();
      process.argv = ["node", "server.js", DELETE_FLAG];

      assert.equal(bootLogFile(), null, "log-to-file stayed off");
      assert.equal(fs.readFileSync(logPath, "utf8"), "keep me\n");
    });
  });

  it("is absent by default, so an ordinary run appends", () => {
    _inSandbox((logPath) => {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "lines from an earlier run\n");
      process.argv = ["node", "server.js", "--log-file"];

      bootLogFile();

      assert.match(
        fs.readFileSync(logPath, "utf8"),
        /earlier run/,
        "append mode is still the default",
      );
    });
  });
});
