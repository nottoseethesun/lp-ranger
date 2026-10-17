"use strict";

/**
 * @file test/dashboard-moralis-status.test.js
 * @description The Moralis key dot in Settings, for a key the server
 *   reports stored but unused.
 *
 *   A key can be stored and still not be checked: the wallet is locked,
 *   Use Moralis Key is off, or the active chain is one Moralis is not
 *   asked about. Each of those must read as a stored key — falling
 *   through to "No Moralis API key configured" would tell the operator
 *   their key had vanished.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;
let realFetch;
let answer;

before(async () => {
  mod = await import("../public/dashboard-helpers.js");
});

beforeEach(() => {
  document.body.innerHTML =
    '<span id="moralisKeyDot"></span><input id="moralisKeyInput">';
  realFetch = globalThis.fetch;
  /*-
   *  TEST-ONLY global swap: `checkMoralisKeyStatus` asks the server with
   *  the global `fetch` and offers no seam for it. Restored pristine in
   *  `afterEach`, after each case's single call.
   */
  globalThis.fetch = async () => ({ json: async () => answer });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the Moralis key dot", () => {
  for (const [status, title] of [
    ["disabled", "Moralis API key stored but Use Moralis Key is off"],
    [
      "unsupported",
      "Moralis API key stored, but Moralis does not cover this chain",
    ],
    ["locked", "Moralis API key stored but wallet is locked"],
  ]) {
    it(`reads "${status}" as a stored key`, async () => {
      answer = { moralis: status };
      assert.equal(await mod.checkMoralisKeyStatus(), status);
      assert.equal(document.getElementById("moralisKeyDot").title, title);
      assert.equal(
        document.getElementById("moralisKeyInput").placeholder,
        "Paste replacement key",
      );
    });
  }

  it("says no key is configured only when the server says none is stored", async () => {
    answer = { moralis: "none" };
    await mod.checkMoralisKeyStatus();
    assert.equal(
      document.getElementById("moralisKeyDot").title,
      "No Moralis API key configured",
    );
    assert.equal(
      document.getElementById("moralisKeyInput").placeholder,
      "Paste key here",
    );
  });
});
