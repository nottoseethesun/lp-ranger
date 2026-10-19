"use strict";

/**
 * @file test/dashboard-ui-settings.test.js
 * @description The dashboard settings the server sends, as the page holds
 *   them (public/dashboard-ui-settings.js), and the page's code that can
 *   run before they arrive.
 *
 *   Startup asks `GET /api/ui-defaults` right after the blockchain, and
 *   starts nothing that reads the settings until the answer is in. A few
 *   things can run before it by design: a first visit's privacy and sound
 *   defaults, a copy icon clicked in the first moment, an Activity Log
 *   entry. Until the answer, privacy blurs, sounds stay silent, code that
 *   waits on the settings waits, and the log keeps every entry. The page
 *   holds one answer, so these cases run in order in one process: first
 *   before the settings land, then after.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadShippedDefaults } = require("../src/load-merged-defaults");
const { indexHtmlDocument } = require("./helpers/index-html");

const SHIPPED = loadShippedDefaults(
  "ui-defaults_non-layout_for-server-up-scenario.json",
);

/*-
 *  The answer the scripted server gives: the shipped settings with an
 *  operator's values on top, each moved off its shipped value.
 */
const ANSWER = {
  ...SHIPPED,
  throttleNearLimitPct: 55,
  soundsEnabled: !SHIPPED.soundsEnabled,
  privacyBlurWalletAddresses: !SHIPPED.privacyBlurWalletAddresses,
  privacyUsdAmountThreshold: 250,
  activityLogMaxEntries: 10,
};

let ui;
let sounds;
let privacy;
let helpers;

// Whether code handed to `withUiSettings` before the answer has run.
let ranOnceLoaded = false;

before(async () => {
  ui = await import("../public/dashboard-ui-settings.js");
  sounds = await import("../public/dashboard-sounds.js");
  privacy = await import("../public/dashboard-privacy-subform.js");
  helpers = await import("../public/dashboard-helpers.js");
  localStorage.clear();
  /*-
   *  The Activity Log's list and entry template, from the real page, so
   *  an entry is built exactly as the dashboard builds one.
   */
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    document.importNode(page.getElementById("tplActItem"), true),
    document.importNode(page.getElementById("actList"), true),
  );
});

/** Log `n` Activity Log entries. */
function logEntries(n) {
  for (let i = 0; i < n; i++)
    helpers.act(helpers.ACT_ICONS.gear, "fee", "Entry", `number ${i}`);
}

const entryCount = () => document.getElementById("actList").children.length;

describe("before the server has sent the settings", () => {
  it("refuses a read, naming the setting", () => {
    assert.equal(ui.uiSettingsLoaded(), false);
    assert.throws(
      () => ui.uiSetting("throttleNearLimitPct"),
      /throttleNearLimitPct was read before the server sent the settings/,
    );
  });

  it("plays no sound for a browser with no saved choice", () => {
    assert.equal(sounds.isSoundsEnabled(), false);
  });

  it("blurs wallet addresses and every USD amount for a browser with no saved choice", () => {
    assert.equal(privacy.isPrivacyBlurWalletEnabled(), true);
    assert.equal(privacy.isPrivacyBlurUsdEnabled(), true);
    assert.equal(privacy.getPrivacyUsdThreshold(), 0);
  });

  it("keeps a browser's saved choices", () => {
    localStorage.setItem("9mm_sounds_enabled", "1");
    localStorage.setItem("9mm_privacy_blur_wallet", "0");
    try {
      assert.equal(sounds.isSoundsEnabled(), true);
      assert.equal(privacy.isPrivacyBlurWalletEnabled(), false);
    } finally {
      localStorage.clear();
    }
  });

  it("keeps every Activity Log entry, the cap not yet known", () => {
    logEntries(12);
    assert.equal(entryCount(), 12);
  });

  it("holds code that waits on the settings until they land", () => {
    ui.withUiSettings(() => {
      ranOnceLoaded = true;
    });
    assert.equal(ranOnceLoaded, false);
  });
});

describe("loadUiSettings", () => {
  it("asks again until an answer holds the settings, counting each miss", async () => {
    const answers = [
      { ok: true, json: async () => ({}) },
      { ok: true, json: async () => ANSWER },
    ];
    const asked = [];
    let misses = 0;
    let answered = 0;
    const settings = await ui.loadUiSettings({
      fetchFn: async (url) => {
        asked.push(url);
        return answers.shift();
      },
      onUnanswered: () => misses++,
      onAnswered: () => answered++,
      askEveryMs: 1,
      warnFn: () => {},
    });
    assert.deepEqual(asked, ["/api/ui-defaults", "/api/ui-defaults"]);
    assert.equal(misses, 1);
    assert.equal(answered, 1);
    assert.equal(settings.throttleNearLimitPct, 55);
    assert.equal(ranOnceLoaded, true, "the waiting code ran once they landed");
  });

  it("settles the ready promise with the settings", async () => {
    const settings = await ui.uiSettingsReady;
    assert.equal(settings.throttleNearLimitPct, 55);
  });
});

describe("once the server has sent the settings", () => {
  it("returns each, an operator's values included", () => {
    assert.equal(ui.uiSettingsLoaded(), true);
    assert.equal(ui.uiSetting("throttleNearLimitPct"), 55);
  });

  it("refuses a setting the server does not send", () => {
    assert.throws(
      () => ui.uiSetting("noSuchSetting"),
      /noSuchSetting is not a setting the server sends/,
    );
  });

  it("takes a first visit's sound and privacy defaults from them", async () => {
    assert.equal(sounds.isSoundsEnabled(), ANSWER.soundsEnabled);
    assert.equal(privacy.getPrivacyUsdThreshold(), 250);
    assert.equal(
      privacy.isPrivacyBlurWalletEnabled(),
      ANSWER.privacyBlurWalletAddresses,
    );
    /*-
     *  Sounds are off until an answer, and on as shipped, so no single
     *  answer tells an ignored one from a written-in one. A second
     *  answer turns them the other way.
     */
    await ui.loadUiSettings({
      fetchFn: async () => ({
        ok: true,
        json: async () => ({ ...ANSWER, soundsEnabled: !ANSWER.soundsEnabled }),
      }),
      onUnanswered: () => {},
      onAnswered: () => {},
      askEveryMs: 1,
      warnFn: () => {},
    });
    assert.equal(sounds.isSoundsEnabled(), !ANSWER.soundsEnabled);
  });

  it("trims the Activity Log to the cap at the next entry", () => {
    logEntries(1);
    assert.equal(entryCount(), ANSWER.activityLogMaxEntries);
  });

  it("runs code that waits on them at once", () => {
    let ran = false;
    ui.withUiSettings(() => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});

describe("startup", () => {
  it("asks for the settings after the blockchain and before anything that reads them", () => {
    /*-
     *  The order lives in dashboard-init.js, whose import runs the whole
     *  page, so it is read rather than run: the chain first, then the
     *  settings, then everything `_afterDisclaimer` starts, polling and
     *  the heap log among it.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "public", "dashboard-init.js"),
      "utf8",
    );
    const chain = src.indexOf("await loadActiveChain(");
    const settings = src.indexOf("await loadUiSettings(");
    const rest = src.indexOf("_afterDisclaimer();", settings);
    assert.ok(chain > -1, "startup asks for the blockchain");
    assert.ok(settings > chain, "then for the settings");
    assert.ok(rest > settings, "before it starts the rest of the page");
  });
});
