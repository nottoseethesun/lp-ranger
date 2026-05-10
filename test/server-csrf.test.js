/**
 * @file test/server-csrf.test.js
 * @description Unit tests for the CSRF token module in src/server-csrf.js.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const util = require("node:util");
const {
  createToken,
  verifyToken,
  readCsrfTunable,
  handleCsrf,
} = require("../src/server-csrf");

describe("CSRF token module", () => {
  it("createToken returns a token, future expiry, and refreshIntervalMs", () => {
    const { token, expiresAt, refreshIntervalMs } = createToken();
    assert.ok(typeof token === "string" && token.length > 0);
    assert.ok(expiresAt > Date.now());
    assert.ok(typeof refreshIntervalMs === "number" && refreshIntervalMs > 0);
  });

  it("refreshIntervalMs is strictly less than token TTL", () => {
    const { tokenTtlMs, refreshIntervalMs } = readCsrfTunable();
    assert.ok(
      refreshIntervalMs < tokenTtlMs,
      "client must refresh before server-side expiry",
    );
  });

  it("verifyToken accepts a valid token", () => {
    const { token } = createToken();
    const result = verifyToken(token);
    assert.strictEqual(result.valid, true);
  });

  it("verifyToken rejects undefined", () => {
    const result = verifyToken(undefined);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason.includes("Missing"));
  });

  it("verifyToken rejects a bogus token", () => {
    const result = verifyToken("not-a-real-token");
    assert.strictEqual(result.valid, false);
  });

  it("each createToken call returns a unique token", () => {
    const a = createToken().token;
    const b = createToken().token;
    assert.notStrictEqual(a, b);
  });

  it("readCsrfTunable returns positive numeric fields", () => {
    const { tokenTtlMs, refreshIntervalMs } = readCsrfTunable();
    assert.ok(typeof tokenTtlMs === "number" && tokenTtlMs > 0);
    assert.ok(typeof refreshIntervalMs === "number" && refreshIntervalMs > 0);
  });
});

describe("handleCsrf — silent-retry observability", () => {
  /*- Each test uses a unique URL so the in-module `_recent403` ring
   *  buffer never collides across tests, sidestepping the need for a
   *  test-only reset.  The buffer's 30 s window is safely larger than
   *  the test runtime. */

  let _logs;
  let _warns;
  let _origLog;
  let _origWarn;

  /*- Capture console output as ALREADY-FORMATTED strings — `console.log`
   *  printf-style format args (`%s`, `%d`, …) need util.format() to
   *  resolve before substring/regex matching, otherwise the captured
   *  array stores the raw format string with placeholders intact. */
  function _captureConsole() {
    _logs = [];
    _warns = [];
    _origLog = console.log;
    _origWarn = console.warn;
    console.log = (...args) => _logs.push(util.format(...args));
    console.warn = (...args) => _warns.push(util.format(...args));
  }
  function _restoreConsole() {
    console.log = _origLog;
    console.warn = _origWarn;
  }

  function _makeReq(method, url, token) {
    return {
      method,
      url,
      headers: token ? { "x-csrf-token": token } : {},
    };
  }

  function _makeJsonResponse() {
    const calls = [];
    function jsonResponse(res, status, body) {
      calls.push({ res, status, body });
    }
    return { jsonResponse, calls };
  }

  beforeEach(() => {
    _captureConsole();
  });
  afterEach(() => {
    _restoreConsole();
  });

  it("logs '403' warning and stores the (method, url) on bad token", () => {
    const url = "/api/test/csrf-403-record-" + Date.now();
    const { jsonResponse, calls } = _makeJsonResponse();
    const handled = handleCsrf(
      _makeReq("POST", url, "garbage"),
      {},
      jsonResponse,
    );
    assert.strictEqual(handled, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].status, 403);
    assert.ok(_warns.some((s) => s.includes("[csrf] 403")));
  });

  it("logs '[csrf] retry succeeded' on next valid verify for the same (method, url)", () => {
    const url = "/api/test/csrf-retry-success-" + Date.now();
    const { jsonResponse } = _makeJsonResponse();
    handleCsrf(_makeReq("POST", url, "garbage"), {}, jsonResponse);

    const { token } = createToken();
    const handled = handleCsrf(_makeReq("POST", url, token), {}, jsonResponse);
    assert.strictEqual(
      handled,
      false,
      "valid verify must let the request fall through",
    );

    const successLogs = _logs.filter((s) =>
      s.includes("[csrf] retry succeeded for POST " + url),
    );
    assert.strictEqual(
      successLogs.length,
      1,
      "exactly one retry-succeeded log line, mirroring the prior 403 warning",
    );
  });

  it("does NOT log retry-succeeded when there was no prior 403 for that path", () => {
    const url = "/api/test/csrf-no-prior-403-" + Date.now();
    const { jsonResponse } = _makeJsonResponse();
    const { token } = createToken();
    handleCsrf(_makeReq("POST", url, token), {}, jsonResponse);
    const successLogs = _logs.filter((s) =>
      s.includes("[csrf] retry succeeded"),
    );
    assert.strictEqual(successLogs.length, 0);
  });

  it("does NOT log retry-succeeded when the success is on a DIFFERENT (method, url)", () => {
    const failUrl = "/api/test/csrf-cross-path-fail-" + Date.now();
    const okUrl = "/api/test/csrf-cross-path-ok-" + Date.now();
    const { jsonResponse } = _makeJsonResponse();
    handleCsrf(_makeReq("POST", failUrl, "garbage"), {}, jsonResponse);

    const { token } = createToken();
    handleCsrf(_makeReq("POST", okUrl, token), {}, jsonResponse);

    const successLogs = _logs.filter((s) =>
      s.includes("[csrf] retry succeeded"),
    );
    assert.strictEqual(
      successLogs.length,
      0,
      "ring buffer must key on (method, url); a different path is unrelated",
    );
  });

  it("only logs once per 403→success pair (second valid verify is a normal hit)", () => {
    const url = "/api/test/csrf-once-only-" + Date.now();
    const { jsonResponse } = _makeJsonResponse();
    handleCsrf(_makeReq("POST", url, "garbage"), {}, jsonResponse);

    const { token } = createToken();
    handleCsrf(_makeReq("POST", url, token), {}, jsonResponse);
    handleCsrf(_makeReq("POST", url, token), {}, jsonResponse);

    const successLogs = _logs.filter((s) =>
      s.includes("[csrf] retry succeeded"),
    );
    assert.strictEqual(
      successLogs.length,
      1,
      "the buffer entry is cleared after the first match — subsequent verifies are silent",
    );
  });
});
