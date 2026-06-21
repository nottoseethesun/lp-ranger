/**
 * @file test/boot-log-file.test.js
 * @description Unit tests for src/boot-log-file.js — verifies the
 * --log-file CLI flag parser, the static-tunable JSON reader, and the
 * end-to-end bootLogFile() integration with src/log-file.js.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const TMP = path.join(process.cwd(), "tmp", "boot-log-file-test");
const CFG_PATH = path.join(
  process.cwd(),
  "app-config",
  "app-defaults-for-user-configurable",
  "logging.json",
);
let _origCfg = null;

before(() => {
  fs.mkdirSync(TMP, { recursive: true });
  try {
    _origCfg = fs.readFileSync(CFG_PATH, "utf8");
  } catch {
    _origCfg = null;
  }
});

after(() => {
  /*- Restore the on-disk logging.json so this test never leaves the
   *  project in an "enabled=true" state for live runs. */
  if (_origCfg !== null) fs.writeFileSync(CFG_PATH, _origCfg);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* */
  }
  /*- Always tear down any tee that survived a failing test. */
  const { disableLogFile } = require("../src/log-file");
  disableLogFile();
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
    if (_origCfg !== null) fs.writeFileSync(CFG_PATH, _origCfg);
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
  const { bootLogFile, _DEFAULT_PATH } = require("../src/boot-log-file");
  const { disableLogFile, getActiveLogFilePath } = require("../src/log-file");

  let _origArgv;
  beforeEach(() => {
    _origArgv = process.argv;
    disableLogFile();
    if (_origCfg !== null) fs.writeFileSync(CFG_PATH, _origCfg);
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

  it("falls back to default path when nothing else supplies one", () => {
    process.argv = ["node", "server.js", "--log-file"];
    /*- logging.json missing entirely. */
    try {
      fs.unlinkSync(CFG_PATH);
    } catch {
      /* */
    }
    const r = bootLogFile();
    try {
      assert.ok(r.endsWith(_DEFAULT_PATH), "default path used: " + r);
    } finally {
      disableLogFile();
      try {
        fs.unlinkSync(r);
      } catch {
        /* */
      }
    }
  });
});
