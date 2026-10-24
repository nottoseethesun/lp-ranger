"use strict";

/**
 * @file test/dashboard-rebalance-scan-wait.test.js
 * @description The Rebalance Now dialog when the server refuses a
 *   rebalance because the position's scan is in progress
 *   (public/dashboard-rebalance-confirm.js): it stays open, showing the
 *   server's words beside a spinner, with Cancel and no confirm button;
 *   once a status answer says the scan has ended, the confirm button
 *   comes back, so the rebalance is confirmed at that moment's price.
 *
 *   Uses jsdom (via `global-jsdom/register`) and the real dialog from
 *   `public/index.html`. A `globalThis.fetch` stub answers the request,
 *   the dialog reads its status answers from the test, and the test
 *   runner's mocked `setTimeout` means the dialog looks at the next one
 *   only when a test advances the clock.
 */

require("global-jsdom/register");

const {
  describe,
  it,
  before,
  beforeEach,
  afterEach,
  mock,
} = require("node:test");
const assert = require("node:assert/strict");
const { indexHtmlDocument } = require("./helpers/index-html");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const KEY = `pulsechain-${WALLET}-${PM}-1`;
const WORDS =
  "LP Ranger is reading this position's history from the blockchain.";

let confirm;
let pollMs;
let scanning;
let answer;

before(async () => {
  await learnActiveChain();
  pollMs = (await learnUiSettings()).dashboardPollIntervalMs;
  confirm = await import("../public/dashboard-rebalance-confirm.js");
  const { posStore } = await import("../public/dashboard-positions-store.js");
  posStore.add({
    walletAddress: WALLET,
    contractAddress: PM,
    positionType: "nft",
    tokenId: "1",
  });
  posStore.select(0);
  const { _setStatusReaderForTests } =
    await import("../public/dashboard-scan-wait.js");
  _setStatusReaderForTests(() => ({
    _allPositionStates: { [KEY]: { scanInProgress: scanning } },
  }));
});

beforeEach(() => {
  const page = indexHtmlDocument();
  // The dialog, and the template a Rebalance Blocked dialog is built from.
  document.body.replaceChildren(
    document.importNode(page.getElementById("rebalanceIlWarningModal"), true),
    document.importNode(page.getElementById("tplStatusModal"), true),
  );
  scanning = true;
  answer = { ok: false, scanInProgress: true, error: WORDS, positionKey: KEY };
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => answer,
  });
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  confirm.closeRebalanceConfirm();
  mock.timers.reset();
});

const modal = () => document.getElementById("rebalanceIlWarningModal");
const notice = () => document.getElementById("rebalanceScanWait");
const confirmButton = () => document.getElementById("ilWarnConfirmBtn");
const isShown = (el) => !el.classList.contains("hidden");

describe("the Rebalance Now dialog, refused while a scan runs", () => {
  it("stays open with the server's words and Cancel, and no confirm button", async () => {
    confirm.openRebalanceConfirm();
    await confirm.confirmRebalance();
    assert.equal(isShown(modal()), true);
    assert.equal(notice().textContent, WORDS);
    assert.equal(notice().classList.contains("9mm-pos-mgr-is-shown"), true);
    assert.equal(confirmButton().hidden, true);
    assert.equal(document.getElementById("ilWarnCancelBtn").hidden, false);
    // A class that begins with a digit is no CSS selector, so by its name.
    assert.equal(
      document.getElementsByClassName("9mm-pos-mgr-modal-caution").length,
      0,
      "no Rebalance Blocked dialog over it",
    );
  });

  it("offers the confirm button again once the scan has ended", async () => {
    confirm.openRebalanceConfirm();
    await confirm.confirmRebalance();
    mock.timers.tick(pollMs);
    assert.equal(confirmButton().hidden, true, "still scanning");
    scanning = false;
    mock.timers.tick(pollMs);
    assert.equal(confirmButton().hidden, false);
    assert.equal(confirmButton().disabled, false);
    assert.equal(notice().classList.contains("9mm-pos-mgr-is-shown"), false);
    assert.equal(isShown(modal()), true, "the dialog stays open");
  });

  it("stops waiting when cancelled, and opens fresh the next time", async () => {
    confirm.openRebalanceConfirm();
    await confirm.confirmRebalance();
    confirm.closeRebalanceConfirm();
    assert.equal(isShown(modal()), false);
    confirm.openRebalanceConfirm();
    assert.equal(confirmButton().hidden, false);
    assert.equal(notice().textContent, "");
  });

  it("closes as before on an answer that is no scan refusal", async () => {
    answer = { ok: true, positionKey: KEY };
    confirm.openRebalanceConfirm();
    await confirm.confirmRebalance();
    assert.equal(isShown(modal()), false);
  });
});
