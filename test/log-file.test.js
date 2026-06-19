/**
 * @file test/log-file.test.js
 * @description Unit tests for src/log-file.js — verifies that
 * enableLogFile() tees process.stdout/stderr writes to a file with
 * ANSI escapes stripped, and that disableLogFile() restores the
 * originals cleanly.  Each test wraps its enable/disable in
 * try/finally so a failing assertion can't leave the global
 * process.stdout.write monkey-patched for subsequent tests.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const TMP = path.join(process.cwd(), "tmp", "log-file-test");

before(() => {
  fs.mkdirSync(TMP, { recursive: true });
});

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe("_stripAnsi", () => {
  const { _stripAnsi } = require("../src/log-file");
  it("removes simple color codes", () => {
    assert.equal(_stripAnsi("\x1b[31mred\x1b[0m"), "red");
  });
  it("removes truecolor codes", () => {
    assert.equal(
      _stripAnsi("\x1b[38;2;255;140;0morange bg\x1b[0m"),
      "orange bg",
    );
  });
  it("removes layered fg+bg with attributes", () => {
    assert.equal(
      _stripAnsi("\x1b[1;30;48;2;255;140;0mboldtext\x1b[0m"),
      "boldtext",
    );
  });
  it("passes through plain text untouched", () => {
    assert.equal(_stripAnsi("no escapes here"), "no escapes here");
  });
  it("returns non-strings untouched", () => {
    const buf = Buffer.from("x");
    assert.equal(_stripAnsi(buf), buf);
    assert.equal(_stripAnsi(42), 42);
  });
});

describe("enableLogFile + tee", () => {
  it("appends stdout writes to the file (ANSI stripped)", () => {
    const {
      enableLogFile,
      disableLogFile,
      getActiveLogFilePath,
    } = require("../src/log-file");
    const file = path.join(TMP, "tee-stdout.log");
    try {
      fs.unlinkSync(file);
    } catch {
      /* */
    }

    const abs = enableLogFile(file);
    try {
      assert.equal(abs, file, "returned absolute path matches input");
      assert.equal(getActiveLogFilePath(), file);
      /*- Direct stdout write — exact bytes the consumer would emit
       *  (no console formatting). */
      process.stdout.write("\x1b[31mhello\x1b[0m world\n");
      process.stdout.write("plain line\n");
    } finally {
      disableLogFile();
    }

    const body = fs.readFileSync(file, "utf8");
    assert.ok(
      body.includes("hello world\n"),
      "ANSI-stripped stdout line was teed",
    );
    assert.ok(body.includes("plain line\n"), "plain stdout line was teed");
    assert.ok(
      body.startsWith("\n[log-file] Opened at"),
      "header line was written",
    );
  });

  it("appends stderr writes to the file (ANSI stripped)", () => {
    const { enableLogFile, disableLogFile } = require("../src/log-file");
    const file = path.join(TMP, "tee-stderr.log");
    try {
      fs.unlinkSync(file);
    } catch {
      /* */
    }
    enableLogFile(file);
    try {
      process.stderr.write("\x1b[33mwarning\x1b[0m: thing happened\n");
    } finally {
      disableLogFile();
    }
    const body = fs.readFileSync(file, "utf8");
    assert.ok(body.includes("warning: thing happened\n"));
  });

  it("appends to existing file across multiple enable cycles", () => {
    const { enableLogFile, disableLogFile } = require("../src/log-file");
    const file = path.join(TMP, "tee-append.log");
    try {
      fs.unlinkSync(file);
    } catch {
      /* */
    }

    enableLogFile(file);
    try {
      process.stdout.write("first run\n");
    } finally {
      disableLogFile();
    }
    enableLogFile(file);
    try {
      process.stdout.write("second run\n");
    } finally {
      disableLogFile();
    }
    const body = fs.readFileSync(file, "utf8");
    assert.ok(body.includes("first run\n"));
    assert.ok(body.includes("second run\n"));
    /*- Two header lines means append mode worked (not truncate). */
    const headers = body.match(/\[log-file\] Opened at/g) || [];
    assert.equal(headers.length, 2);
  });

  it("disableLogFile restores the originals", () => {
    const { enableLogFile, disableLogFile } = require("../src/log-file");
    const file = path.join(TMP, "tee-restore.log");
    const beforeStdout = process.stdout.write;
    const beforeStderr = process.stderr.write;
    enableLogFile(file);
    assert.notEqual(
      process.stdout.write,
      beforeStdout,
      "stdout.write was wrapped",
    );
    assert.notEqual(
      process.stderr.write,
      beforeStderr,
      "stderr.write was wrapped",
    );
    disableLogFile();
    assert.equal(
      process.stdout.write,
      beforeStdout,
      "stdout.write was restored",
    );
    assert.equal(
      process.stderr.write,
      beforeStderr,
      "stderr.write was restored",
    );
  });

  it("idempotent for the same path", () => {
    const { enableLogFile, disableLogFile } = require("../src/log-file");
    const file = path.join(TMP, "tee-idempotent.log");
    try {
      fs.unlinkSync(file);
    } catch {
      /* */
    }
    const abs1 = enableLogFile(file);
    const wrapped1 = process.stdout.write;
    const abs2 = enableLogFile(file);
    const wrapped2 = process.stdout.write;
    try {
      assert.equal(abs1, abs2, "same path returned");
      assert.equal(
        wrapped1,
        wrapped2,
        "no re-wrapping on idempotent call (same path)",
      );
    } finally {
      disableLogFile();
    }
  });

  it("relative paths resolve against process.cwd()", () => {
    const {
      enableLogFile,
      disableLogFile,
      getActiveLogFilePath,
    } = require("../src/log-file");
    const rel = path.join("tmp", "log-file-test", "rel.log");
    const abs = path.resolve(process.cwd(), rel);
    try {
      fs.unlinkSync(abs);
    } catch {
      /* */
    }
    const got = enableLogFile(rel);
    try {
      assert.equal(got, abs);
      assert.equal(getActiveLogFilePath(), abs);
    } finally {
      disableLogFile();
    }
  });

  it("throws on missing path", () => {
    const { enableLogFile } = require("../src/log-file");
    assert.throws(() => enableLogFile(), { name: "TypeError" });
    assert.throws(() => enableLogFile(""), { name: "TypeError" });
    assert.throws(() => enableLogFile(null), { name: "TypeError" });
  });

  it("creates parent directories", () => {
    const { enableLogFile, disableLogFile } = require("../src/log-file");
    const file = path.join(TMP, "nested", "subdir", "deep.log");
    enableLogFile(file);
    try {
      process.stdout.write("nested\n");
    } finally {
      disableLogFile();
    }
    assert.ok(fs.existsSync(file), "file created in nested directory");
    const body = fs.readFileSync(file, "utf8");
    assert.ok(body.includes("nested\n"));
  });
});

describe("tee preserves passthrough", () => {
  it("the original write is still called (terminal still sees output)", () => {
    const { enableLogFile, disableLogFile } = require("../src/log-file");
    const file = path.join(TMP, "tee-passthrough.log");
    /*- Stub out the underlying stdout write to a sink we can inspect,
     *  then enable tee.  After tee runs, both the file AND the sink
     *  should have the bytes. */
    const seen = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk) {
      seen.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    };
    enableLogFile(file);
    try {
      process.stdout.write("passthrough check\n");
    } finally {
      disableLogFile();
      process.stdout.write = origWrite;
    }
    const body = fs.readFileSync(file, "utf8");
    assert.ok(body.includes("passthrough check\n"), "file got the line");
    assert.ok(
      seen.some((c) => c.includes("passthrough check")),
      "underlying sink got the line too (terminal still receives output)",
    );
  });
});
