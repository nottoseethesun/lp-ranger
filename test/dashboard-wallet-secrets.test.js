"use strict";

/**
 * @file test/dashboard-wallet-secrets.test.js
 * @description Once the server holds a wallet's secrets, the browser tab
 *   keeps no copy of them. Only the server signs, so the tab has no use
 *   for the private key, the seed phrase or the password after sending
 *   them; the user, 2026-10-19: "it should be removed from the web
 *   browser memory once the server has successfully received the signing
 *   info".
 *
 *   Driven through the page's own handlers on its markup from
 *   public/index.html, with the server's answers scripted: the import's
 *   confirm, the unlock dialog and Reveal Key. A refused request keeps
 *   what was typed, so it can be sent again.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { learnActiveChain } = require("./helpers/active-chain");
const { learnUiSettings } = require("./helpers/ui-settings");
const { indexHtmlDocument } = require("./helpers/index-html");

const ADDRESS = "0x1111111111111111111111111111111111111111";
const KEY = "0x" + "ab".repeat(32);
const PASSWORD = "a password typed in";

const answer = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  clone() {
    return this;
  },
});

// What the scripted server says to each wallet request.
let accepts = true;

let walletMod, importMod;

before(async () => {
  /*-
   *  TEST-ONLY global swaps, for this file's own process. The dashboard
   *  asks the server through the browser's fetch, and finds the active
   *  password field by whether it is laid out (`offsetParent`), which
   *  jsdom never reports; every element counts as laid out here.
   */
  globalThis.fetch = async (url) => {
    if (url === "/api/wallet" || url === "/api/wallet/unlock")
      return answer(accepts ? { ok: true } : { ok: false, error: "No" });
    if (url === "/api/wallet/reveal")
      return answer(
        accepts
          ? { ok: true, address: ADDRESS, privateKey: KEY, mnemonic: null }
          : { ok: false, error: "Wrong password" },
      );
    return answer({ ok: false });
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
    get() {
      return this.parentNode;
    },
  });
  globalThis.alert = () => {};
  await learnActiveChain("pulsechain", "PulseChain");
  await learnUiSettings();
  const page = indexHtmlDocument();
  document.body.replaceChildren(
    ...[...page.body.childNodes].map((n) => document.importNode(n, true)),
  );
  walletMod = await import("../public/dashboard-wallet.js");
  importMod = await import("../public/dashboard-wallet-import.js");
});

const el = (id) => document.getElementById(id);

/** The import dialog as the operator leaves it before Confirm. */
function typeImport() {
  walletMod.wallet._pending = {
    address: ADDRESS,
    privateKey: KEY,
    mnemonic: null,
    source: "key",
  };
  el("keyInput").value = KEY;
  el("keyPassword").value = PASSWORD;
  el("keyPasswordConfirm").value = PASSWORD;
}

beforeEach(() => {
  accepts = true;
});

describe("once the server holds the wallet", () => {
  it("the tab forgets the key and the password it was imported with", async () => {
    typeImport();
    await walletMod.confirmWallet();
    assert.equal(el("keyInput").value, "");
    assert.equal(el("keyPassword").value, "");
    assert.equal(el("keyPasswordConfirm").value, "");
    assert.equal(walletMod.wallet._pending, undefined);
    assert.ok(!JSON.stringify(walletMod.wallet).includes(KEY.slice(2)));
    assert.equal(walletMod.wallet.address, ADDRESS);
  });

  it("forgets a generated wallet's key and seed phrase shown to be written down", async () => {
    typeImport();
    el("genKey").textContent = KEY;
    el("genMnemonic").textContent = "twelve words of a seed phrase";
    await walletMod.confirmWallet();
    assert.equal(el("genKey").textContent, "—");
    assert.equal(el("genMnemonic").textContent, "—");
  });

  it("keeps what was typed when the server refuses it, so it can be sent again", async () => {
    accepts = false;
    typeImport();
    await walletMod.confirmWallet();
    assert.equal(el("keyInput").value, KEY);
    assert.equal(el("keyPassword").value, PASSWORD);
  });
});

describe("once the server has accepted the password", () => {
  it("the unlock dialog forgets it", async () => {
    el("unlockPassword").value = PASSWORD;
    await walletMod.submitUnlock();
    assert.equal(el("unlockPassword").value, "");
  });

  it("Reveal Key forgets it", async () => {
    el("revealPassword").value = PASSWORD;
    await importMod.revealWallet();
    assert.equal(el("revealPassword").value, "");
    importMod.closeRevealModal();
  });

  it("each keeps a password the server refuses, to be corrected", async () => {
    accepts = false;
    el("unlockPassword").value = PASSWORD;
    await walletMod.submitUnlock();
    assert.equal(el("unlockPassword").value, PASSWORD);
    el("revealPassword").value = PASSWORD;
    await importMod.revealWallet();
    assert.equal(el("revealPassword").value, PASSWORD);
  });
});
