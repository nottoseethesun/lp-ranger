"use strict";

/**
 * @file test/dashboard-telegram-dialog.test.js
 * @description The Telegram dialog's alerts come from the one list the
 *   server sends them from (src/telegram-notifications/telegram-events.js):
 *   the dialog builds a checkbox for each, labels it with the title its
 *   alert is sent under, and ticks it as the server's answer says. The
 *   markup lists no alert of its own, since a copy there would be a second
 *   list that drifts from the first.
 *
 *   Until the server's choices arrive the checkboxes are disabled, and a
 *   save leaves the saved choices alone: boxes nobody filled would turn
 *   every alert off. Driven on the dialog's own markup from
 *   public/index.html, with the server's answers scripted.
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

const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

/*-
 *  The scripted server: `config` answers the dialog's question, and every
 *  save is kept, so a test can read what the dialog sent.
 */
const server = {
  config: async () =>
    answer({
      enabledEvents: CHOSEN,
      balancedThresholdPct: 2.5,
      configured: false,
    }),
  saved: [],
};

let dialog;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async (url, init) => {
    if (url === "/api/telegram/config" && init?.method === "POST") {
      server.saved.push(JSON.parse(init.body));
      return answer({ ok: true });
    }
    if (url === "/api/telegram/config") return server.config();
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    document.importNode(page.getElementById("telegramModal"), true),
  );
  dialog = await import("../public/dashboard-telegram.js");
  dialog.initTelegram();
});

const box = (id) => document.getElementById(`tgEvt_${id}`);

/** Click Save and let the save's answer land. */
async function saved() {
  document.getElementById("tgSaveBtn").click();
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  return server.saved.at(-1);
}

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
      assert.equal(box(id).checked, CHOSEN[id], id);
      assert.equal(box(id).disabled, false, id);
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

  it("sends the choices it shows once they came from the server", async () => {
    await dialog.openTelegramModal();
    box("oorTimeout").checked = true;
    const body = await saved();
    assert.deepEqual(body.enabledEvents, { ...CHOSEN, oorTimeout: true });
  });

  it("keeps the alerts disabled, and out of a save, while the server has not answered", async () => {
    const real = server.config;
    server.config = async () => {
      throw new Error("connection refused");
    };
    try {
      await dialog.openTelegramModal();
      for (const id of IDS) assert.equal(box(id).disabled, true, id);
      document.getElementById("tgBotToken").value = "123:abc";
      const body = await saved();
      assert.equal(body.botToken, "123:abc");
      assert.equal(
        Object.hasOwn(body, "enabledEvents"),
        false,
        "the saved choices are left alone",
      );
    } finally {
      server.config = real;
      document.getElementById("tgBotToken").value = "";
    }
  });
});
