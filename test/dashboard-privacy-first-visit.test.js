"use strict";

/**
 * @file test/dashboard-privacy-first-visit.test.js
 * @description Privacy Mode's first-visit default. A browser with no
 *   saved choice follows `privacyModeEnabled`, which the server sends, and
 *   everything that blurs follows that one answer: the page-load restore,
 *   the re-blur after each status poll, and the LP Position Browser's
 *   rows. A switch and a blur that read the choice differently would
 *   disagree: with a default of on, the switch checked and nothing
 *   blurred.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { loadShippedDefaults } = require("../src/lib/load-merged-defaults");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

const SHIPPED = loadShippedDefaults(
  "ui-defaults_non-layout_for-server-up-scenario.json",
);
const BLUR = "9mm-pos-mgr-privacy-blur";
const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

let events;
let browser;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  // As at startup: the dashboard knows its chain before it keys a position.
  await learnActiveChain();
  const ui = await import("../src/client/web/dashboard-ui-settings.js");
  events = await import("../src/client/web/dashboard-events-manage.js");
  browser = await import("../src/client/web/dashboard-positions-browser.js");
  const { posStore } =
    await import("../src/client/web/dashboard-positions-store.js");
  posStore.add({
    walletAddress: WALLET,
    contractAddress: PM,
    positionType: "nft",
    tokenId: "7",
    token0Symbol: "AAA",
    token1Symbol: "BBB",
    fee: 3000,
    liquidity: "1000",
  });
  // The operator's first-visit default, moved off the shipped "off".
  await ui.loadUiSettings({
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ ...SHIPPED, privacyModeEnabled: true }),
    }),
    onUnanswered: () => {},
    onAnswered: () => {},
    askEveryMs: 1,
    warnFn: () => {},
  });
});

beforeEach(() => {
  localStorage.clear();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[
      "privacySwitch",
      "privacyIcon",
      "wsAddr",
      "posBrowserModal",
      "tplPosRow",
      "tplPosEmptyState",
    ].map((id) => document.importNode(page.getElementById(id), true)),
  );
  document.getElementById("wsAddr").textContent = WALLET;
  const kpi = document.createElement("div");
  kpi.className = "kpi-value";
  kpi.textContent = "$1,234.56";
  document.body.append(kpi);
});

const blurred = (el) => el.classList.contains(BLUR);

describe("Privacy Mode's first-visit default", () => {
  it("blurs a first visit when the operator's default is on", async () => {
    await events.restorePrivacyMode();
    assert.equal(document.getElementById("privacySwitch").checked, true);
    assert.ok(blurred(document.getElementById("wsAddr")), "wallet address");
    assert.ok(blurred(document.querySelector(".kpi-value")), "USD amount");
  });

  it("blurs what a status poll draws afterwards", async () => {
    await events.restorePrivacyMode();
    const drawn = document.createElement("div");
    drawn.className = "kpi-value";
    drawn.textContent = "$9,999.00";
    document.body.append(drawn);
    events.reapplyPrivacyBlur();
    assert.ok(blurred(drawn));
  });

  it("blurs the LP Position Browser's rows", async () => {
    await events.restorePrivacyMode();
    browser.renderPosBrowser();
    const parts = document.querySelectorAll(
      "#posList .pos-row-title, #posList .pos-row-meta",
    );
    assert.ok(parts.length > 0, "the browser drew a row");
    for (const el of parts) assert.ok(blurred(el), el.className);
  });

  it("keeps a browser's saved choice of off", async () => {
    localStorage.setItem("9mm_privacy_mode", "0");
    await events.restorePrivacyMode();
    assert.equal(document.getElementById("privacySwitch").checked, false);
    assert.equal(blurred(document.getElementById("wsAddr")), false);
    browser.renderPosBrowser();
    for (const el of document.querySelectorAll("#posList .pos-row-title"))
      assert.equal(blurred(el), false);
  });
});
