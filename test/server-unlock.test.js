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
 *   start-up over running positions would leave each half-connected to
 *   the dashboard until a restart. A wrong password changes nothing. While a
 *   wallet import is under way, an unlock is refused and takes no key,
 *   asked again after each decrypt.
 *
 *   Both decrypts, the wallet's and the api keys', finish before the bot
 *   takes the key and starts the positions, so none starts before
 *   Telegram and Moralis are set up (the user's ruling, 2026-11-25:
 *   reliability before responsiveness). A failed api-key decrypt is
 *   logged and the unlock goes on.
 *
 *   A Clear (`DELETE /api/wallet`) is refused while the unlock runs, so
 *   the wallet is still there at every step, and goes through once it
 *   has answered, however it answered (the user's design, 2026-11-26).
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  createUnlockHandler: unlockRouteOver,
} = require("../src/server/server-unlock");
const { createWalletInUse } = require("../src/server/wallet-in-use");
const { botOperations } = require("../src/bot/bot-interface");
const appPhase = require("../src/bot/app-phase");
const { clearRequestOver } = require("./helpers/wallet-clear-request");

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
 * wallet at all. Its api-key decrypt takes a turn of the event loop, as a
 * real one does, then runs `duringApiKeys` (with the key the bot holds)
 * and fails when `apiKeysFail`. It records whether the bot held the key,
 * and how many start-ups had begun, when that decrypt began, and whether
 * it had finished when the start-up began. Each `during…` is handed
 * `clearNow`, which sends a Clear through the server's own route, as
 * another tab does, and gives back its answer; so does the route. With
 * `stale`, the wallet's decrypt rejects as one another wallet's import
 * overtook does (src/lib/wallet-manager.js). With `refusedLaunch`, the
 * launch was refused and the server waits to exit (`startRefusal`).
 */
function route({
  key = null,
  duringDecrypt = () => {},
  duringApiKeys = () => {},
  apiKeysFail = false,
  saved = true,
  stale = false,
  refusedLaunch = null,
} = {}) {
  const calls = {
    startUps: 0,
    decrypted: [],
    revealed: 0,
    atApiKeys: null,
    apiKeysDone: false,
    apiKeysDoneAtStart: null,
  };
  const privateKeyRef = { current: key };
  const wallet = { saved };
  const walletInUse = createWalletInUse();
  const clearNow = clearRequestOver(walletInUse, () => {
    wallet.saved = false;
  });
  let body = {};
  const handle = createUnlockHandler({
    walletManager: {
      hasWallet: () => wallet.saved,
      revealWallet: async (password) => {
        calls.revealed++;
        await duringDecrypt(clearNow);
        if (stale)
          throw Object.assign(new Error("The wallet changed"), {
            staleWallet: true,
          });
        if (password !== "right") throw new Error("bad password");
        return { privateKey: KEY };
      },
    },
    walletInUse,
    privateKeyRef,
    decryptApiKeys: async (password) => {
      calls.decrypted.push(password);
      calls.atApiKeys = {
        keyHeld: privateKeyRef.current !== null,
        startUps: calls.startUps,
      };
      await new Promise((resolve) => setImmediate(resolve));
      await duringApiKeys(privateKeyRef, clearNow);
      if (apiKeysFail) throw new Error("api keys unreadable");
      calls.apiKeysDone = true;
    },
    startManagedPositions: async () => {
      calls.startUps++;
      calls.apiKeysDoneAtStart = calls.apiKeysDone;
    },
    startRefusal: () => refusedLaunch,
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
  return { unlock, calls, privateKeyRef, wallet, clearNow };
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

  it("decrypts the api keys before it takes the key and starts the managed positions", async () => {
    const r = route();
    const res = await r.unlock("right");
    assert.equal(res.status, 200);
    assert.deepEqual(
      r.calls.atApiKeys,
      { keyHeld: false, startUps: 0 },
      "no key taken and no start-up while the api keys decrypt",
    );
    assert.equal(r.calls.apiKeysDoneAtStart, true, "decrypted before it");
    assert.equal(r.privateKeyRef.current, KEY);
  });

  it("takes the key and starts the positions when the api keys cannot be decrypted", async () => {
    const r = route({ apiKeysFail: true });
    const res = await r.unlock("right");
    assert.equal(res.status, 200);
    assert.equal(r.privateKeyRef.current, KEY);
    assert.equal(r.calls.startUps, 1);
  });

  it("starts nothing when the launch took the key during the decrypts", async () => {
    /*-
     *  The launch's key step can take the same key meanwhile, and starts
     *  the positions itself: whether the wallet was locked is read just
     *  before this unlock would take the key.
     */
    const r = route({
      duringApiKeys: (ref) => {
        ref.current = KEY;
      },
    });
    const res = await r.unlock("right");
    assert.equal(res.status, 200);
    assert.equal(r.calls.startUps, 0);
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
    // Refused before any decrypt: an error the dialog shows, not quiet.
    const r = route();
    appPhase.beginWalletImport();
    const res = await r.unlock("right");
    assert.equal(res.status, 409);
    assert.match(res.answer.error, /importing a wallet/);
    assert.equal(res.answer.walletReplaced, undefined, "not taken quietly");
    assert.equal(r.calls.revealed, 0, "no decrypt");
    assert.equal(r.privateKeyRef.current, null);
    assert.deepEqual(r.calls.decrypted, []);
    assert.equal(r.calls.startUps, 0);
  });

  it("is refused when the import begins during its decrypt, quietly", async () => {
    /*-
     *  The import overtook the unlock, as one whose own decrypt ends
     *  later does in the usual timing: nothing is wrong, so the dashboard
     *  shows no error (the user's ruling, 2026-11-27).
     */
    const r = route({ duringDecrypt: () => appPhase.beginWalletImport() });
    const res = await r.unlock("right");
    assert.equal(res.status, 409);
    assert.match(res.answer.error, /importing a wallet/);
    assert.equal(res.answer.walletReplaced, true, "taken quietly");
    assert.equal(r.calls.revealed, 1);
    assert.equal(r.privateKeyRef.current, null, "the old key not taken");
    assert.deepEqual(r.calls.decrypted, []);
    assert.equal(r.calls.startUps, 0);
  });

  it("is refused when the import begins during its api keys' decrypt, quietly", async () => {
    const r = route({ duringApiKeys: () => appPhase.beginWalletImport() });
    const res = await r.unlock("right");
    assert.equal(res.status, 409);
    assert.match(res.answer.error, /importing a wallet/);
    assert.equal(res.answer.walletReplaced, true, "taken quietly");
    assert.deepEqual(r.calls.decrypted, ["right"]);
    assert.equal(r.privateKeyRef.current, null, "the old key not taken");
    assert.equal(r.calls.startUps, 0);
  });
});

describe("entering the wallet password while the server, having refused to start, waits to exit", () => {
  /*-
   *  The server cannot start and exits in a few seconds: an unlock then
   *  would answer "Position management enabled" just before the exit.
   */
  it("is refused, saying the server is stopping, decrypting nothing", async () => {
    const r = route({ refusedLaunch: "PRIVATE_KEY is for another wallet" });
    const res = await r.unlock("right");
    assert.equal(res.status, 409);
    assert.match(res.answer.error, /cannot start and is stopping/);
    assert.equal(r.calls.revealed, 0, "no decrypt");
    assert.equal(r.privateKeyRef.current, null);
    assert.equal(r.calls.startUps, 0);
  });
});

describe("a Clear sent while the wallet is being unlocked", () => {
  /*-
   *  Gone partway, the wallet made its own decrypt fail as a wrong
   *  password, or left the bot a key with no wallet loaded, whose
   *  start-up read every wallet's saved positions. So a Clear in another
   *  tab is refused until the unlock has answered.
   */
  it("is refused during the wallet's decrypt, and the unlock takes the key", async () => {
    const answers = [];
    const r = route({
      duringDecrypt: async (clearNow) => answers.push(await clearNow()),
    });
    const res = await r.unlock("right");
    assert.equal(answers[0].status, 409);
    assert.match(answers[0].body.error, /decrypting the wallet/);
    assert.equal(r.wallet.saved, true, "the wallet kept");
    assert.equal(res.status, 200);
    assert.equal(r.privateKeyRef.current, KEY);
    assert.equal(r.calls.startUps, 1);
  });

  it("is refused during the api keys' decrypt, and the unlock takes the key", async () => {
    const answers = [];
    const r = route({
      duringApiKeys: async (_ref, clearNow) => answers.push(await clearNow()),
    });
    const res = await r.unlock("right");
    assert.equal(answers[0].status, 409);
    assert.equal(r.wallet.saved, true, "the wallet kept");
    assert.equal(res.status, 200);
    assert.equal(r.privateKeyRef.current, KEY);
    assert.equal(r.calls.startUps, 1);
  });

  it("goes through once the unlock has answered", async () => {
    const r = route();
    await r.unlock("right");
    assert.equal((await r.clearNow()).status, 200);
    assert.equal(r.wallet.saved, false, "the wallet removed");
  });

  it("goes through once a wrong password has been answered", async () => {
    const r = route();
    assert.equal((await r.unlock("wrong")).status, 401);
    assert.equal((await r.clearNow()).status, 200);
    assert.equal(r.wallet.saved, false, "the wallet removed");
  });
});

describe("an unlock whose decrypt another wallet's import overtook", () => {
  /*-
   *  A new wallet makes an older one stale (the user's rule, 2026-11-27):
   *  the decrypt opened a wallet that is no longer the server's. Nothing
   *  is wrong, so the answer says so in a way the dashboard takes
   *  quietly, never as a wrong password.
   */
  it("is answered 409 with walletReplaced set, taking no key and starting nothing", async () => {
    const r = route({ stale: true });
    const res = await r.unlock("right");
    assert.equal(res.status, 409);
    assert.equal(res.answer.walletReplaced, true);
    assert.equal(r.privateKeyRef.current, null, "no key taken");
    assert.deepEqual(r.calls.decrypted, [], "no api keys decrypted");
    assert.equal(r.calls.startUps, 0);
  });
});
