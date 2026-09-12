/**
 * @file test/moralis-enabled-toggle.test.js
 * @description Tests the "Use Moralis Key" switch.
 *
 * The point of the setting is that turning Moralis OFF and DELETING the
 * key are different acts. An operator whose quota has run out wants the
 * calls to stop; they do not want to throw the key away and paste it
 * back next month. So the two states have to stay independent, and the
 * gate has to sit in one place — three copies of "key && enabled" is
 * three chances for one of them to keep calling.
 */

"use strict";

require("global-jsdom/register");

const { describe, it, beforeEach, before } = require("node:test");
const assert = require("assert");

const holder = require("../src/api-key-holder");
const { GLOBAL_KEYS } = require("../src/bot-config-v2");
const { readBotConfigDefaults } = require("../src/bot-config-defaults");

describe("api-key-holder — enabled is separate from present", () => {
  beforeEach(() => {
    holder.setApiKey("moralis", "TESTKEY");
    holder.setServiceEnabled("moralis", true);
  });

  it("defaults to enabled for a service nobody has toggled", () => {
    /*- Absent must mean on, so adding this setting cannot change how an
     *  existing install behaves. */
    assert.strictEqual(holder.isServiceEnabled("never-touched"), true);
  });

  it("keeps the key when the service is turned off", () => {
    holder.setServiceEnabled("moralis", false);
    assert.strictEqual(holder.isServiceEnabled("moralis"), false);
    assert.strictEqual(
      holder.getApiKey("moralis"),
      "TESTKEY",
      "turning it off must not discard the key — that is the whole point",
    );
  });

  it("can be turned back on without re-entering the key", () => {
    holder.setServiceEnabled("moralis", false);
    holder.setServiceEnabled("moralis", true);
    assert.strictEqual(holder.isServiceEnabled("moralis"), true);
    assert.strictEqual(holder.getApiKey("moralis"), "TESTKEY");
  });

  it("treats only an explicit false as off", () => {
    /*- A malformed value must not silently disable a price source the
     *  operator may be paying for. */
    for (const v of [true, undefined, null, 1, "no"]) {
      holder.setServiceEnabled("moralis", v);
      assert.strictEqual(
        holder.isServiceEnabled("moralis"),
        true,
        `value ${JSON.stringify(v)} should not disable the service`,
      );
    }
    holder.setServiceEnabled("moralis", false);
    assert.strictEqual(holder.isServiceEnabled("moralis"), false);
  });

  it("does not leak the toggle across services", () => {
    holder.setApiKey("other", "K2");
    holder.setServiceEnabled("moralis", false);
    assert.strictEqual(holder.isServiceEnabled("other"), true);
  });
});

describe("moralisEnabled — the saved setting", () => {
  it("is a global config key the dashboard can save", () => {
    assert.ok(
      GLOBAL_KEYS.includes("moralisEnabled"),
      "POST /api/config must accept it, or the switch saves nothing",
    );
  });

  it("ships defaulting to on", () => {
    assert.strictEqual(readBotConfigDefaults().moralisEnabled, true);
  });

  it("is documented in the OpenAPI schema", () => {
    /*- check-openapi-sync gates this too; asserting it here names the
     *  reason rather than leaving a lint failure to explain itself. */
    const spec = require("../docs/openapi.json");
    const props =
      spec.paths["/api/config"].post.requestBody.content["application/json"]
        .schema.properties;
    assert.ok(props.moralisEnabled, "undocumented config keys fail the gate");
    assert.strictEqual(props.moralisEnabled.type, "boolean");
  });
});

describe("the gate price lookups actually consult", () => {
  beforeEach(() => {
    holder.setApiKey("moralis", "TESTKEY");
    holder.setServiceEnabled("moralis", true);
  });

  /*- Mirrors nothing: this is the same two-call rule price-fetcher's
   *  _moralisKey uses, asserted through the real holder. What matters is
   *  that "off" and "no key" are indistinguishable to a caller, because
   *  both mean the same thing to it — fall through to GeckoTerminal. */
  const resolve = () =>
    holder.isServiceEnabled("moralis") ? holder.getApiKey("moralis") : null;

  it("yields the key when enabled and present", () => {
    assert.strictEqual(resolve(), "TESTKEY");
  });

  it("yields nothing when switched off", () => {
    holder.setServiceEnabled("moralis", false);
    assert.strictEqual(resolve(), null);
  });

  it("yields nothing when there is no key, however the switch sits", () => {
    holder.setApiKey("moralis", "");
    assert.strictEqual(resolve(), null);
    holder.setServiceEnabled("moralis", false);
    assert.strictEqual(resolve(), null);
  });
});

/*- The dialog itself, under jsdom.
 *
 *  These exist because the first version of refreshMoralisToggle looked
 *  the row up with `closest(".9mm-pos-mgr-moralis-use-row")`. That class
 *  begins with a digit, which is fine in HTML and illegal in an
 *  unescaped CSS selector, so the call threw a DOMException — before
 *  the control was disabled or checked, and inside a promise nobody
 *  awaited. The switch would have sat there looking plausible and
 *  reflecting nothing. Holder-level tests cannot catch that; only
 *  driving the DOM path can. */
describe("the dialog control itself", () => {
  let mod;

  before(async () => {
    mod = await import("../public/dashboard-moralis-key.js");
  });

  /** The dialog fragment, matching public/index.html. */
  function renderDialog() {
    document.body.innerHTML = `
      <div class="9mm-pos-mgr-moralis-use-row" id="moralisEnabledRow">
        <span class="9mm-pos-mgr-range-mode-label">Use Moralis Key</span>
        <label class="9mm-pos-mgr-range-toggle" id="moralisEnabledToggleWrap">
          <input type="checkbox" id="moralisEnabledToggle">
          <span class="9mm-pos-mgr-toggle-track"></span>
        </label>
      </div>
      <span id="moralisKeyDot"></span>`;
  }

  /** Stub the status endpoint the refresh consults. */
  function stubStatus(moralis) {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ moralis }),
    });
  }

  it("does not throw while reading the dialog", async () => {
    /*- The regression: an invalid selector threw here and left the
     *  control untouched. */
    renderDialog();
    stubStatus("valid");
    await mod.refreshMoralisToggle();
    assert.ok(true, "refreshMoralisToggle completed");
  });

  it("disables the switch when no key is configured", async () => {
    renderDialog();
    stubStatus("none");
    await mod.refreshMoralisToggle();
    const box = document.getElementById("moralisEnabledToggle");
    assert.strictEqual(box.disabled, true, "no key means nothing to use");
    assert.strictEqual(box.checked, false);
    assert.ok(
      document
        .getElementById("moralisEnabledRow")
        .classList.contains("disabled"),
      "the row should read as unavailable, not merely inert",
    );
  });

  it("enables it and defaults to on once a key exists", async () => {
    renderDialog();
    stubStatus("valid");
    await mod.refreshMoralisToggle();
    const box = document.getElementById("moralisEnabledToggle");
    assert.strictEqual(box.disabled, false);
    assert.strictEqual(
      box.checked,
      true,
      "a key nobody has toggled is in use, so the switch must show on",
    );
  });

  it("enables it even when the key is out of quota", async () => {
    /*- Out of quota is exactly when an operator reaches for this
     *  switch; refusing to let them touch it would be backwards. */
    renderDialog();
    stubStatus("quota");
    await mod.refreshMoralisToggle();
    assert.strictEqual(
      document.getElementById("moralisEnabledToggle").disabled,
      false,
    );
  });

  it("survives the dialog not being in the DOM", async () => {
    document.body.innerHTML = "";
    stubStatus("valid");
    await mod.refreshMoralisToggle();
    assert.ok(true, "no throw when the control is absent");
  });
});
