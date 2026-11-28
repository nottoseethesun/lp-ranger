/**
 * @file test/server-launch-key-step.test.js
 * @description The launch's key step (`_tryResolveKey`,
 *   src/server/server-routes.js), over the bot's operations as
 *   test/_bot-route-adapters.js builds them: when it takes the key and
 *   begins the start-up, and when it stands aside, for a wallet import
 *   under way or a key the bot already holds, asked before the decrypt
 *   and after it. A Clear (`DELETE /api/wallet`) is refused from its
 *   first step, the terminal prompt included, until the start-up has
 *   begun, and the start-up refuses one in turn. A decrypt another
 *   wallet's import overtook is stale, and the key step stands aside. A
 *   `PRIVATE_KEY` for another wallet than the one imported refuses the
 *   launch: logged, told to the dashboards, then the server exits. The
 *   rest of the server's routes are tested in test/server-routes.test.js.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { ethers } = require("ethers");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { _setEnvBeforeFileForTests } = require("../src/lib/env-settings");
const { createRouteHandlers } = require("./_bot-route-adapters");
const config = require("../src/lib/config");
const { _setSinkForTests } = require("../src/lib/log");
const appPhase = require("../src/bot/app-phase");
const {
  guaranteedDashboardHasPolledMs,
} = require("../src/bot/dashboard-has-polled");
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
   * terminal prompt of `--unlock-at-terminal`, which runs `duringPrompt` (with
   * `clearNow`) while it waits. It counts decrypts, and records the key
   * each start-up asked the shared signer to be built from, running
   * `duringStartUp` (with `clearNow`) then. `envFile` names a `.env` of
   * the case's own; with none, the app's, of which there is none under
   * the test runner.
   */
  function keyStep({
    duringDecrypt = () => {},
    wrongPassword = false,
    walletSaved = true,
    prompted = false,
    duringPrompt = () => {},
    duringStartUp = () => {},
    duringExitWait = () => {},
    stale = false,
    importedAddress = "0x1234",
    envFile,
  } = {}) {
    const seen = { revealed: 0, signers: [], waited: [], exits: [] };
    const privateKeyRef = { current: null };
    const wallet = { saved: walletSaved };
    const walletInUse = createWalletInUse();
    // The launch's refusal is the route handlers', built below.
    const clearNow = clearRequestOver(
      walletInUse,
      () => {
        wallet.saved = false;
      },
      { startRefusal: () => h.startRefusal() },
    );
    const base = makeDeps();
    const h = createRouteHandlers(
      makeDeps({
        privateKeyRef,
        walletInUse,
        wait: async (ms) => {
          seen.waited.push(ms);
          seen.inUseAtWait = walletInUse.inUse();
          await duringExitWait(clearNow);
        },
        exitProcess: (code) => seen.exits.push(code),
        ...(envFile === undefined ? {} : { envFile }),
        envWalletPassword: () => (prompted ? null : "pw"),
        askPassword: prompted
          ? async () => {
              await new Promise((resolve) => setImmediate(resolve));
              await duringPrompt(clearNow);
              return "pw";
            }
          : null,
        walletManager: {
          ...base.walletManager,
          hasWallet: () => wallet.saved,
          getAddress: () => importedAddress,
          revealWallet: async () => {
            seen.revealed++;
            await duringDecrypt(privateKeyRef, clearNow);
            if (stale)
              throw Object.assign(new Error("The wallet changed"), {
                staleWallet: true,
              });
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
            await duringStartUp(clearNow);
            throw new Error("no chain in this test");
          },
        },
      }),
    );
    return {
      run: () => h._tryResolveKey(),
      startRefusal: () => h.startRefusal(),
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
      duringDecrypt: async (_ref, clearNow) => answers.push(await clearNow()),
    });
    await k.run();
    assert.strictEqual(answers[0].status, 409);
    assert.match(answers[0].body.error, /decrypting the wallet/);
    assert.strictEqual(k.wallet.saved, true, "the wallet kept");
    assert.strictEqual(k.privateKeyRef.current, "0xold");
    assert.deepStrictEqual(k.seen.signers, ["0xold"], "the start-up began");
  });

  it("refuses a Clear while the terminal prompt waits for the password", async () => {
    const answers = [];
    const k = keyStep({
      prompted: true,
      duringPrompt: async (clearNow) => answers.push(await clearNow()),
    });
    await k.run();
    assert.strictEqual(answers[0].status, 409);
    assert.match(answers[0].body.error, /waiting for the wallet's password/);
    assert.strictEqual(k.wallet.saved, true, "the wallet kept");
    assert.strictEqual(k.privateKeyRef.current, "0xold");
  });

  it("refuses a Clear while the start-up runs, and lets one through once it has ended", async () => {
    /*-
     *  The start-up would go on starting positions the Clear stops, so it
     *  refuses a Clear with its own reason; the key step's mark has ended.
     */
    const answers = [];
    const k = keyStep({
      duringStartUp: async (clearNow) => answers.push(await clearNow()),
    });
    await k.run();
    assert.deepStrictEqual(k.seen.signers, ["0xold"], "the start-up began");
    assert.strictEqual(answers[0].status, 409);
    /*-
     *  No position is saved here, so the start-up only builds the
     *  signer: its refusal names no count.
     */
    assert.strictEqual(
      answers[0].body.error,
      "LP Ranger is starting up. Try Clear Wallet again in a moment.",
    );
    assert.strictEqual(k.wallet.saved, true, "the wallet kept");
    assert.strictEqual((await k.clearNow()).status, 200);
    assert.strictEqual(k.wallet.saved, false, "the wallet removed");
  });

  it("lets a Clear through once a wrong password has stopped it", async () => {
    const k = keyStep({ wrongPassword: true });
    await assert.rejects(k.run(), /Wrong password/);
    assert.strictEqual((await k.clearNow()).status, 200);
    assert.strictEqual(k.wallet.saved, false, "the wallet removed");
  });

  it("stands aside, the server going on, when another wallet's import overtook the decrypt", async () => {
    /*-
     *  A new wallet makes an older one stale (the user's rule,
     *  2026-11-27). Before, the decrypt failed as a wrong password and
     *  the launch's error ended the server.
     */
    const k = keyStep({
      stale: true,
      duringDecrypt: () => appPhase.beginWalletImport(),
    });
    await k.run();
    assert.strictEqual(k.privateKeyRef.current, null, "its key not taken");
    assert.deepStrictEqual(k.seen.signers, [], "no start-up");
    assert.deepStrictEqual(k.seen.exits, [], "the server goes on");
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

  it("takes a PRIVATE_KEY for the wallet imported, in any letter case", async () => {
    config.PRIVATE_KEY = "ab".repeat(32);
    const own = ethers.computeAddress(`0x${config.PRIVATE_KEY}`);
    const k = keyStep({ importedAddress: own.toLowerCase() });
    await k.run();
    assert.strictEqual(k.privateKeyRef.current, config.PRIVATE_KEY);
    assert.strictEqual(k.startRefusal(), null);
    assert.deepStrictEqual(k.seen.exits, []);
  });

  it("refuses a PRIVATE_KEY for another wallet than the one imported, then exits", async () => {
    /*-
     *  The server would sign with the key's wallet but start the imported
     *  wallet's positions. It says what is wrong and what to do, ending
     *  with a restart, in its log and in every status answer, gives open
     *  tabs time to show it, and exits, waiting for no one to read it.
     */
    config.PRIVATE_KEY = "0x" + "ab".repeat(32);
    const keyWallet = ethers.computeAddress(config.PRIVATE_KEY);
    const imported = "0x" + "C".repeat(40);
    const errors = [];
    const restoreSink = _setSinkForTests({
      error: (...args) => errors.push(util.format(...args)),
    });
    let k;
    try {
      k = keyStep({ importedAddress: imported });
      await k.run();
    } finally {
      restoreSink();
    }
    assert.strictEqual(k.privateKeyRef.current, null, "the key not taken");
    assert.deepStrictEqual(k.seen.signers, [], "no start-up");
    const refusal = k.startRefusal();
    assert.ok(refusal.includes(keyWallet), "names the key's wallet");
    assert.ok(refusal.includes(imported), "names the imported wallet");
    assert.match(refusal, /restart the server/);
    /*-
     *  To use the key's wallet, it must be imported, not only the other
     *  removed: with no wallet imported, the start-up takes every
     *  wallet's saved positions. Under the test runner no `.env` is read,
     *  so the key came from the environment, and the message says so.
     */
    assert.ok(
      refusal.includes(
        `To use ${keyWallet}, run npm run reset-wallet, then node scripts/import-wallet.js to import ${keyWallet}.`,
      ),
      "imports the key's wallet",
    );
    assert.match(refusal, /in the environment the server was started from/);
    assert.match(refusal, /remove PRIVATE_KEY from that environment/);
    assert.ok(
      errors.some((l) => l.includes("cannot start") && l.includes(keyWallet)),
      "logged",
    );
    assert.ok(appPhase.isStopping(), "nothing starts meanwhile");
    assert.deepStrictEqual(
      k.seen.waited,
      [guaranteedDashboardHasPolledMs()],
      "waits for open tabs to ask, once",
    );
    assert.deepStrictEqual(k.seen.exits, [1], "then it exits");
  });

  /**
   * The refusal of a launch whose PRIVATE_KEY is for another wallet,
   * with `.env` holding `envText` and the environment the server was
   * started from having set `setBefore` before `.env` was read.
   */
  async function refusalWith(envText, setBefore) {
    config.PRIVATE_KEY = "0x" + "ab".repeat(32);
    const file = path.join(makeTestTempFolder("launch-env"), ".env");
    fs.writeFileSync(file, envText);
    const saved = _setEnvBeforeFileForTests(setBefore);
    const restoreSink = _setSinkForTests({ error: () => {} });
    try {
      const k = keyStep({
        importedAddress: "0x" + "C".repeat(40),
        envFile: () => file,
      });
      await k.run();
      return k.startRefusal();
    } finally {
      restoreSink();
      _setEnvBeforeFileForTests(saved === null ? null : [...saved]);
    }
  }

  it("names the environment's key, which outranks .env's, when both set PRIVATE_KEY, and that .env's is read next", async () => {
    /*-
     *  dotenv leaves a variable already set as it is, so the shell's key
     *  is the one in use, and the .env line is the one read once the
     *  shell's is gone: it must be the imported wallet's key too.
     */
    const refusal = await refusalWith("PRIVATE_KEY=0x" + "cd".repeat(32), [
      "PRIVATE_KEY",
    ]);
    assert.match(
      refusal,
      /^PRIVATE_KEY in the environment the server was started from \(the shell or a service manager\) is for wallet /,
    );
    assert.match(
      refusal,
      /That value outranks the PRIVATE_KEY line in \.env\. LP Ranger signs/,
    );
    assert.match(
      refusal,
      /remove PRIVATE_KEY from that environment\. The PRIVATE_KEY line in \.env is read next, so it must also be 0xC{40}'s key, or be removed\. To use /,
    );
  });

  it("names .env when .env alone set PRIVATE_KEY", async () => {
    const refusal = await refusalWith("PRIVATE_KEY=0x" + "ab".repeat(32), []);
    assert.match(refusal, /^PRIVATE_KEY in \.env is for wallet /);
    assert.match(refusal, /remove PRIVATE_KEY from \.env\./);
    assert.doesNotMatch(refusal, /outranks/);
    assert.doesNotMatch(refusal, /read next/);
  });

  it("refuses a Clear, saying LP Ranger cannot start and is stopping, while the server, having refused to start, waits to exit, the wallet no longer in use", async () => {
    /*-
     *  The key step's mark on the wallet ends before the wait, so the
     *  Clear's refusal says why truly: not that the wallet is being
     *  decrypted, but that the server cannot start and is stopping.
     */
    config.PRIVATE_KEY = "0x" + "ab".repeat(32);
    const answers = [];
    const restoreSink = _setSinkForTests({ error: () => {} });
    let k;
    try {
      k = keyStep({
        importedAddress: "0x" + "C".repeat(40),
        duringExitWait: async (clearNow) => answers.push(await clearNow()),
      });
      await k.run();
    } finally {
      restoreSink();
    }
    assert.strictEqual(k.seen.inUseAtWait, false, "not marked in use");
    assert.strictEqual(answers[0].status, 409);
    assert.match(answers[0].body.error, /cannot start and is stopping/);
    assert.strictEqual(k.wallet.saved, true, "the wallet kept");
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
