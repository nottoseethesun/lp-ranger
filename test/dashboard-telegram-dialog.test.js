"use strict";

/**
 * @file test/dashboard-telegram-dialog.test.js
 * @description The Telegram dialog's alerts come from the one list the
 *   server sends them from (src/telegram-notifications/telegram-events.js):
 *   the dialog builds a checkbox for each, labels it with the title its
 *   alert is sent under, and ticks it as the server's answer says. The
 *   markup lists no alert of its own, since a copy there would be a second
 *   list that drifts from the first. Driven on the dialog's own markup
 *   from public/index.html.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const {
  EVENT_DEFAULTS,
  eventTitle,
} = require("../src/telegram-notifications/telegram-events");
const { indexHtmlDocument } = require("./helpers/index-html");

const IDS = Object.keys(EVENT_DEFAULTS);

/** The operator's choices, the server's answer: two moved off default. */
const CHOSEN = { ...EVENT_DEFAULTS, oorTimeout: false, rebalanceSuccess: true };

let dialog;

before(async () => {
  globalThis.fetch = async (url) => {
    if (url === "/api/telegram/config")
      return {
        ok: true,
        json: async () => ({
          enabledEvents: CHOSEN,
          balancedThresholdPct: 2.5,
          configured: false,
        }),
      };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    document.importNode(page.getElementById("telegramModal"), true),
  );
  dialog = await import("../public/dashboard-telegram.js");
});

describe("the Telegram dialog", () => {
  it("lists no alert of its own in the markup", () => {
    const page = indexHtmlDocument();
    const modal = page.getElementById("telegramModal");
    assert.equal(modal.querySelectorAll('input[type="checkbox"]').length, 0);
  });

  it("labels each alert with its title and ticks the server's choices", async () => {
    await dialog.openTelegramModal();
    const boxes = document.querySelectorAll(
      '#telegramModal input[type="checkbox"]',
    );
    assert.deepEqual(
      [...boxes].map((b) => b.id),
      IDS.map((id) => `tgEvt_${id}`),
      "one checkbox per alert, in the list's order",
    );
    for (const id of IDS) {
      assert.equal(
        document.getElementById(`tgEvtTitle_${id}`).textContent,
        eventTitle(id, "2.5"),
      );
      assert.equal(
        document.getElementById(`tgEvt_${id}`).checked,
        CHOSEN[id],
        id,
      );
    }
  });

  it("builds the list once, however often the dialog opens", async () => {
    await dialog.openTelegramModal();
    await dialog.openTelegramModal();
    const boxes = document.querySelectorAll(
      '#telegramModal input[type="checkbox"]',
    );
    assert.equal(boxes.length, IDS.length);
  });
});
