"use strict";

/**
 * @file test/dashboard-compound-scan-wait.test.js
 * @description The Compound Now dialog (public/dashboard-compound.js),
 *   which opens when the server refuses a Compound Now because a scan is
 *   running on the position: the server's words beside a spinner, with
 *   Cancel and no confirm button. Once a status answer says the scan has
 *   ended, its Compound Now button comes back, and asks again.
 *
 *   Uses jsdom (via `global-jsdom/register`) and the real dialog from
 *   `public/index.html`. A `globalThis.fetch` stub answers the requests,
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
const KEY = `pulsechain-${WALLET}-${PM}-2`;
const WORDS =
  "LP Ranger is reading this position's history from the blockchain.";

let compound;
let pollMs;
let scanning;
let answer;
let requests;

before(async () => {
  await learnActiveChain();
  pollMs = (await learnUiSettings()).dashboardPollIntervalMs;
  compound = await import("../public/dashboard-compound.js");
  const store = await import("../public/dashboard-positions-store.js");
  store.posStore.add({
    walletAddress: WALLET,
    contractAddress: PM,
    positionType: "nft",
    tokenId: "2",
  });
  store.posStore.select(0);
  store.setPositionManaged("2", true);
  const { _setStatusReaderForTests } =
    await import("../public/dashboard-scan-wait.js");
  _setStatusReaderForTests(() => ({
    _allPositionStates: { [KEY]: { scanInProgress: scanning } },
  }));
});

beforeEach(() => {
  const page = indexHtmlDocument();
  // The dialog, and the template a Compound Blocked dialog is built from.
  document.body.replaceChildren(
    document.importNode(page.getElementById("compoundScanWaitModal"), true),
    document.importNode(page.getElementById("tplStatusModal"), true),
  );
  scanning = true;
  answer = { ok: false, scanInProgress: true, error: WORDS, positionKey: KEY };
  requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: answer.ok, status: 200, json: async () => answer };
  };
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  compound.closeCompoundScanWait();
  mock.timers.reset();
});

const modal = () => document.getElementById("compoundScanWaitModal");
const notice = () => document.getElementById("compoundScanWait");
const confirmButton = () =>
  document.getElementById("compoundScanWaitConfirmBtn");
const isShown = (el) => !el.classList.contains("hidden");
// A class that begins with a digit is no CSS selector, so by its name.
const cautions = () =>
  document.getElementsByClassName("9mm-pos-mgr-modal-caution").length;

describe("Compound Now, refused while a scan runs", () => {
  it("opens the dialog with the server's words and Cancel, and no confirm button", async () => {
    await compound.compoundNow();
    assert.equal(isShown(modal()), true);
    assert.equal(notice().textContent, WORDS);
    assert.equal(notice().classList.contains("9mm-pos-mgr-is-shown"), true);
    assert.equal(confirmButton().hidden, true);
    assert.equal(
      document.getElementById("compoundScanWaitCancelBtn").hidden,
      false,
    );
    assert.equal(cautions(), 0, "no Compound Blocked dialog over it");
  });

  it("offers its button once the scan has ended, which asks again", async () => {
    await compound.compoundNow();
    mock.timers.tick(pollMs);
    assert.equal(confirmButton().hidden, true, "still scanning");
    scanning = false;
    mock.timers.tick(pollMs);
    assert.equal(confirmButton().hidden, false);
    assert.equal(notice().classList.contains("9mm-pos-mgr-is-shown"), false);
    assert.equal(isShown(modal()), true, "the dialog stays open");
    answer = { ok: true, positionKey: KEY };
    await compound.confirmCompoundAfterScan();
    assert.equal(requests, 2);
    assert.equal(isShown(modal()), false, "accepted, the dialog closes");
    assert.equal(confirmButton().disabled, false);
  });

  it("waits again when the next ask is refused for a scan too", async () => {
    await compound.compoundNow();
    scanning = false;
    mock.timers.tick(pollMs);
    scanning = true;
    await compound.confirmCompoundAfterScan();
    assert.equal(isShown(modal()), true);
    assert.equal(confirmButton().hidden, true);
  });

  it("stops waiting when cancelled", async () => {
    await compound.compoundNow();
    compound.closeCompoundScanWait();
    assert.equal(isShown(modal()), false);
    assert.equal(confirmButton().hidden, false, "fresh for the next time");
    assert.equal(notice().textContent, "");
  });

  it("shows Compound Blocked, not the dialog, for any other refusal", async () => {
    answer = {
      ok: false,
      error: "Position not running or syncing",
      positionKey: KEY,
    };
    await compound.compoundNow();
    assert.equal(isShown(modal()), false);
    assert.equal(cautions(), 1);
  });
});
