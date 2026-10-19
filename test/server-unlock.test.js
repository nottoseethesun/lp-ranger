"use strict";

/**
 * @file test/server-unlock.test.js
 * @description Entering the wallet password is idempotent
 *   (src/server-unlock.js).
 *
 *   The first unlock decrypts the key and the api keys and starts the
 *   positions saved as managed. Entering the password again, from another
 *   dashboard tab still showing the Unlock Wallet dialog, say, confirms
 *   it and decrypts the same keys again, and starts nothing: a second
 *   start-up over running positions once left each half-connected to the
 *   dashboard until a restart. A wrong password changes nothing.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createUnlockHandler } = require("../src/server-unlock");

const KEY = "0x" + "11".repeat(32);

/** An unlock route over a wallet whose password is `right`. */
function route({ key = null } = {}) {
  const calls = { startUps: 0, decrypted: [] };
  const privateKeyRef = { current: key };
  let body = {};
  const handle = createUnlockHandler({
    walletManager: {
      revealWallet: async (password) => {
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
});
