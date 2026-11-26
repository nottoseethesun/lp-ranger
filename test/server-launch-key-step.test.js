/**
 * @file test/server-launch-key-step.test.js
 * @description The launch's key step (`_tryResolveKey`,
 *   src/server/server-routes.js), over the bot's operations as
 *   test/_bot-route-adapters.js builds them: when it takes the key and
 *   begins the start-up, and when it stands aside, for a wallet import
 *   under way or a key the bot already holds, asked before the decrypt
 *   and after it. The rest of the server's routes are tested in
 *   test/server-routes.test.js.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const { createRouteHandlers } = require("./_bot-route-adapters");
const config = require("../src/lib/config");
const appPhase = require("../src/bot/app-phase");
const { makeDeps } = require("./helpers/route-handler-deps");

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
   * the key the bot holds) and then answers, or refuses the password
   * when `wrongPassword`; it counts decrypts, and records the key each
   * start-up asked the shared signer to be built from.
   */
  function keyStep({ duringDecrypt = () => {}, wrongPassword = false } = {}) {
    const seen = { revealed: 0, signers: [] };
    const privateKeyRef = { current: null };
    const base = makeDeps();
    const h = createRouteHandlers(
      makeDeps({
        privateKeyRef,
        envWalletPassword: () => "pw",
        walletManager: {
          ...base.walletManager,
          revealWallet: async () => {
            seen.revealed++;
            duringDecrypt(privateKeyRef);
            if (wrongPassword) throw new Error("Wrong password");
            return { privateKey: "0xold" };
          },
        },
        positionMgr: {
          ...base.positionMgr,
          getSharedSigner: async ({ privateKey }) => {
            seen.signers.push(privateKey);
            throw new Error("no chain in this test");
          },
        },
      }),
    );
    return { run: () => h._tryResolveKey(), seen, privateKeyRef };
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
