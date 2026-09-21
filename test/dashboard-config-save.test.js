"use strict";

/**
 * @file test/dashboard-config-save.test.js
 * @description Tests for `public/dashboard-config-save.js`, the one path
 *   a Bot Settings value takes to the server and the one way a refused
 *   value comes back.
 *
 *   Uses jsdom (via `global-jsdom/register`) so the browser ES module is
 *   imported and driven directly — no mirrored copy of the module under
 *   test. The decision `_applySaveRejection` makes is exported so it can
 *   be driven without a server: the POST goes through `fetchWithCsrf`,
 *   which reaches the global `fetch`, and a test must not replace a
 *   global (feedback_no_global_monkey_patch).
 *
 *   What is pinned here: the dashboard restores a field and raises a
 *   dialog ONLY for a refused VALUE. `POST /api/config` also answers 400
 *   for a malformed request — no position selected, most often — and
 *   acting on that one would discard what the operator typed and blame
 *   them for a field they never touched.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../public/dashboard-config-save.js");
});

describe("a save the server refuses", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="inInterval" value="300">`;
  });

  it("puts the field back to the last accepted value and says why", () => {
    mod.rememberGoodInput("inInterval", 300);
    document.getElementById("inInterval").value = "7200";
    const msg = mod._applySaveRejection("inInterval", "checkIntervalSec", {
      error: "Check Interval is 7200 sec, which is outside what it accepts.",
      invalidValueForKey: "checkIntervalSec",
    });
    assert.equal(document.getElementById("inInterval").value, "300");
    assert.match(msg, /was not accepted/);
    assert.match(msg, /outside what it accepts/);
    assert.match(msg, /set back to 300/);
  });

  it("stays silent when the 400 was about the request, not the value", () => {
    /*- This route also refuses a malformed request — no position
     *  selected, most often. That is not a bad value, so it neither
     *  raises a dialog nor touches what the operator typed. */
    mod.rememberGoodInput("inInterval", 300);
    document.getElementById("inInterval").value = "7200";
    const msg = mod._applySaveRejection("inInterval", "checkIntervalSec", {
      error: "positionKey required for position-specific config",
    });
    assert.equal(msg, null);
    assert.equal(document.getElementById("inInterval").value, "7200");
  });

  it("stays silent when the refusal names a different setting", () => {
    /*- One request can carry several keys — the Price Range Extension
     *  row sends a width and a boolean together. Only the field the
     *  server actually named goes back. */
    mod.rememberGoodInput("inInterval", 300);
    document.getElementById("inInterval").value = "7200";
    const msg = mod._applySaveRejection("inInterval", "checkIntervalSec", {
      error: "Slippage (Token 0) is 99%, which is outside what it accepts.",
      invalidValueForKey: "slippagePctToken0",
    });
    assert.equal(msg, null);
    assert.equal(document.getElementById("inInterval").value, "7200");
  });

  it("still reports when nothing good was recorded yet", () => {
    /*- An input the panel has never populated from the server, so
     *  there is no accepted value to go back to. */
    const msg = mod._applySaveRejection("inNeverPopulated", "someSetting", {
      error: "out of range",
      invalidValueForKey: "someSetting",
    });
    assert.match(msg, /its previous value/);
  });
});
