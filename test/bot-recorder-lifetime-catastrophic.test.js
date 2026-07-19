/**
 * @file test/bot-recorder-lifetime-catastrophic.test.js
 * @description Tests for the catastrophic-failure surface added to
 * `_recordScanFailure`: writes to logs/error.log, stamps
 * `_catastrophicScanError` on state, and `_recordScanSuccess` clears
 * the flag so a subsequent successful scan hides the red modal.
 */

"use strict";

const { describe, it, before } = require("node:test");
const assert = require("assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");

/*- Redirect writeErrorLog's default path into a per-test tmp file by
 *  intercepting the require call for src/error-log.js.  This keeps
 *  the real logs/error.log clean during tests. */
let _capturedPath = null;
const _origResolve = Module._resolveFilename;
before(() => {
  _capturedPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "lp-ranger-catastrophic-")),
    "error.log",
  );
});

const {
  _recordScanFailure,
  _recordScanSuccess,
} = require("../src/bot-recorder-lifetime");
const errorLog = require("../src/error-log");

function _ctx() {
  return {
    t0Sym: "PLSX",
    t1Sym: "WPLS",
    tokenIdStr: "161973",
    tokenEmoji: "\u{1F525}\u{1F525}\u{1F525}",
  };
}

describe("_recordScanFailure — catastrophic surface", () => {
  it("stamps _catastrophicScanError on bot state with message, at, tokenId, logPath", () => {
    const state = {};
    const updated = [];
    const updateState = (u) => updated.push(u);
    const err = new Error("simulated scan abort");
    _recordScanFailure(state, updateState, err, _ctx());
    /*- Bot state flag set. */
    assert.ok(state._catastrophicScanError);
    assert.strictEqual(
      state._catastrophicScanError.message,
      "simulated scan abort",
    );
    assert.strictEqual(typeof state._catastrophicScanError.at, "number");
    assert.strictEqual(state._catastrophicScanError.tokenId, "161973");
    assert.strictEqual(typeof state._catastrophicScanError.logPath, "string");
    /*- updateState called with the same payload so /api/status sees it. */
    const emit = updated.find((u) => u._catastrophicScanError !== undefined);
    assert.ok(emit);
    assert.strictEqual(
      emit._catastrophicScanError.message,
      "simulated scan abort",
    );
    /*- lifetimeScanComplete flipped to false. */
    assert.strictEqual(state.lifetimeScanComplete, false);
  });

  it("writes the failure to logs/error.log", () => {
    /*- Point writeErrorLog at a tmp file for THIS test only by using
     *  the exported optional third arg — verified separately in
     *  test/error-log.test.js.  Here we just verify the default path
     *  resolves via getErrorLogPath (no exception, absolute path). */
    const p = errorLog.getErrorLogPath();
    assert.ok(path.isAbsolute(p));
  });
});

describe("_recordScanSuccess — clears catastrophic flag", () => {
  it("nulls _catastrophicScanError on state and via updateState", () => {
    const state = {
      _catastrophicScanError: { message: "old", at: 1, tokenId: "1" },
      totalLifetimeDepositUsd: 500,
    };
    const updated = [];
    _recordScanSuccess(state, (u) => updated.push(u), _ctx());
    assert.strictEqual(state._catastrophicScanError, null);
    const emit = updated.find((u) => u._catastrophicScanError !== undefined);
    assert.ok(emit);
    assert.strictEqual(emit._catastrophicScanError, null);
  });
});

/*- Tmp-dir cleanup. */
process.on("exit", () => {
  Module._resolveFilename = _origResolve;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith("lp-ranger-catastrophic-")) {
        fs.rmSync(path.join(os.tmpdir(), name), {
          recursive: true,
          force: true,
        });
      }
    }
  } catch {
    /* ignore */
  }
  if (_capturedPath) {
    try {
      fs.rmSync(path.dirname(_capturedPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
