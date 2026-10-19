"use strict";

/**
 * @file test/dashboard-refused-value.test.js
 * @description A value the server refuses is replaced in its field by
 *   the value the server holds for the position on screen, asked of the
 *   server, never by one the browser kept.
 *
 *   The case the user approved the fix for, 2026-10-19: save Slippage at
 *   2% on one position, switch to another, type a value the server
 *   refuses there. The browser used to put back the last value it had
 *   seen accepted, which was the first position's 2%, for a second Save
 *   to store on the second position. The user: "The bot should request
 *   the correct value from the server (even if it means fetching a large
 *   json) and put that in, in order to recover the state of the form
 *   field correctly."
 *
 *   Driven through the page's own Save, switch and status poll on its
 *   markup from public/index.html, with the server's answers scripted.
 */

require("global-jsdom/register");

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");
const SHIPPED = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");
const BOUNDS = require("../app-config/app-defaults-for-user-configurable/setting-bounds.json");

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const keyOf = (tokenId) => `pulsechain-${WALLET}-${PM}-${tokenId}`;
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
const A = entry("101", "0x" + "a1".repeat(20));
const B = entry("102", "0x" + "a2".repeat(20));
const C = entry("103", "0x" + "a3".repeat(20));

// What the server holds: A's and B's own slippage; C has none saved.
const saved = {
  [keyOf("101")]: {},
  [keyOf("102")]: { slippagePctToken0: 1.5 },
  [keyOf("103")]: {},
};
// Below the setting's range, so the server refuses it.
const REFUSED = BOUNDS.slippagePctToken0.min / 2;

const answer = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  clone() {
    return this;
  },
});

/** The scripted server's answer to a save. */
function answerSave(init) {
  const { positionKey, ...values } = JSON.parse(init.body);
  const v = values.slippagePctToken0;
  if (v < BOUNDS.slippagePctToken0.min)
    return answer(
      {
        ok: false,
        error: "Slippage is outside what it accepts.",
        invalidValueForKey: "slippagePctToken0",
        positionKey,
      },
      400,
    );
  Object.assign(saved[positionKey], values);
  return answer({ ok: true, positionKey });
}

const alerts = [];
let positions, slippage;

before(async () => {
  /*-
   *  TEST-ONLY global swaps, for this file's own process: the dashboard
   *  asks the server through the browser's fetch, and tells the operator
   *  of a refusal through the browser's alert.
   */
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status")
      return answer({
        global: { walletAddress: WALLET },
        positions: saved,
      });
    if (url === "/api/config") return answerSave(init);
    if (url === "/api/wallet/status")
      return answer({ loaded: true, locked: false, address: WALLET });
    if (url.startsWith("/api/is-position-managed"))
      return answer({ managed: false });
    return answer({ ok: false });
  };
  globalThis.alert = (text) => alerts.push(text);
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  const store = await import("../public/dashboard-positions-store.js");
  positions = await import("../public/dashboard-positions.js");
  slippage = await import("../public/dashboard-per-token-slippage.js");
  // Loaded as the page loads it: it announces how the panel refills.
  await import("../public/dashboard-data.js");
  const { setConfigInputDefault } =
    await import("../public/dashboard-config-inputs.js");
  setConfigInputDefault("slippagePct", SHIPPED.slippagePct);
  const { wallet } = await import("../public/dashboard-wallet.js");
  wallet.address = WALLET;
  store.posStore.add(A);
  store.posStore.add(B);
  store.posStore.add(C);
});

const box = () => document.getElementById("inSlipToken0");

/** Let the page's requests and their answers run their course. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Type a value into the slippage box and press its Save. */
async function typeAndSave(value) {
  box().value = String(value);
  box().dispatchEvent(new window.Event("input"));
  slippage.saveSlipToken0();
  await settle();
}

describe("a value the server refuses", () => {
  it("is replaced by the position on screen's own value, not the one before", async () => {
    positions.activateByTokenId(A.tokenId);
    await settle();
    await typeAndSave(2);
    assert.equal(saved[keyOf("101")].slippagePctToken0, 2, "A takes 2%");

    positions.activateByTokenId(B.tokenId);
    await settle();
    await typeAndSave(REFUSED);

    assert.equal(Number(box().value), 1.5, "B's own value, from the server");
    assert.match(alerts.at(-1), /was not accepted/);
    assert.match(
      alerts.at(-1),
      /value in force for this position stands: 1\.5/,
    );
    assert.equal(saved[keyOf("102")].slippagePctToken0, 1.5, "B unchanged");
  });

  it("is replaced by the shipped default when the position has none saved", async () => {
    positions.activateByTokenId(A.tokenId);
    await settle();
    await typeAndSave(2);
    positions.activateByTokenId(C.tokenId);
    await settle();
    await typeAndSave(REFUSED);
    assert.equal(Number(box().value), SHIPPED.slippagePct);
    assert.equal(saved[keyOf("103")].slippagePctToken0, undefined);
  });
});
