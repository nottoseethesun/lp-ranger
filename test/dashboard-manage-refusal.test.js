"use strict";

/**
 * @file test/dashboard-manage-refusal.test.js
 * @description What the page says when the server refuses a Manage or a
 *   re-open under the one-active-position-per-pool rule
 *   (src/client/web/dashboard-manage-refusal.js): which position holds the pool,
 *   and what to do, rather than the code the server answers with and a
 *   "click again" that would only be refused again.
 *
 *   The page's own check refuses the same cases first, so these words
 *   show when its view lags the server's. The Manage alert and the
 *   re-open dialog are driven with answers of the cases' own: the
 *   requests go through the global `fetch`, which a test must not
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

// The three refusals, as the server answers them about position A.
const MANAGED = {
  ok: false,
  error: "pool-already-managed",
  conflictTokenId: "111",
  conflictKey: keyOf(111),
  positionKey: keyOf(101),
};
const OPEN = {
  ok: false,
  error: "pool-has-open-position",
  openTokenId: "111",
  positionKey: keyOf(101),
};
const UNREAD = {
  ok: false,
  error: "pool-info-unavailable",
  message: "LP Ranger could not read the pool of NFT #101 from the chain.",
  tokenId: "101",
  positionKey: keyOf(101),
};

let refusal, manage, confirm, posStore;

before(async () => {
  await learnActiveChain("pulsechain", "PulseChain");
  refusal = await import("../src/client/web/dashboard-manage-refusal.js");
  manage = await import("../src/client/web/dashboard-events-manage.js");
  confirm = await import("../src/client/web/dashboard-rebalance-confirm.js");
  ({ posStore } =
    await import("../src/client/web/dashboard-positions-store.js"));
  posStore.add(A);
});

/** The page's own markup, with A on screen. */
beforeEach(() => {
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  posStore.select(posStore.entries.findIndex((p) => p.tokenId === "101"));
});

describe("the words for a refusal under the pool rule", () => {
  it("name the position managed in the pool, and say to stop managing it first", () => {
    const r = refusal.poolRuleRefusal(MANAGED);
    assert.equal(r.title, "Pool Already Managed");
    assert.match(r.text, /already manages NFT #111 in the pool of NFT #101/);
    assert.match(r.text, /one active position per pool/);
    assert.match(r.text, /To manage NFT #101 instead, stop managing NFT #111/);
  });

  it("name the open position a re-open would sit beside, and say what to do", () => {
    const r = refusal.poolRuleRefusal(OPEN);
    assert.equal(r.title, "Pool Has an Open Position");
    assert.match(r.text, /Re-opening NFT #101, which is closed/);
    assert.match(r.text, /already holds open NFT #111/);
    assert.match(r.text, /Manage NFT #111 instead, or close it first/);
  });

  it("say a pool that could not be read started nothing, and where to look", () => {
    const r = refusal.poolRuleRefusal(UNREAD);
    assert.equal(r.title, "Pool Info Unavailable");
    assert.match(r.text, /could not read the pool of NFT #101/);
    assert.match(r.text, /nothing was started/);
    assert.match(r.text, /log in your terminal/);
  });

  it("are none for any other answer", () => {
    assert.equal(refusal.poolRuleRefusal({ ok: false, error: "nope" }), null);
    assert.equal(refusal.poolRuleRefusal("HTTP 500"), null);
    assert.equal(refusal.poolRuleRefusal(null), null);
  });
});

describe("a refused Manage", () => {
  /** What the Manage alert says for `answer`. */
  function told(answer) {
    const said = [];
    manage._handleManageFailure("manage", answer, A, (text) => said.push(text));
    return said;
  }

  it("says which position holds the pool, with no retry that would fail again", () => {
    const [text] = told(MANAGED);
    assert.match(text, /^Couldn't start managing NFT #101 \(AAA\/AAB/);
    assert.match(text, /stop managing NFT #111 first/);
    assert.doesNotMatch(text, /again to retry/);
    assert.doesNotMatch(text, /pool-already-managed/, "no bare code");
  });

  it("names the open position a re-open would sit beside", () => {
    const [text] = told(OPEN);
    assert.match(text, /already holds open NFT #111/);
    assert.doesNotMatch(text, /again to retry/);
  });

  it("still offers a retry for a failure a retry can mend", () => {
    const [text] = told({ ok: false, error: "Failed to start position: x" });
    assert.match(text, /Failed to start position: x/);
    assert.match(text, /Click "Manage" again to retry/);
  });
});

describe("a refused re-open", () => {
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
  const lastDialog = () =>
    [...document.getElementsByClassName("9mm-pos-mgr-modal-caution")].pop();

  it("is titled for its cause and names the open position", () => {
    settle(OPEN);
    const dialog = lastDialog();
    assert.match(dialog.textContent, /Pool Has an Open Position/);
    assert.match(dialog.textContent, /already holds open NFT #111/);
    assert.doesNotMatch(dialog.textContent, /pool-has-open-position/);
  });

  it("says a pool that could not be read started nothing", () => {
    settle(UNREAD);
    assert.match(lastDialog().textContent, /nothing was started/);
  });

  it("shows the server's words as text, never as markup", () => {
    settle({ ...OPEN, openTokenId: '<img src="x">' });
    const words = lastDialog().querySelector("[data-rebalance-error]");
    assert.equal(words.children.length, 0, "nothing built from the answer");
    assert.match(words.textContent, /<img src="x">/);
  });
});
