"use strict";

/**
 * @file test/dashboard-answer-after-switch.test.js
 * @description An answer that arrives after the operator has moved to
 *   another position stays off the screen.
 *
 *   A Stop Managing waits for the position's check under way, a re-open
 *   for its first rebalance, a save for its round trip, and the operator
 *   can move to another position meanwhile. The answers then landed on
 *   the position on screen: Stop Managing's refetch blanked its figures,
 *   so did a price or deposit save's, a price override's browser copy
 *   went under its pool, and a re-open's dialog and Activity entry named
 *   it. The user, 2026-10-18: "responses from the server need to be
 *   tagged with the fully-qualified position identifier ... Then the
 *   client will discard any that don't match the currently-loaded
 *   position." The server now names the position in each such answer,
 *   and these cases hand each answer handler one naming position A while
 *   position B is on screen.
 *
 *   What an answer records about its own position is kept: a re-open's
 *   Activity entry, named for the position re-opened, and a price
 *   override's browser copy, under that position's pool.
 *
 *   The handlers are driven directly, with answers of the cases' own:
 *   the requests go through the global `fetch`, which a test must not
 *   replace.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { indexHtmlDocument } = require("./helpers/index-html");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const keyOf = (tokenId) => `pulsechain-${WALLET}-${PM}-${tokenId}`;
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
};
const B = {
  ...A,
  tokenId: "202",
  token0: "0x" + "b1".repeat(20),
  token1: "0x" + "b2".repeat(20),
  token0Symbol: "BBA",
  token1Symbol: "BBB",
  fee: 10000,
};

let answerPos, configSave, manage, confirm, priceOverride, deposit;
let posStore;

before(async () => {
  await learnActiveChain("pulsechain", "PulseChain");
  answerPos = await import("../public/dashboard-answer-position.js");
  configSave = await import("../public/dashboard-config-save.js");
  manage = await import("../public/dashboard-events-manage.js");
  confirm = await import("../public/dashboard-rebalance-confirm.js");
  priceOverride = await import("../public/dashboard-price-override.js");
  deposit = await import("../public/dashboard-data-deposit.js");
  ({ posStore } = await import("../public/dashboard-positions-store.js"));
  posStore.add(A);
  posStore.add(B);
});

/** The page's own markup, with B on screen. */
beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  posStore.select(posStore.entries.findIndex((p) => p.tokenId === "202"));
});

/*-
 *  The last Activity entry's text. Its position label is on its own line
 *  under an error's detail, and is the whole line of a success.
 */
const lastActivityText = () =>
  [...document.querySelectorAll("#actList .ai")].pop()?.textContent ?? "";

describe("whether an answer is for the position on screen", () => {
  it("goes by the position the server names", () => {
    const { isAnswerForPositionOnScreen: on } = answerPos;
    assert.equal(on({ positionKey: keyOf(202) }), true);
    assert.equal(on({ positionKey: keyOf(101) }), false);
    assert.equal(on({ positionKey: keyOf(202).toLowerCase() }), true);
  });

  it("knows the position by its new NFT, when a rebalance minted one", () => {
    const ans = { positionKey: keyOf(101), livePositionKey: keyOf(202) };
    assert.equal(answerPos.isAnswerForPositionOnScreen(ans), true);
  });

  it("takes an answer that names none to be about the one asked about", () => {
    const { isAnswerForPositionOnScreen: on } = answerPos;
    assert.equal(on({}, keyOf(202)), true);
    assert.equal(on(null, keyOf(101)), false);
  });
});

describe("a save's answer", () => {
  const inputs = { maxRebalancesPerDay: "inMaxReb" };
  const settle = (ok, positionKey, body, onSaved) =>
    configSave._settleSaveAnswer({
      ok,
      status: ok ? 200 : 400,
      body,
      values: { maxRebalancesPerDay: 9 },
      positionKey,
      inputs,
      onSaved,
    });
  /** What a refusal would put the field back to now. */
  const restoresTo = () =>
    configSave._applySaveRejection("inMaxReb", "maxRebalancesPerDay", {
      invalidValueForKey: "maxRebalancesPerDay",
    });

  it("for another position leaves the fields on screen alone", () => {
    configSave.rememberGoodInput("inMaxReb", 5);
    const seen = [];
    const out = settle(
      true,
      keyOf(101),
      { ok: true, positionKey: keyOf(101) },
      (onScreen) => seen.push(onScreen),
    );
    assert.deepEqual(out, { saved: true, onScreen: false, message: null });
    assert.deepEqual(seen, [false], "told it is not for the screen");
    assert.match(restoresTo(), /set back to 5\./, "B's last value stands");
  });

  it("for another position shows no refusal and puts back no field", () => {
    document.getElementById("inMaxReb").value = "7";
    const out = settle(false, keyOf(101), {
      ok: false,
      invalidValueForKey: "maxRebalancesPerDay",
      positionKey: keyOf(101),
    });
    assert.equal(out.message, null);
    assert.equal(document.getElementById("inMaxReb").value, "7");
  });

  it("for the position on screen does all it did before", () => {
    const seen = [];
    settle(
      true,
      keyOf(202),
      { ok: true, positionKey: keyOf(202) },
      (onScreen) => seen.push(onScreen),
    );
    assert.deepEqual(seen, [true]);
    assert.match(restoresTo(), /set back to 9\./);
  });
});

describe("a Stop Managing's answer", () => {
  it("for another position neither refetches nor touches the switch", () => {
    const toggle = document.getElementById("autoCompoundToggle");
    toggle.checked = true;
    const refetched = [];
    const forScreen = manage._afterUnmanaged(
      { ok: true, positionKey: keyOf(101) },
      keyOf(101),
      A,
      (p) => refetched.push(p.tokenId),
    );
    assert.equal(forScreen, false);
    assert.deepEqual(refetched, [], "B's figures are not blanked");
    assert.equal(toggle.checked, true);
  });

  it("for the position on screen refetches it", () => {
    const refetched = [];
    manage._afterUnmanaged(
      { ok: true, positionKey: keyOf(202) },
      keyOf(202),
      B,
      (p) => refetched.push(p.tokenId),
    );
    assert.deepEqual(refetched, ["202"]);
    assert.equal(document.getElementById("autoCompoundToggle").checked, false);
  });
});

describe("a re-open's answer", () => {
  const settle = (data) =>
    confirm._settleRebalanceAnswer({
      data,
      requestKey: keyOf(101),
      active: A,
      inFlight: null,
      url: "/api/position/manage",
      triggerActLabel: "Re-open Position",
    });
  // A class that begins with a digit is no CSS selector, so by its name.
  const cautionModals = () =>
    document.getElementsByClassName("9mm-pos-mgr-modal-caution").length;

  it("for another position opens no dialog, and names its own position in the Activity Log", () => {
    const before = cautionModals();
    settle({ ok: false, error: "nope", positionKey: keyOf(101) });
    assert.equal(cautionModals(), before, "no dialog over B");
    assert.match(lastActivityText(), /nope/);
    assert.match(lastActivityText(), /AAA\/AAB/);
    assert.match(lastActivityText(), /NFT #101/);
    assert.doesNotMatch(lastActivityText(), /BBA\/BBB/);
  });

  it("names its own position in the Activity Log when it succeeds", () => {
    settle({ ok: true, positionKey: keyOf(101) });
    assert.match(lastActivityText(), /Re-open Position/);
    assert.match(lastActivityText(), /NFT #101/);
    assert.doesNotMatch(lastActivityText(), /NFT #202/);
  });

  it("opens its dialog when the screen followed it to its new NFT", () => {
    const before = cautionModals();
    settle({
      ok: false,
      error: "nope",
      positionKey: keyOf(101),
      livePositionKey: keyOf(202),
    });
    assert.equal(cautionModals(), before + 1);
  });
});

describe("a price override's answer", () => {
  it("keeps the browser copy under the pool saved for, and refetches nothing on screen", () => {
    const refetched = [];
    priceOverride.injectPriceOverrideDeps({
      refetchUnmanaged: (p) => refetched.push(p.tokenId),
    });
    localStorage.clear();
    priceOverride._afterPriceSaved({
      p0: 1.5,
      p1: 2.5,
      force: true,
      ovKey: "9mm_price_override_test_A",
      active: A,
      onScreen: false,
    });
    assert.equal(
      localStorage.getItem("9mm_price_override_test_A"),
      JSON.stringify({ price0: 1.5, price1: 2.5 }),
    );
    assert.equal(localStorage.getItem("9mm_price_override_test_A_force"), "1");
    assert.deepEqual(
      priceOverride.loadPriceOverrides(),
      { price0: 0, price1: 0 },
      "B's pool has none",
    );
    assert.deepEqual(refetched, []);
  });

  it("refetches the position on screen when the answer is for it", () => {
    const refetched = [];
    priceOverride.injectPriceOverrideDeps({
      refetchUnmanaged: (p) => refetched.push(p.tokenId),
    });
    priceOverride._afterPriceSaved({
      p0: 1,
      p1: 1,
      force: false,
      ovKey: "9mm_price_override_test_B",
      active: B,
      onScreen: true,
    });
    assert.deepEqual(refetched, ["202"]);
  });
});

describe("a deposit save's answer", () => {
  it("refetches only the position on screen", () => {
    const refetched = [];
    deposit.injectDataDeps({
      refetchUnmanaged: (p) => refetched.push(p.tokenId),
    });
    assert.equal(deposit._afterDepositSaved(A, false), false);
    assert.deepEqual(refetched, [], "B's figures are not blanked");
    assert.equal(deposit._afterDepositSaved(B, true), true);
    assert.deepEqual(refetched, ["202"]);
  });
});
