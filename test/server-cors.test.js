/**
 * @file test/server-cors.test.js
 * @description Unit tests for the CORS / cross-origin guard in src/server-cors.js.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { _isLocalhostOrigin } = require("../src/server-cors");

describe("_isLocalhostOrigin", () => {
  it("accepts localhost with matching port", () => {
    assert.strictEqual(_isLocalhostOrigin("http://localhost:5555", 5555), true);
  });

  it("accepts 127.0.0.1 with matching port", () => {
    assert.strictEqual(_isLocalhostOrigin("http://127.0.0.1:5555", 5555), true);
  });

  it("accepts [::1] with matching port", () => {
    assert.strictEqual(_isLocalhostOrigin("http://[::1]:5555", 5555), true);
  });

  it("rejects wrong port", () => {
    assert.strictEqual(
      _isLocalhostOrigin("http://localhost:9999", 5555),
      false,
    );
  });

  it("rejects foreign hostname", () => {
    assert.strictEqual(_isLocalhostOrigin("http://evil.com:5555", 5555), false);
  });

  it("rejects malformed URL", () => {
    assert.strictEqual(_isLocalhostOrigin("not-a-url", 5555), false);
  });

  it("rejects empty string", () => {
    assert.strictEqual(_isLocalhostOrigin("", 5555), false);
  });
});
