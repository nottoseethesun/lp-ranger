"use strict";

/**
 * @file test/dashboard-position-dialogs.test.js
 * @description When another position comes on screen, every dialog that
 *   belonged to the one before closes (public/dashboard-position-
 *   dialogs.js), as the user decided on 2026-10-18. A dialog's Save acts
 *   on the position on screen when it is clicked, so a dialog left open
 *   across a switch, by the browser's Back button say, would save the
 *   first position's prices or decimals under the second.
 *
 *   Each closes as its own Cancel or Close does: a slippage confirmation
 *   drops its pending save, a confirmation answers no, and the IL
 *   Baseline dialog records that it was seen, for its own position. A
 *   dialog about the install rather than a position stays, as do the
 *   alerts the server raises, each naming its own position, and a dialog
 *   whose work is still running; choosing the position already on
 *   screen closes nothing.
 *
 *   Driven through the page's own switch (`activateByTokenId`) on its
 *   markup from public/index.html, with the server's answers scripted.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const entry = (tokenId, token0) => ({
  walletAddress: WALLET,
  contractAddress: PM,
  positionType: "nft",
  tokenId,
  token0,
  token1: "0x" + "b2".repeat(20),
  token0Symbol: "AAA",
  token1Symbol: "BBB",
  fee: 2500,
  tickLower: -100,
  tickUpper: 100,
  liquidity: "1000",
});
// Two open positions in different pools.
const FIRST = entry("101", "0x" + "a1".repeat(20));
const SECOND = entry("102", "0x" + "a2".repeat(20));

const answer = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  clone() {
    return this;
  },
});

let positions, status, confirm, baseline, deposit;

before(async () => {
  /*-
   *  TEST-ONLY global swap: the dashboard asks the server through the
   *  browser's fetch and takes no stand-in for it. This answers for the
   *  server for the whole file, so it stays in place: the file runs in a
   *  process of its own, which no other file shares.
   */
  globalThis.fetch = async (url) => {
    if (url === "/api/status")
      return answer({ global: { walletAddress: WALLET }, positions: {} });
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: false, address: WALLET });
    if (url.startsWith("/api/is-position-managed"))
      return answer({ managed: false });
    return answer({ ok: false });
  };
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  const store = await import("../public/dashboard-positions-store.js");
  positions = await import("../public/dashboard-positions.js");
  status = await import("../public/dashboard-data-status.js");
  confirm = await import("../public/dashboard-confirm-dialog.js");
  baseline = await import("../public/dashboard-data-baseline.js");
  deposit = await import("../public/dashboard-data-deposit.js");
  const slippage = await import("../public/dashboard-per-token-slippage.js");
  const { wallet } = await import("../public/dashboard-wallet.js");
  wallet.address = WALLET;
  slippage.wirePerTokenSlippageEvents(
    (id, fn) => document.getElementById(id)?.addEventListener("click", fn),
    (id, fn) => document.getElementById(id)?.addEventListener("input", fn),
  );
  store.posStore.add(FIRST);
  store.posStore.add(SECOND);
});

beforeEach(() => {
  // Each case starts on the first position, with nothing open.
  positions.activateByTokenId(FIRST.tokenId);
  // By class name: a class that starts with a digit is not a selector.
  const overlays = document.getElementsByClassName("9mm-pos-mgr-modal-overlay");
  for (const ov of [...overlays]) ov.remove();
  localStorage.clear();
});

const el = (id) => document.getElementById(id);
const open = (id) => el(id).classList.remove("hidden");
const isOpen = (id) => !el(id).classList.contains("hidden");

describe("a switch to another position", () => {
  it("closes the dialogs that belonged to the one before", () => {
    for (const id of [
      "priceOverrideModal",
      "poolDetailsModal",
      "rebalanceIlWarningModal",
    ])
      open(id);
    el("curDepositInputWrap").classList.add("open");
    status._createModal("aNotice", "", "Compound Failed", "<p>x</p>");

    positions.activateByTokenId(SECOND.tokenId);

    for (const id of [
      "priceOverrideModal",
      "poolDetailsModal",
      "rebalanceIlWarningModal",
    ])
      assert.equal(isOpen(id), false, id);
    assert.equal(el("curDepositInputWrap").classList.contains("open"), false);
    assert.equal(el("aNotice"), null, "the notice is gone");
  });

  it("answers an open confirmation no", async () => {
    const answered = confirm.confirmViaDialog("tplReloadConfirmModal", {
      overlayId: "reloadConfirmModal",
      positionDialog: true,
    });
    positions.activateByTokenId(SECOND.tokenId);
    // A confirmation left unanswered must fail this, not hang it.
    const unanswered = new Promise((r) => setTimeout(r, 1000, "unanswered"));
    assert.equal(await Promise.race([answered, unanswered]), false);
    assert.equal(el("reloadConfirmModal"), null);
  });

  it("drops a slippage confirmation's pending save through its own Cancel", () => {
    let cancelled = 0;
    el("slipAbove5CancelBtn").addEventListener("click", () => cancelled++);
    open("slippageAbove5ConfirmModal");
    positions.activateByTokenId(SECOND.tokenId);
    assert.equal(isOpen("slippageAbove5ConfirmModal"), false);
    assert.equal(cancelled, 1);
  });

  it("records the IL Baseline dialog as seen for its own position", () => {
    baseline.checkHodlBaselineDialog({
      hodlBaselineNew: true,
      hodlBaseline: { entryValue: 100, mintDate: "2026-01-01" },
    });
    assert.equal(isOpen("hodlBaselineModal"), true);
    positions.activateByTokenId(SECOND.tokenId);
    assert.equal(isOpen("hodlBaselineModal"), false);
    const seen = (p) =>
      localStorage.getItem(
        deposit._poolKeyFrom(
          "9mm_hodl_acked_",
          p.walletAddress,
          p.contractAddress,
          p.token0,
          p.token1,
          p.fee,
        ),
      );
    assert.equal(seen(FIRST), "1", "the position it was about");
    assert.equal(seen(SECOND), null, "not the one now on screen");
  });

  it("leaves the install's dialogs, and one still working, open", () => {
    open("telegramModal");
    status._createModal("busyNotice", "", "Re-scanning", "<p>x</p>");
    el("busyNotice").dataset.busy = "1";
    positions.activateByTokenId(SECOND.tokenId);
    assert.equal(isOpen("telegramModal"), true);
    assert.notEqual(el("busyNotice"), null);
    el("telegramModal").classList.add("hidden");
  });

  it("leaves open the alerts the server raised, which would not come back", async () => {
    /*-
     *  Each names its own position, whichever is on screen, and shows
     *  once per episode: closed by a switch, the operator would never
     *  learn a rebalance had been aborted.
     */
    const alerts = await import("../public/dashboard-alerts.js");
    const warnings =
      await import("../public/dashboard-post-rebalance-modal.js");
    alerts._resetAlertsState();
    warnings._resetPostRebalanceModalState();
    alerts.showPerPositionAlerts({
      _allPositionStates: {
        [`pulsechain-${WALLET}-${PM}-${SECOND.tokenId}`]: {
          rebalancePaused: true,
          rebalanceError: "the pool moved",
          rangeRounded: { requested: 10, effective: 12 },
          activePosition: {},
        },
      },
    });
    const alert = () => document.querySelector('[id^="rebalanceErrorModal-"]');
    const warning = () =>
      [...document.getElementsByClassName("9mm-pos-mgr-modal-overlay")].find(
        (o) => o.textContent.includes("Range Width Adjusted"),
      );
    assert.ok(alert() && warning(), "both are up before the switch");
    positions.activateByTokenId(SECOND.tokenId);
    assert.ok(alert(), "the alert is still up");
    assert.ok(warning(), "the warning is still up");
  });
});

describe("choosing the position already on screen", () => {
  it("closes nothing", () => {
    open("priceOverrideModal");
    positions.activateByTokenId(FIRST.tokenId);
    assert.equal(isOpen("priceOverrideModal"), true);
    el("priceOverrideModal").classList.add("hidden");
  });
});
