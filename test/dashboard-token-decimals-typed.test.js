"use strict";

/**
 * @file test/dashboard-token-decimals-typed.test.js
 * @description What the Pool Details decimals form sends for what the
 *   operator typed.
 *
 *   The server decides whether a decimals is usable, and a value sent as
 *   null means "clear the override". So the form sends null only for an
 *   empty field; a mistyped value goes as typed, for the server to refuse
 *   with its reason while the saved override stands. Mapped to null
 *   instead, a typo of 180 for 18 would delete the override it was meant
 *   to correct.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

let typedDecimals;

before(async () => {
  ({ typedDecimals } =
    await import("../src/client/web/dashboard-token-decimals.js"));
});

describe("typedDecimals", () => {
  it("clears only for an empty field", () => {
    assert.equal(typedDecimals(""), null);
    assert.equal(typedDecimals("   "), null);
  });

  it("sends a usable value as a number", () => {
    assert.equal(typedDecimals("18"), 18);
    assert.equal(typedDecimals(" 6 "), 6);
  });

  it("sends a value the server will refuse as typed, never as a clear", () => {
    assert.equal(typedDecimals("180"), 180);
    assert.equal(typedDecimals("1.8"), 1.8);
    assert.equal(typedDecimals("-1"), -1);
    assert.equal(typedDecimals("abc"), "abc");
  });
});
