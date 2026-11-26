"use strict";

/**
 * @file test/dashboard-reopen-skipped.test.js
 * @description What the page shows when a re-open's Manage answers that
 *   the position still holds liquidity, so the server manages it with no
 *   re-open rebalance (`reopenRebalanceSkipped`, src/bot/position-lifecycle.js):
 *   the server's words in a dialog and an Activity Log entry, and no
 *   rebalance shown under way. The page sends a re-open only for a
 *   position its list shows closed, which can be out of date. The answer
 *   is handed to `_settleRebalanceAnswer` directly: the request goes
 *   through the global `fetch`, which a test must not replace.
 */

require("global-jsdom/register");
const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const KEY = `pulsechain-${WALLET}-${PM}-101`;
const A = {
  walletAddress: WALLET,
  contractAddress: PM,
  positionType: "nft",
  tokenId: "101",
  token0: "0x" + "a1".repeat(20),
  token1: "0x" + "a2".repeat(20),
  token0Symbol: "AAA",
  token1Symbol: "AAB",
  fee: 2500,
  liquidity: "0",
};
const WORDS =
  "NFT #101 still holds liquidity, so LP Ranger manages it without a " +
  "re-open rebalance. Its Bot Settings decide when it rebalances.";

let confirm, posStore;

before(async () => {
  await learnActiveChain("pulsechain", "PulseChain");
  confirm = await import("../src/client/web/js/dashboard-rebalance-confirm.js");
  ({ posStore } =
    await import("../src/client/web/js/dashboard-positions-store.js"));
  posStore.add(A);
});

/** The titles of the Activity Log's entries, newest first. */
const loggedTitles = () =>
  [...document.querySelectorAll("#actList [data-tpl='title']")].map(
    (t) => t.textContent,
  );

/** The page's own markup, with A on screen. */
beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  posStore.select(posStore.entries.findIndex((p) => p.tokenId === "101"));
});

describe("a re-open of a position that still holds liquidity", () => {
  const settle = (data) =>
    confirm._settleRebalanceAnswer({
      data,
      requestKey: KEY,
      active: A,
      inFlight: null,
      url: "/api/position/manage",
      triggerActLabel: "Re-open Position",
    });
  // A class that begins with a digit is no CSS selector, so by its name.
  const lastDialog = () =>
    [...document.getElementsByClassName("9mm-pos-mgr-modal-caution")].pop();

  it("says the position is managed without a re-open rebalance, in the server's words", () => {
    settle({
      ok: true,
      key: KEY,
      tokenId: "101",
      reopenRebalanceSkipped: true,
      message: WORDS,
      positionKey: KEY,
    });
    const dialog = lastDialog();
    assert.ok(dialog !== undefined, "a dialog");
    assert.match(dialog.textContent, /Managed Without a Re-open/);
    const words = dialog.querySelector("[data-rebalance-error]");
    assert.equal(words.textContent, WORDS);
    assert.equal(words.children.length, 0, "nothing built from the answer");
  });

  it("logs that, and no re-open, in the Activity Log", () => {
    settle({
      ok: true,
      key: KEY,
      tokenId: "101",
      reopenRebalanceSkipped: true,
      message: WORDS,
      positionKey: KEY,
    });
    const titles = loggedTitles();
    assert.equal(titles[0], "Managed Without a Re-open");
    assert.equal(titles.includes("Re-open Position"), false);
  });

  it("logs a re-open the server makes as a re-open", () => {
    // The case the skip must not take over.
    settle({ ok: true, key: KEY, tokenId: "101", positionKey: KEY });
    assert.equal(loggedTitles()[0], "Re-open Position");
  });
});
