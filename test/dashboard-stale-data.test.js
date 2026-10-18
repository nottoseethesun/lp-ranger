"use strict";

/**
 * @file test/dashboard-stale-data.test.js
 * @description From the moment a position comes on screen until an answer
 *   about it has been shown, the dashboard's figures may still be another
 *   position's. public/dashboard-stale-data.js keeps that one flag, and
 *   its watch shows it on the page every `staleDataCheckIntervalMs`: the
 *   body's `data-position-data-stale` attribute, which the stylesheet
 *   dashes the figures from, and every part of the page inert but the
 *   disclaimer and the wallet unlock.
 *
 *   Driven on the page's own markup from public/index.html, with the
 *   watch's timer mocked so a test can step through its checks.
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
const fs = require("fs");
const path = require("path");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const A = {
  walletAddress: WALLET,
  contractAddress: PM,
  positionType: "nft",
  tokenId: "101",
};
const B = { ...A, tokenId: "202" };
// An ERC-20 entry: no NFT id, so the server is never asked about it.
const C = {
  walletAddress: WALLET,
  contractAddress: "0x" + "c3".repeat(20),
  positionType: "erc20",
};

let store, stale;

before(async () => {
  await learnActiveChain("pulsechain", "PulseChain");
  store = await import("../public/dashboard-positions-store.js");
  stale = await import("../public/dashboard-stale-data.js");
  for (const p of [A, B, C]) store.posStore.add(p);
});

/** Put a position on screen, as every switch does. */
const select = (p) =>
  store.posStore.select(
    store.posStore.entries.findIndex(
      (e) =>
        e.positionType === p.positionType &&
        e.contractAddress === p.contractAddress &&
        e.tokenId === p.tokenId,
    ),
  );

const onScreen = () => store.posStore.getActive();

describe("whether the figures on screen are stale", () => {
  // Each test starts with no answer shown.
  beforeEach(() => stale.forgetFreshAnswer());

  it("is stale from the moment a position comes on screen", () => {
    select(A);
    assert.equal(stale.isPositionDataStale(), true);
  });

  it("is fresh once an answer about that position has been shown", () => {
    select(A);
    stale.markPositionDataFresh(onScreen());
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("is stale again after a switch, until the new position's answer", () => {
    select(A);
    stale.markPositionDataFresh(onScreen());
    select(B);
    assert.equal(stale.isPositionDataStale(), true);
    stale.markPositionDataFresh(onScreen());
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("stays stale for an answer about the position switched from", () => {
    select(A);
    const a = onScreen();
    select(B);
    // A's answer, arriving late, is not shown.
    stale.markPositionDataFresh(a);
    assert.equal(stale.isPositionDataStale(), true);
    // So it does not count for A either, back on screen.
    select(A);
    assert.equal(stale.isPositionDataStale(), true);
  });

  it("is fresh back on the position whose answer is still held", () => {
    select(A);
    stale.markPositionDataFresh(onScreen());
    select(B);
    select(A);
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("is stale back on a position once a status answer read for another replaced its own", () => {
    select(A);
    stale.markPositionDataFresh(onScreen());
    select(B);
    // B's status answer is held now, though it did not make B fresh.
    stale.noteStatusAnswerFor(onScreen());
    select(A);
    assert.equal(stale.isPositionDataStale(), true);
  });

  it("stays fresh as the fresh position's own status answers come in", () => {
    select(A);
    stale.markPositionDataFresh(onScreen());
    stale.noteStatusAnswerFor(onScreen());
    assert.equal(stale.isPositionDataStale(), false);
  });

  it("is stale once the dashboard forgets what it was shown", () => {
    select(A);
    stale.markPositionDataFresh(onScreen());
    stale.forgetFreshAnswer();
    assert.equal(stale.isPositionDataStale(), true);
  });

  it("is never stale for an entry the server is never asked about", () => {
    select(C);
    assert.equal(stale.isPositionDataStale(), false);
  });
});

describe("the watch", () => {
  let watch;

  beforeEach(() => {
    const page = indexHtmlDocument();
    document.body.replaceChildren(
      ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
    );
    // A fresh position on screen, so each test starts with nothing shown.
    select(A);
    stale.markPositionDataFresh(onScreen());
    mock.timers.enable({ apis: ["setInterval"] });
  });

  afterEach(() => {
    clearInterval(watch);
    mock.timers.reset();
  });

  const marked = () => document.body.hasAttribute(stale.STALE_ATTRIBUTE);
  const inert = (id) => document.getElementById(id).closest("[inert]") !== null;

  it("shows the flag once per interval, not before", () => {
    watch = stale.startStaleDataWatch(120);
    assert.equal(marked(), false);
    select(B);
    mock.timers.tick(119);
    assert.equal(marked(), false, "the page waits for the next check");
    mock.timers.tick(1);
    assert.equal(marked(), true);
    stale.markPositionDataFresh(onScreen());
    mock.timers.tick(120);
    assert.equal(marked(), false);
  });

  it("disables every control but the disclaimer and the wallet unlock", () => {
    watch = stale.startStaleDataWatch(50);
    select(B);
    mock.timers.tick(50);
    for (const id of [
      "posBrowserBtn",
      "settingsBtn",
      "manageToggleBtn",
      "poolDetailsBtn",
      "wsRevealBtn",
      "rebalanceWithRangeBtn",
      "compoundNowBtn",
      "autoCompoundToggle",
      "inMinInterval",
      "saveMinIntervalBtn",
      "pnlNextBtn",
    ])
      assert.equal(inert(id), true, `${id} is disabled`);
    for (const id of [
      "disclaimerOverlay",
      "walletUnlockModal",
      "unlockPassword",
      "unlockWalletBtn",
    ])
      assert.equal(inert(id), false, `${id} stays usable`);
  });

  it("disables a dialog added while the figures are stale", () => {
    watch = stale.startStaleDataWatch(50);
    select(B);
    mock.timers.tick(50);
    const dialog = document.createElement("div");
    dialog.append(document.createElement("button"));
    document.body.append(dialog);
    mock.timers.tick(50);
    assert.ok(dialog.hasAttribute("inert"));
  });

  it("frees everything once the figures are fresh", () => {
    watch = stale.startStaleDataWatch(50);
    select(B);
    mock.timers.tick(50);
    assert.ok(document.querySelectorAll("[inert]").length > 0);
    stale.markPositionDataFresh(onScreen());
    mock.timers.tick(50);
    assert.equal(document.querySelectorAll("[inert]").length, 0);
  });

  it("is started with the interval the server sends", () => {
    /*-
     *  dashboard-init.js runs the whole page on import, so its one line
     *  starting the watch is read rather than run.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "public", "dashboard-init.js"),
      "utf8",
    );
    assert.match(
      src,
      /startStaleDataWatch\(uiSetting\("staleDataCheckIntervalMs"\)\)/,
    );
  });
});

describe("the page's markup", () => {
  const page = indexHtmlDocument();
  const figure = (id) =>
    page.getElementById(id).closest("[data-position-figure]");

  it("marks the figures the stylesheet dashes", () => {
    for (const id of [
      "kpiPnl",
      "kpiValue",
      "pnlFees",
      "curIL",
      "curDepositDisplay",
      "missionStatusBadge",
      "kpiToday",
      "kpiCountdown",
      "kpiNet",
      "ltCurrentValue",
      "netIL",
      "lifetimeDepositDisplay",
      "rangePctLower",
      "sTC",
      "sWpls",
      "sResidual0",
      "activeIlGuard",
      "throttleBadge",
      "dblWindowLabel",
      "manageBadge",
    ])
      assert.notEqual(figure(id), null, `${id} shows a dash while stale`);
  });

  it("gives each history table a row of dashes to show in place of its rows", () => {
    for (const id of ["dailyPnlBody", "rebEventsBody"]) {
      const rows = page.getElementById(id);
      assert.ok(rows.hasAttribute("data-position-rows"), id);
      const dashes = rows.parentElement.querySelector(
        "[data-position-dash-row]",
      );
      const cells = [...dashes.querySelectorAll("td")];
      const columns = rows.parentElement.querySelectorAll("thead th").length;
      assert.equal(cells.length, columns, `${id}: one dash per column`);
      assert.ok(cells.every((td) => td.textContent === "—"));
    }
  });

  it("has the stylesheet dash the figures and swap the rows while stale", () => {
    /*-
     *  jsdom lays nothing out, so the rules are read rather than seen:
     *  each must be keyed on the attribute the watch sets.
     */
    const css = fs
      .readFileSync(
        path.join(__dirname, "..", "public", "9mm-pos-mgr.css"),
        "utf8",
      )
      .replace(/\s+/g, " ");
    const stale = "body[data-position-data-stale]";
    for (const rule of [
      `${stale} [data-position-figure] { position: relative; visibility: hidden; }`,
      `${stale} [data-position-figure]::before {`,
      `${stale} [data-position-graphic] { opacity: 0; }`,
      `${stale} [data-position-rows], body:not([data-position-data-stale]) [data-position-dash-row] { display: none; }`,
    ])
      assert.ok(css.includes(rule), rule);
    assert.match(
      css,
      /\[data-position-figure\]::before \{[^}]*content: "\\2014";[^}]*visibility: visible;/,
    );
  });

  it("gives each box holding a position's setting a dash placeholder", () => {
    for (const id of [
      "inMinInterval",
      "inMaxReb",
      "inOorTimeout",
      "inIlGuard",
      "inOorThreshold",
      "autoCompoundThreshold",
      "inOffsetToken0",
      "inOffsetToken1",
      "inRangeWidth",
      "inSlipToken0",
      "inSlipToken1",
    ])
      assert.equal(page.getElementById(id).placeholder, "—", id);
  });
});
