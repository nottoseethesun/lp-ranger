"use strict";

/**
 * @file test/server-unlock.test.js
 * @description Entering the wallet password is idempotent
 *   (src/server/server-unlock.js).
 *
 *   The first unlock decrypts the key and the api keys and starts the
 *   positions saved as managed. Entering the password again, from another
 *   dashboard tab still showing the Unlock Wallet dialog, say, confirms
 *   it and decrypts the same keys again, and starts nothing: a second
 *   start-up over running positions once left each half-connected to the
 *   dashboard until a restart. A wrong password changes nothing. While a
 *   wallet import is under way, an unlock is refused and changes nothing,
 *   asked again once its decrypt is done.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createUnlockHandler: unlockRouteOver,
} = require("../src/server/server-unlock");
const { botOperations } = require("../src/bot/bot-interface");
const appPhase = require("../src/bot/app-phase");

/**
 * The unlock route over the bot's own operations (src/bot/bot-interface.js),
 * built over the test's `privateKeyRef`, so the key it holds and whether
 * it holds one are the interface's real `setPrivateKey` and
 * `hasPrivateKey`, the guard against a second start-up. Only the
 * start-up itself is the test's `startManagedPositions`, which counts.
 */
const createUnlockHandler = (deps) => {
  const ops = botOperations({
    diskConfig: { global: {}, positions: {} },
    walletManager: deps.walletManager,
    positionMgr: {},
    privateKeyRef: deps.privateKeyRef,
  });
  return unlockRouteOver({
    ...deps,
    bot: { ...ops, startManagedPositions: () => deps.startManagedPositions() },
  });
};

const KEY = "0x" + "11".repeat(32);

/**
 * An unlock route over a wallet whose password is `right`, whose decrypt
 * runs `duringDecrypt` before it answers; with `saved` false, over no
 * wallet at all.
 */
function route({ key = null, duringDecrypt = () => {}, saved = true } = {}) {
  const calls = { startUps: 0, decrypted: [], revealed: 0 };
  const privateKeyRef = { current: key };
  let body = {};
  const handle = createUnlockHandler({
    walletManager: {
      hasWallet: () => saved,
      revealWallet: async (password) => {
        calls.revealed++;
        duringDecrypt();
        if (password !== "right") throw new Error("bad password");
        return { privateKey: KEY };
      },
    },
    privateKeyRef,
    decryptApiKeys: async (password) => {
      calls.decrypted.push(password);
    },
    startManagedPositions: async () => {
      calls.startUps++;
    },
    jsonResponse: (res, status, answer) =>
      Object.assign(res, { status, answer }),
    readJsonBody: async () => body,
  });
  const unlock = async (password) => {
    body = { password };
    const res = {};
    await handle({ headers: {} }, res);
    return res;
  };
  return { unlock, calls, privateKeyRef };
}

describe("entering the wallet password", () => {
  it("unlocks the wallet and starts the managed positions the first time", async () => {
    const r = route();
    const res = await r.unlock("right");
    assert.equal(res.status, 200);
    assert.equal(r.privateKeyRef.current, KEY);
    assert.deepEqual(r.calls.decrypted, ["right"]);
    assert.equal(r.calls.startUps, 1);
  });

  it("changes nothing more when entered again, and starts nothing", async () => {
    const r = route();
    await r.unlock("right");
    const again = await r.unlock("right");
    assert.equal(again.status, 200);
    assert.equal(r.privateKeyRef.current, KEY);
    assert.equal(r.calls.startUps, 1, "one start-up, at the first unlock");
  });

  it("still decrypts the api keys when the key came from .env", async () => {
    /*-
     *  A key in `.env` leaves the wallet unlocked without its password,
     *  so the api keys wait for the dashboard's unlock. The positions
     *  started at boot, so nothing starts.
     */
    const r = route({ key: KEY });
    const res = await r.unlock("right");
    assert.equal(res.status, 200);
    assert.deepEqual(r.calls.decrypted, ["right"]);
    assert.equal(r.calls.startUps, 0);
  });

  it("answers a wrong password 401 and changes nothing", async () => {
    const r = route();
    const res = await r.unlock("wrong");
    assert.equal(res.status, 401);
    assert.equal(r.privateKeyRef.current, null);
    assert.deepEqual(r.calls.decrypted, []);
    assert.equal(r.calls.startUps, 0);
  });

  it("refuses a request with no password", async () => {
    const r = route();
    const res = await r.unlock(undefined);
    assert.equal(res.status, 400);
    assert.equal(r.calls.startUps, 0);
  });

  it("says there is no wallet to unlock when none is saved, decrypting nothing", async () => {
    /*-
     *  The decrypt refuses for want of a wallet too, and that refusal
     *  must not read as a password typed wrong.
     */
    const r = route({ saved: false });
    const res = await r.unlock("right");
    assert.equal(res.status, 404);
    assert.match(res.answer.error, /no wallet to unlock/);
    assert.equal(r.calls.revealed, 0);
    assert.equal(r.privateKeyRef.current, null);
    assert.equal(r.calls.startUps, 0);
  });
});

describe("entering the wallet password while a wallet import is under way", () => {
  /*-
   *  The import is replacing the wallet the password opens. Taken, the
   *  old wallet's key would be the bot's, and the unlock's start-up would
   *  start the old wallet's positions once the new wallet was in.
   */
  afterEach(() => appPhase._resetAppPhaseForTests());

  it("is refused before the decrypt, changing nothing", async () => {
    const r = route();
    appPhase.beginWalletImport();
    const res = await r.unlock("right");
    assert.equal(res.status, 409);
    assert.match(res.answer.error, /importing a wallet/);
    assert.equal(r.calls.revealed, 0, "no decrypt");
    assert.equal(r.privateKeyRef.current, null);
    assert.deepEqual(r.calls.decrypted, []);
    assert.equal(r.calls.startUps, 0);
  });

  it("is refused when the import begins during its decrypt", async () => {
    const r = route({ duringDecrypt: () => appPhase.beginWalletImport() });
    const res = await r.unlock("right");
    assert.equal(res.status, 409);
    assert.match(res.answer.error, /importing a wallet/);
    assert.equal(r.calls.revealed, 1);
    assert.equal(r.privateKeyRef.current, null, "the old key not taken");
    assert.deepEqual(r.calls.decrypted, []);
    assert.equal(r.calls.startUps, 0);
  });
});
