"use strict";

/**
 * @file test/dashboard-position-browser-button.test.js
 * @description The header's positions button opens the position browser.
 *   Its label is empty in the page's markup until the position store
 *   fills it, so the button is wired by its id, whatever the label says.
 *   Driven on the real page, with the dashboard's own event handlers
 *   bound.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

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
  await learnActiveChain();
  await learnUiSettings();
  const events = await import("../public/dashboard-events.js");
  document.body.innerHTML = indexHtmlDocument().body.innerHTML;
  events.bindAllEvents();
});

describe("the header's positions button", () => {
  it("opens the position browser while its label is still empty", () => {
    const modal = document.getElementById("posBrowserModal");
    assert.equal(document.getElementById("headerPosLabel").textContent, "");
    assert.equal(modal.classList.contains("hidden"), true);
    document.getElementById("posBrowserBtn").click();
    assert.equal(modal.classList.contains("hidden"), false);
  });
});
