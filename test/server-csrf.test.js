/**
 * @file test/server-csrf.test.js
 * @description Unit tests for the CSRF token module in src/server-csrf.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  createToken,
  verifyToken,
  readCsrfTunable,
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
