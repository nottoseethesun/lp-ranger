"use strict";

/**
 * @file test/dashboard-config-save.test.js
 * @description Tests for `src/client/web/dashboard-config-save.js`, the one path
 *   a Bot Settings value takes to the server and the one way a refused
 *   value comes back.
 *
 *   Uses jsdom (via `global-jsdom/register`) so the browser ES module is
 *   imported and driven directly — no mirrored copy of the module under
 *   test. Its two decisions are exported so they can be driven without a
 *   server: `_settleSaveAnswer` names the field whose value the server
 *   refused, and `_refillRefused` fills it from the server through the
 *   refill the panel announces, which a case stands in for. The POST
 *   goes through `fetchWithCsrf`, which reaches the global `fetch`, and
 *   a test must not replace a global (feedback_no_global_monkey_patch).
 *
 *   What is pinned here: only a refused VALUE fills a field from the
 *   server and raises a dialog. `POST /api/config` also answers 400 for
 *   a malformed request — no position selected, most often — and acting
 *   on that one would discard what the operator typed and blame them
 *   for a field they never touched. The case the refill was made for, a
 *   switch between positions, is driven through the page in
 *   test/dashboard-refused-value.test.js.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;

before(async () => {
  mod = await import("../src/client/web/dashboard-config-save.js");
});

describe("the field a save's answer refuses", () => {
  const settle = (body) =>
    mod._settleSaveAnswer({
      ok: false,
      status: 400,
      body,
      inputs: { maxRebalancesPerDay: "inMaxReb" },
    });

  it("is the one holding the value the server named", () => {
    assert.deepEqual(
      settle({ error: "outside", invalidValueForKey: "maxRebalancesPerDay" })
        .refused,
      { inputId: "inMaxReb", error: "outside" },
    );
  });

  it("is none when the 400 was about the request, not the value", () => {
    assert.equal(
      settle({ error: "positionKey required for position-specific config" })
        .refused,
      null,
    );
  });

  it("is none when the refusal names a setting this save did not carry", () => {
    /*- One request can carry several keys — the Price Range Extension
     *  row sends a width and a boolean together. Only the field the
     *  server actually named is filled again. */
    assert.equal(
      settle({ error: "x", invalidValueForKey: "slippagePctToken0" }).refused,
      null,
    );
  });
});

describe("a refused field", () => {
  beforeEach(() => {
    document.body.innerHTML = `<input id="inMaxReb" value="99">`;
  });

  it("is emptied, filled from the server, and the dialog names the value in force", async () => {
    const seen = [];
    mod.announceRefill(async () => {
      seen.push(document.getElementById("inMaxReb").value);
      document.getElementById("inMaxReb").value = "6";
    });
    const msg = await mod._refillRefused({
      inputId: "inMaxReb",
      error: "Max Rebalances per Day is 99, which is outside what it accepts.",
    });
    assert.deepEqual(seen, [""], "emptied before the server's answer");
    assert.equal(document.getElementById("inMaxReb").value, "6");
    assert.match(msg, /was not accepted/);
    assert.match(msg, /outside what it accepts/);
    assert.match(msg, /value in force for this position stands: 6\./);
  });

  it("is filled by its own form after the panel, when the panel does not fill it", async () => {
    const order = [];
    mod.announceRefill(async () => order.push("panel"));
    await mod._refillRefused({ inputId: "inMaxReb" }, () => order.push("form"));
    assert.deepEqual(order, ["panel", "form"]);
  });
});
