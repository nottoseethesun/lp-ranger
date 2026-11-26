/**
 * @file test/server-launch-key-step.test.js
 * @description The launch's key step (`_tryResolveKey`,
 *   src/server/server-routes.js), over the bot's operations as
 *   test/_bot-route-adapters.js builds them: when it takes the key and
 *   begins the start-up, and when it stands aside, for a wallet import
 *   under way or a key the bot already holds, asked before the decrypt
 *   and after it. A Clear (`DELETE /api/wallet`) is refused from its
 *   first step, the terminal prompt included, until the start-up has
 *   begun. The rest of the server's routes are tested in
 *   test/server-routes.test.js.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const { createRouteHandlers } = require("./_bot-route-adapters");
const config = require("../src/lib/config");
const appPhase = require("../src/bot/app-phase");
const { createWalletInUse } = require("../src/server/wallet-in-use");
const { makeDeps } = require("./helpers/route-handler-deps");
const { clearRequestOver } = require("./helpers/wallet-clear-request");

describe("_tryResolveKey", () => {
  /*-
   *  The launch's key step picks the key from PRIVATE_KEY, then the
   *  wallet unlocked by WALLET_PASSWORD or the terminal prompt
   *  (src/server/server-routes.js). These cases set no PRIVATE_KEY and
   *  hand it a WALLET_PASSWORD of their own. It stands aside, asked
   *  before the decrypt and after it, while a wallet import is under
   *  way, which takes its own wallet's key and starts that wallet's
   *  positions, and once the bot holds a key, which came from the
   *  dashboard while the launch waited on the prompt or the decrypt.
   */
  let savedKey;
  beforeEach(() => {
    savedKey = config.PRIVATE_KEY;
    config.PRIVATE_KEY = null;
  });
  afterEach(() => {
    config.PRIVATE_KEY = savedKey;
    appPhase._resetAppPhaseForTests();
  });

  /**
   * The key step over a wallet whose decrypt runs `duringDecrypt` (with
   * the key the bot holds, and `clearNow`, which sends a Clear through the
   * server's own route, as a dashboard tab does, and gives back its
   * answer) and then answers, or refuses the password when
   * `wrongPassword`; with `walletSaved` false, over no wallet file. The
   * password comes from WALLET_PASSWORD, or with `prompted` from the
   * terminal prompt of `--headless`, which runs `duringPrompt` (with
   * `clearNow`) while it waits. It counts decrypts, and records the key
   * each start-up asked the shared signer to be built from, running
   * `duringStartUp` (with `clearNow`) then.
   */
  function keyStep({
    duringDecrypt = () => {},
    wrongPassword = false,
    walletSaved = true,
    prompted = false,
    duringPrompt = () => {},
    duringStartUp = () => {},
  } = {}) {
    const seen = { revealed: 0, signers: [] };
    const privateKeyRef = { current: null };
    const wallet = { saved: walletSaved };
    const walletInUse = createWalletInUse();
    const clearNow = clearRequestOver(walletInUse, () => {
      wallet.saved = false;
    });
    const base = makeDeps();
    const h = createRouteHandlers(
      makeDeps({
        privateKeyRef,
        walletInUse,
        envWalletPassword: () => (prompted ? null : "pw"),
        askPassword: prompted
          ? async () => {
              await new Promise((resolve) => setImmediate(resolve));
              duringPrompt(clearNow);
              return "pw";
            }
          : null,
        walletManager: {
          ...base.walletManager,
          hasWallet: () => wallet.saved,
          revealWallet: async () => {
            seen.revealed++;
            duringDecrypt(privateKeyRef, clearNow);
            if (wrongPassword) throw new Error("Wrong password");
            return { privateKey: "0xold" };
          },
        },
        positionMgr: {
          ...base.positionMgr,
          getSharedSigner: async ({ privateKey }) => {
            seen.signers.push(privateKey);
            // A later turn, as a request from a dashboard tab comes on.
            await new Promise((resolve) => setImmediate(resolve));
            duringStartUp(clearNow);
            throw new Error("no chain in this test");
          },
        },
      }),
    );
    return {
      run: () => h._tryResolveKey(),
      seen,
      privateKeyRef,
      wallet,
      clearNow,
    };
  }

  it("takes the key and begins the start-up", async () => {
    const k = keyStep();
    await k.run();
    assert.strictEqual(k.seen.revealed, 1);
    assert.strictEqual(k.privateKeyRef.current, "0xold");
    assert.deepStrictEqual(k.seen.signers, ["0xold"], "the start-up began");
  });

  it("stands aside while a wallet import is under way, decrypting nothing", async () => {
    const k = keyStep();
    appPhase.beginWalletImport();
    await k.run();
    assert.strictEqual(k.seen.revealed, 0);
    assert.strictEqual(k.privateKeyRef.current, null);
    assert.deepStrictEqual(k.seen.signers, []);
  });

  it("stands aside when a wallet import begins during the decrypt", async () => {
    const k = keyStep({ duringDecrypt: () => appPhase.beginWalletImport() });
    await k.run();
    assert.strictEqual(k.seen.revealed, 1);
    assert.strictEqual(k.privateKeyRef.current, null, "the old key not taken");
    assert.deepStrictEqual(k.seen.signers, []);
  });

  it("does nothing once the wallet is unlocked, trying no password", async () => {
    /*-
     *  A dashboard import while the prompt waited loads a wallet the
     *  password typed may not open. Tried, its refusal stopped the
     *  server.
     */
    const k = keyStep({ wrongPassword: true });
    k.privateKeyRef.current = "0xdash";
    await k.run();
    assert.strictEqual(k.seen.revealed, 0);
    assert.strictEqual(k.privateKeyRef.current, "0xdash");
    assert.deepStrictEqual(k.seen.signers, [], "no second start-up");
  });

  it("does nothing when the wallet is unlocked during the decrypt", async () => {
    const k = keyStep({
      duringDecrypt: (ref) => {
        ref.current = "0xdash";
      },
    });
    await k.run();
    assert.strictEqual(k.seen.revealed, 1);
    assert.strictEqual(k.privateKeyRef.current, "0xdash", "its key kept");
    assert.deepStrictEqual(k.seen.signers, [], "no second start-up");
  });

  it("refuses a Clear during the decrypt, and takes the key", async () => {
    /*-
     *  Gone partway, the wallet made the decrypt fail as a wrong
     *  password, which stopped the launch, or left the bot a key with no
     *  wallet loaded, whose start-up read every wallet's saved positions.
     */
    const answers = [];
    const k = keyStep({
      duringDecrypt: (_ref, clearNow) => answers.push(clearNow()),
    });
    await k.run();
    assert.strictEqual(answers[0].status, 409);
    assert.match(answers[0].body.error, /unlocking the wallet/);
    assert.strictEqual(k.wallet.saved, true, "the wallet kept");
    assert.strictEqual(k.privateKeyRef.current, "0xold");
    assert.deepStrictEqual(k.seen.signers, ["0xold"], "the start-up began");
  });

  it("refuses a Clear while the terminal prompt waits for the password", async () => {
    const answers = [];
    const k = keyStep({
      prompted: true,
      duringPrompt: (clearNow) => answers.push(clearNow()),
    });
    await k.run();
    assert.strictEqual(answers[0].status, 409);
    assert.match(answers[0].body.error, /waiting for its password/);
    assert.strictEqual(k.wallet.saved, true, "the wallet kept");
    assert.strictEqual(k.privateKeyRef.current, "0xold");
  });

  it("lets a Clear through once the start-up has begun", async () => {
    // The key is taken: what a Clear does then is as after an unlock.
    const answers = [];
    const k = keyStep({
      duringStartUp: (clearNow) => answers.push(clearNow()),
    });
    await k.run();
    assert.deepStrictEqual(k.seen.signers, ["0xold"], "the start-up began");
    assert.strictEqual(answers[0].status, 200);
    assert.strictEqual(k.wallet.saved, false, "the wallet removed");
  });

  it("lets a Clear through once a wrong password has stopped it", async () => {
    const k = keyStep({ wrongPassword: true });
    await assert.rejects(k.run(), /Wrong password/);
    assert.strictEqual(k.clearNow().status, 200);
    assert.strictEqual(k.wallet.saved, false, "the wallet removed");
  });

  it("takes a PRIVATE_KEY with no wallet file, asking nothing of the wallet", async () => {
    // A key from .env needs no wallet file, so none missing sets it aside.
    config.PRIVATE_KEY = "0x" + "ab".repeat(32);
    const k = keyStep({ walletSaved: false });
    await k.run();
    assert.strictEqual(k.seen.revealed, 0);
    assert.strictEqual(k.privateKeyRef.current, config.PRIVATE_KEY);
    assert.deepStrictEqual(
      k.seen.signers,
      [config.PRIVATE_KEY],
      "the start-up began",
    );
  });

  it("takes a blank WALLET_PASSWORD as no password, trying none", async () => {
    /*-
     *  TEST-ONLY global swap: with no stand-in passed, the key step reads
     *  WALLET_PASSWORD from the environment, through `readEnv`, and that
     *  default is what this case checks. Restored pristine in the
     *  `finally` below, immediately after the call that needed it.
     */
    const saved = process.env.WALLET_PASSWORD;
    process.env.WALLET_PASSWORD = "   ";
    try {
      let revealed = 0;
      const privateKeyRef = { current: null };
      const base = makeDeps();
      const h = createRouteHandlers(
        makeDeps({
          privateKeyRef,
          walletManager: {
            ...base.walletManager,
            revealWallet: async () => {
              revealed++;
              return { privateKey: "0xold" };
            },
          },
        }),
      );
      await h._tryResolveKey();
      assert.strictEqual(revealed, 0);
      assert.strictEqual(privateKeyRef.current, null);
    } finally {
      if (saved === undefined) delete process.env.WALLET_PASSWORD;
      else process.env.WALLET_PASSWORD = saved;
    }
  });
});
