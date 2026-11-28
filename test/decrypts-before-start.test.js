"use strict";

/**
 * @file test/decrypts-before-start.test.js
 * @description Every decrypt finishes before anything starts (the user's
 *   ruling, 2026-11-25: "In finance, reliability is more important than
 *   responsiveness"). The launch's key step (`_tryResolveKey`) and a
 *   wallet import (`_handleWalletImport`, src/server/server-routes.js)
 *   decrypt the stored api keys with the wallet's password before the bot
 *   takes the key and starts the positions saved as managed. So the
 *   start-up finds Telegram set up, and the alert it sends for a closed
 *   position it drops (src/bot/auto-start.js) cannot be lost to a decrypt
 *   still under way. The launch asks again after that decrypt whether to
 *   stand aside, since an import can begin during it. A Clear
 *   (`DELETE /api/wallet`) sent during either decrypt is refused, so the
 *   wallet is still there when the key is taken. The unlock's order is
 *   tested in test/server-unlock.test.js.
 *
 *   Runs the real api-key store, whose 600,000-round key derivation takes
 *   a real while, over an api-keys.json of this file's own.
 */

const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

process.env.API_KEYS_FILE_PATH = path.join(
  makeTestTempFolder("decrypts-before-start"),
  "api-keys.json",
);

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/lib/config");
const appPhase = require("../src/bot/app-phase");
const tg = require("../src/lib/telegram-notifications/telegram");
const { saveEncryptedKey } = require("../src/lib/api-key-store");
const { createRouteHandlers } = require("./_bot-route-adapters");
const { createWalletInUse } = require("../src/server/wallet-in-use");
const { makeDeps, makeRes } = require("./helpers/route-handler-deps");
const { clearRequestOver } = require("./helpers/wallet-clear-request");

const PASSWORD = "pw";

/**
 * The server's routes over a wallet whose key is `0xold`, with no key
 * held yet. Its shared signer records whether Telegram was set up when
 * the start-up asked for it, then refuses, so no position starts.
 * `onReveal` runs as the wallet's decrypt answers, handed `clearNow`,
 * which sends a Clear through the server's own route, as a dashboard tab
 * does, and gives back its answer.
 * @returns {{h: object, seen: {telegramAtStart: boolean[]},
 *   privateKeyRef: {current: string|null}, wallet: {saved: boolean}}}
 */
function routes({ onReveal = () => {} } = {}) {
  const seen = { telegramAtStart: [] };
  const privateKeyRef = { current: null };
  const wallet = { saved: true };
  const walletInUse = createWalletInUse();
  const clearNow = clearRequestOver(walletInUse, () => {
    wallet.saved = false;
  });
  const base = makeDeps();
  const h = createRouteHandlers(
    makeDeps({
      privateKeyRef,
      walletInUse,
      envWalletPassword: () => PASSWORD,
      readJsonBody: async () => ({
        address: "0xABCD1234567890",
        privateKey: "0xpk",
        password: PASSWORD,
      }),
      walletManager: {
        ...base.walletManager,
        hasWallet: () => wallet.saved,
        revealWallet: async () => {
          onReveal(clearNow);
          return { privateKey: "0xold" };
        },
      },
      positionMgr: {
        ...base.positionMgr,
        getSharedSigner: async () => {
          seen.telegramAtStart.push(tg.isConfigured());
          throw new Error("no chain in this test");
        },
      },
    }),
  );
  return { h, seen, privateKeyRef, wallet };
}

describe("every decrypt finishes before anything starts", () => {
  let savedKey;
  before(async () => {
    await saveEncryptedKey("telegramBotToken", "tok", PASSWORD);
    await saveEncryptedKey("telegramChatId", "123", PASSWORD);
  });
  beforeEach(() => {
    // The launch takes the wallet's key only with no PRIVATE_KEY set.
    savedKey = config.PRIVATE_KEY;
    config.PRIVATE_KEY = null;
  });
  afterEach(() => {
    config.PRIVATE_KEY = savedKey;
    tg.setBotToken(null);
    tg.setChatId(null);
    appPhase._resetAppPhaseForTests();
  });

  it("at a launch, Telegram is set up before the start-up begins", async () => {
    const r = routes();
    await r.h._tryResolveKey();
    assert.equal(r.privateKeyRef.current, "0xold");
    assert.deepEqual(r.seen.telegramAtStart, [true]);
  });

  it("at a launch, the key step stands aside when an import begins during the api keys' decrypt", async () => {
    /*-
     *  The import begins on the event loop's next turn after the wallet's
     *  decrypt answers: past the check that follows that decrypt, and
     *  inside the api keys' decrypt, whose key derivation runs off the
     *  main thread for a good while.
     */
    const r = routes({
      onReveal: () => setImmediate(() => appPhase.beginWalletImport()),
    });
    await r.h._tryResolveKey();
    assert.equal(r.privateKeyRef.current, null, "the old key not taken");
    assert.deepEqual(r.seen.telegramAtStart, [], "no start-up");
  });

  it("at a launch, a Clear during the api keys' decrypt is refused, and the start-up finds Telegram set up", async () => {
    // Sent on the event loop's next turn: inside the api keys' decrypt.
    const answers = [];
    const r = routes({
      onReveal: (clearNow) =>
        setImmediate(async () => answers.push(await clearNow())),
    });
    await r.h._tryResolveKey();
    assert.equal(answers[0].status, 409);
    assert.equal(r.wallet.saved, true, "the wallet kept");
    assert.equal(r.privateKeyRef.current, "0xold");
    assert.deepEqual(r.seen.telegramAtStart, [true]);
  });

  it("at a wallet import, Telegram is set up before its start-up begins", async () => {
    const r = routes();
    await r.h._handleWalletImport({}, makeRes());
    assert.equal(r.privateKeyRef.current, "0xold");
    assert.deepEqual(r.seen.telegramAtStart, [true]);
  });

  it("at a wallet import, a Clear during its decrypts is refused, and its start-up finds Telegram set up", async () => {
    const answers = [];
    const r = routes({
      onReveal: (clearNow) =>
        setImmediate(async () => answers.push(await clearNow())),
    });
    await r.h._handleWalletImport({}, makeRes());
    assert.equal(answers[0].status, 409);
    assert.match(answers[0].body.error, /importing a wallet/);
    assert.equal(r.wallet.saved, true, "the wallet kept");
    assert.equal(r.privateKeyRef.current, "0xold");
    assert.deepEqual(r.seen.telegramAtStart, [true]);
  });
});
