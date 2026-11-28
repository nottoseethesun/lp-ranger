"use strict";

/**
 * @file test/dashboard-rebalance-log-notice.test.js
 * @description The Rebalance log error dialog, driven through the page's
 *   own poll (src/client/web/js/dashboard-data.js) on its markup
 *   (src/client/web/index.html). Every status answer carries the last
 *   failed read or write of the rebalance log since the server started
 *   (`rebalanceLogProblem`, src/bot/rebalance-log.js): the server's words
 *   for the operator, and when. The tab shows each failure once, the
 *   words one paragraph per block and never as markup; a later failure
 *   shows again, in place of the dialog should it still be open.
 *
 *   The tab remembers what it has shown, so the cases run in order, in
 *   a process of their own.
 */

require("global-jsdom/register");

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0xAbCdEf0000000000000000000000000000000001";

/** The server's words for a failed read, as src/bot/rebalance-log.js writes them. */
const READ_FAILED = [
  "LP Ranger could not read its rebalance log, /lp/app-data/rebalance_log.json.",
  "Check the file's permissions, and whether the disk is full. Then:",
  "1. Restart LP Ranger: its server (or headless bot) and the web browser.",
  "2. In the dashboard, open Settings → Reload Current Position.",
  "3. If the app still does not work on restart, you will need to remove the old log: run npm run build-and-start -- --delete-all-caches-and-logs, which removes it with all of LP Ranger's other caches and logs.",
].join("\n\n");

/** An answer as the dashboard reads one, its body `body`. */
const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

// What the scripted server's status answers carry.
const server = { rebalanceLogProblem: null };

let poll, notices;
let savedFetch;

before(async () => {
  /*-
   *  TEST-ONLY global swap, for this file's own process, put back in
   *  `after`: the dashboard asks the server through the browser's fetch.
   */
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === "/api/status")
      return answer({
        global: {
          walletAddress: WALLET,
          walletJustChanged: null,
          importingWallet: false,
          walletUnlocked: false,
          clearWalletRefusal: null,
          importWalletRefusal: null,
          startRefusal: null,
          rebalanceLogProblem: server.rebalanceLogProblem,
          managedPositions: [],
        },
        positions: {},
      });
    return answer({ ok: false });
  };
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  await import("../src/client/web/js/dashboard-data.js");
  poll = await import("../src/client/web/js/dashboard-data-poll.js");
  notices = await import("../src/client/web/js/dashboard-app-notices.js");
});

after(() => {
  globalThis.fetch = savedFetch;
});

/** Let every request under way be answered and shown. */
async function settled() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Ask the server once, as the page's poll does, and show the answer. */
async function answered() {
  poll.pollNow();
  await settled();
}

/** Every Rebalance log error dialog on the page. */
const dialogs = () =>
  document.querySelectorAll(`[id="${notices.REBALANCE_LOG_NOTICE_ID}"]`);

/** The paragraphs of the one dialog on the page. */
const paragraphs = () =>
  [...dialogs()[0].querySelectorAll("p")].map((p) => p.textContent);

describe("the Rebalance log error dialog", () => {
  it("is not shown while the answers carry no failure", async () => {
    await answered();
    assert.equal(dialogs().length, 0);
  });

  it("shows the server's words, one paragraph per block", async () => {
    server.rebalanceLogProblem = { message: READ_FAILED, at: 1 };
    await answered();
    assert.equal(dialogs().length, 1);
    const dialog = dialogs()[0];
    assert.equal(dialog.querySelector("h3").textContent, "Rebalance log error");
    assert.deepEqual(paragraphs(), READ_FAILED.split("\n\n"));
  });

  it("shows a failure once: the next answers carrying it show nothing more", async () => {
    await answered();
    assert.equal(dialogs().length, 1, "not added again");
    dialogs()[0].querySelector("[data-dismiss-modal]").click();
    assert.equal(dialogs().length, 0, "OK closes it");
    await answered();
    assert.equal(dialogs().length, 0, "not shown again");
  });

  it("shows a later failure, in place of the dialog still open", async () => {
    server.rebalanceLogProblem = { message: "First.\n\nAdvice.", at: 2 };
    await answered();
    server.rebalanceLogProblem = {
      message: "LP Ranger could not write to it.\n\n<b>Advice.</b>",
      at: 3,
    };
    await answered();
    assert.equal(dialogs().length, 1, "one dialog");
    assert.deepEqual(paragraphs(), [
      "LP Ranger could not write to it.",
      "<b>Advice.</b>",
    ]);
    assert.equal(
      dialogs()[0].querySelector("b"),
      null,
      "server text is never markup",
    );
  });
});
