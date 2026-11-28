/**
 * @file src/server/server-routes.js
 * @description
 * Route handler functions extracted from server.js: the wallet, its key
 * and the api keys, the settings save, Telegram's settings and the held
 * stop. Whatever they ask of the bot goes through its interface
 * (src/bot/bot-interface.js). Exported as `createRouteHandlers(deps)`
 * factory.
 */

"use strict";

const { ethers } = require("ethers");
const { log } = require("../lib/log");
const config = require("../lib/config");
const {
  readEnv,
  envFilePath,
  envFileSets,
  setBeforeEnvFile,
} = require("../lib/env-settings");
const {
  saveEncryptedKey,
  loadEncryptedKey,
  hasEncryptedKey,
} = require("../lib/api-key-store");
const { setApiKey, setServiceEnabled } = require("../lib/api-key-holder");
const { moralisEnabledIn, pingMoralis } = require("../lib/moralis-key");
const {
  handleApiKeyStatus,
  validateMoralisKey,
} = require("./moralis-key-status");
const {
  createTelegramHandlers,
} = require("./telegram-notifications/server-telegram");
const { saveConfig } = require("../lib/bot-config-v2");
const { createStopWhenAllClear } = require("./stop-when-all-clear");
const { readShutdownTimings } = require("../lib/shutdown-timing");
const { sendBotResult } = require("./bot-result");

// The answer to a Reveal Key whose decrypt another wallet made stale.
const _STALE_REVEAL =
  "Another wallet replaced this one while its key was being decrypted. " +
  "Nothing was revealed.";

/**
 * Create route handler functions.
 * @param {object} deps
 * @param {object} deps.bot  The bot's interface (src/bot/bot-interface.js).
 * @param {object} deps.diskConfig  The loaded bot-config.json: Telegram's
 *   settings and the Moralis switch are read from it.
 * @param {object} deps.walletManager
 * @param {{begin: Function, end: Function}} deps.walletInUse  Marks the
 *   wallet in use while the launch's key step or a Reveal Key decrypt runs
 *   (src/server/wallet-in-use.js), so a Clear is refused meanwhile.
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @param {Function|null} [deps.askPassword]  Prompts on the terminal for
 *   the wallet password (`--unlock-at-terminal`), else null.
 * @param {() => (string|undefined)} [deps.envWalletPassword]  Reads
 *   WALLET_PASSWORD from the environment, through `readEnv`, which takes
 *   a blank value as none; a test passes its own.
 * @param {Function} deps.notifyShutdown  Sends the shutdown alert
 *   (src/server/telegram-notifications/server-shutdown.js).
 * @param {(ms: number) => Promise<void>} [deps.wait]  Waits `ms`; a test
 *   passes its own.
 * @param {(code: number) => void} [deps.exitProcess]  Ends the process
 *   with `code` after a launch it refuses; a test passes its own.
 * @param {() => (string|null)} [deps.envFile]  The `.env` file whose
 *   PRIVATE_KEY line the refusal of a launch names: the app's
 *   (`envFilePath`), unless a test passes its own.
 * @returns {object} Handler function map.
 */
function createRouteHandlers(deps) {
  const {
    bot,
    diskConfig,
    walletManager,
    walletInUse,
    jsonResponse,
    readJsonBody,
    askPassword,
    notifyShutdown,
    envWalletPassword = () => readEnv("WALLET_PASSWORD"),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exitProcess = (code) => process.exit(code),
    envFile = envFilePath,
  } = deps;

  /*- The wallet password, for saving api keys: set by an unlock, the
   *  launch's key step or an import, and forgotten by an import or a
   *  Clear. */
  let _sessionPassword = null;

  /**
   * Forget the session's wallet password, as a Clear does
   * (src/server/wallet-clear.js): nothing of a cleared wallet is kept.
   */
  function forgetSessionPassword() {
    _sessionPassword = null;
  }

  /*- Why the launch was refused, while the server waits to exit: every
   *  status answer carries it (`startRefusal`). */
  let _startRefusal = null;

  /**
   * Why the launch is refused, or null while it is not.
   * @returns {string|null}
   */
  function startRefusal() {
    return _startRefusal;
  }

  /** POST /api/config: the bot saves the settings (src/bot/settings-save.js). */
  async function _handleApiConfig(req, res) {
    const body = await readJsonBody(req);
    sendBotResult(jsonResponse, res, bot.saveSettings(body));
  }

  /**
   * POST /api/wallet: import a wallet, stop every position, and start the
   * new wallet's saved ones. Refused while the app may start nothing (a
   * stop, a start-up or another import under way, src/bot/app-phase.js),
   * and while a rebalance or compound is under way or a position is
   * starting (src/bot/under-way.js), so it never waits for one. From its
   * first step until its closing start-up has finished, the bot holds the
   * import as under way: a Manage, an unlock, a Clear and any start-up
   * but the import's own are refused, and the dashboard's badge reads
   * Syncing. Until the old wallet's positions are halted, no rebalance or
   * compound begins.
   */
  async function _handleWalletImport(req, res) {
    const refusal = bot.beginWalletImport();
    if (refusal !== null)
      return jsonResponse(res, 409, { ok: false, error: refusal });
    try {
      await _importWallet(req, res);
    } finally {
      bot.endWalletImport();
    }
  }

  /**
   * The import itself, while the bot holds it as under way: the new
   * wallet saved, the old one forgotten, the answer sent, then the new
   * key decrypted, the stored api keys decrypted with the same password,
   * the key handed to the bot, and the new wallet's saved positions
   * started.
   */
  async function _importWallet(req, res) {
    const body = await readJsonBody(req);
    log.info(
      "[server] Wallet import for %s (running: %d)",
      body.address?.slice(0, 10),
      bot.runningCount(),
    );
    await walletManager.importWallet({
      address: body.address,
      privateKey: body.privateKey,
      mnemonic: body.mnemonic || null,
      source: body.source || "key",
      password: body.password,
    });
    /*-
     *  Nothing of the previous wallet is kept: its positions are halted
     *  at once, its key and the signer built from it forgotten (the
     *  bot's `forgetWallet`, which waits for nothing, since no rebalance
     *  or compound is under way), and its password. Cleared before the
     *  new wallet is decrypted, so a failure there leaves the wallet
     *  locked rather than the old key in use.
     */
    bot.forgetWallet();
    _sessionPassword = null;
    jsonResponse(res, 200, {
      ok: true,
      address: body.address,
    });
    try {
      const { privateKey } = await walletManager.revealWallet(body.password);
      /*-
       *  The api keys before the key, as at a launch or an unlock, so the
       *  new wallet's start-up finds Telegram and Moralis set up, unless
       *  their decrypt fails, which is logged and the import goes on. Until
       *  its start-up has finished, the import refuses a Manage, an unlock,
       *  a Clear and any other start-up.
       */
      await _decryptApiKeys(body.password).catch((err) =>
        log.warn("[server] api key decrypt failed: %s", err.message),
      );
      bot.setPrivateKey(privateKey);
      log.info("[server] Loading key from imported wallet");
      await bot.startManagedPositions({ forImport: true });
    } catch (err) {
      log.warn("[server] Key resolution after import:", err.message);
    }
  }

  /**
   * POST /api/wallet/reveal: Reveal Key. The decrypt marks the wallet in
   * use (src/server/wallet-in-use.js), so a Clear is refused while it
   * runs. A decrypt that another wallet's import made stale
   * (src/lib/wallet-manager.js) is answered 409, nothing revealed, with
   * `walletReplaced` set, which the dashboard takes quietly
   * (dashboard-wallet-import.js). A wrong password throws, which
   * `handleRequest` (src/server.js) answers 403.
   */
  async function _handleWalletReveal(req, res) {
    const body = await readJsonBody(req);
    let s;
    walletInUse.begin();
    try {
      s = await walletManager.revealWallet(body.password);
    } catch (err) {
      if (err.staleWallet !== true) throw err;
      log.warn("[server] Reveal Key refused: %s", _STALE_REVEAL);
      return jsonResponse(res, 409, {
        ok: false,
        walletReplaced: true,
        error: _STALE_REVEAL,
      });
    } finally {
      walletInUse.end();
    }
    jsonResponse(res, 200, {
      ok: true,
      address: s.address,
      privateKey: s.privateKey,
      mnemonic: s.mnemonic,
      hasMnemonic: !!s.mnemonic,
      source: walletManager.getStatus().source,
    });
  }

  /*- The held stop, made by the first stop request. */
  let _heldStop = null;

  /**
   * POST /api/stop-when-all-clear: stop the server once nothing it has
   * under way is left (src/server/stop-when-all-clear.js). From the first
   * request on, the app is stopping for good (src/bot/app-phase.js), so no
   * position starts and no rebalance, compound or Reload begins; the
   * server exits once each position's move and scan under way has
   * finished. It exits when its connections have closed, or after the
   * exit timeout (`shutdown.exitTimeoutMs`), as Ctrl+C does: gentle-stop
   * keeps its connection open between requests, so the close alone could
   * wait for good. `npm run gentle-stop` sends it, and repeats it to show
   * what the stop still waits for: every request answers that, and only
   * the first changes anything. The positions saved as managed stay
   * saved, so the next launch starts them again. The shutdown alert goes
   * out as it does on Ctrl+C.
   */
  function _handleStopWhenAllClear(_req, res, srv) {
    if (_heldStop === null)
      _heldStop = createStopWhenAllClear({
        markStopping: () => bot.markStopping(),
        notifyShutdown,
        stopAll: () => bot.stopAll(),
        underWay: (movesOver) => bot.underWay(movesOver),
        scansEnded: () => bot.scansEnded(),
        exit: () => {
          srv.close(() => process.exit(0));
          const { exitTimeoutMs } = readShutdownTimings();
          setTimeout(() => process.exit(0), exitTimeoutMs);
        },
      });
    const { waitingFor } = _heldStop.request();
    jsonResponse(res, 200, { ok: true, stopping: true, waitingFor });
  }

  let _starting = false;

  /**
   * Why the launch's key step stands aside now, for the log, or null when
   * it may go on. A wallet import under way takes its own wallet's key
   * and starts that wallet's positions. A key the bot holds already came
   * from the dashboard while the launch waited on the prompt or on one of
   * its two decrypts, the wallet's and the api keys': an unlock has
   * started the saved positions, and an import has
   * loaded its own wallet, which the password given may not open.
   * @returns {string|null}
   */
  function _whyKeyStepStandsAside() {
    if (bot.refusalToTakeKey() !== null)
      return "a wallet import is under way, which takes its own wallet's key and starts that wallet's positions";
    if (bot.hasPrivateKey())
      return "the wallet is unlocked already, and its positions are left as they are";
    return null;
  }

  /**
   * The key from the wallet's password, which comes from WALLET_PASSWORD
   * or the terminal prompt (`--unlock-at-terminal`), and the password. The key is
   * null when no password came, or when the key step stands aside by the
   * time one did (`_whyKeyStepStandsAside`): then nothing is decrypted.
   * It is null too when an import replaced the wallet during the decrypt,
   * which made it stale (src/lib/wallet-manager.js): the key step then
   * stands aside, the import taking its own key, and the server goes on.
   * @returns {Promise<{pk: string|null, password: string|null}>}
   */
  async function _keyFromPassword() {
    const fromEnv = envWalletPassword();
    const password =
      fromEnv ||
      (askPassword && (await askPassword("[server] Enter wallet password: ")));
    if (!password || _whyKeyStepStandsAside() !== null)
      return { pk: null, password: password || null };
    let pk;
    try {
      pk = (await walletManager.revealWallet(password)).privateKey;
    } catch (err) {
      if (err.staleWallet !== true) throw err;
      log.info(
        "[server] Another wallet replaced this one during the launch's decrypt: its key is not taken",
      );
      return { pk: null, password: null };
    }
    const via = fromEnv ? "WALLET_PASSWORD" : "terminal";
    log.info("[server] Wallet unlocked via %s", via);
    return { pk, password };
  }

  /**
   * Why a `PRIVATE_KEY` cannot be taken at the launch, or null when it
   * can: it is for another wallet than the one imported. The server signs
   * with the key but picks the positions to start by the imported wallet,
   * so it would manage one wallet's positions with another wallet's key,
   * every rebalance stopping at its ownership check, and never start the
   * key's own. With no wallet imported, there is nothing to differ from.
   * The message names where the key in use came from: `.env`, or the
   * environment the server was started from, whose value outranks a
   * line in `.env` (dotenv leaves a variable already set as it is).
   * @param {string} pk  The key, with or without its `0x`.
   * @returns {string|null}  What is wrong and what to do, for the
   *   operator.
   */
  function _keyForAnotherWallet(pk) {
    if (!walletManager.hasWallet()) return null;
    const keyWallet = ethers.computeAddress(
      pk.startsWith("0x") ? pk : `0x${pk}`,
    );
    const imported = walletManager.getAddress();
    if (keyWallet.toLowerCase() === imported.toLowerCase()) return null;
    const file = envFile();
    const inEnvFile = file !== null && envFileSets(file, "PRIVATE_KEY");
    const fromEnvironment = setBeforeEnvFile("PRIVATE_KEY") || !inEnvFile;
    const where = fromEnvironment
      ? "in the environment the server was started from (the shell or a service manager)"
      : "in .env";
    const bothSet = fromEnvironment && inEnvFile;
    const outranks = bothSet
      ? " That value outranks the PRIVATE_KEY line in .env."
      : "";
    const readNext = bothSet
      ? ` The PRIVATE_KEY line in .env is read next, so it must also be ${imported}'s key, or be removed.`
      : "";
    return (
      `PRIVATE_KEY ${where} is for wallet ${keyWallet}, but the wallet ` +
      `imported in LP Ranger is ${imported}.${outranks} LP Ranger signs ` +
      "with one wallet and manages that wallet's positions, so both must " +
      `be the same wallet. To use ${imported}, remove PRIVATE_KEY ` +
      `${fromEnvironment ? "from that environment" : "from .env"}.` +
      `${readNext} To use ` +
      `${keyWallet}, run npm run reset-wallet, then node ` +
      `scripts/import-wallet.js to import ${keyWallet}. Then restart the ` +
      "server. The server is stopping now."
    );
  }

  /**
   * Refuse the launch for `reason`. It is logged, and every status answer
   * carries it from now on (`startRefusal`), so each open dashboard tab
   * shows it in a dialog, and a Clear and an unlock are refused, the
   * answer saying that LP Ranger cannot start and is stopping.
   * Nothing starts meanwhile: the app is stopping for good
   * (src/bot/app-phase.js). The exit follows (`_exitRefused`), once the
   * key step has ended.
   * @param {string} reason
   */
  function _refuseLaunch(reason) {
    log.error("[server] LP Ranger cannot start: %s", reason);
    _startRefusal = reason;
    bot.markStopping();
  }

  /**
   * Exit, having refused to start, once open dashboard tabs have had time
   * to ask for a status answer (`guaranteedDashboardHasPolledMs`: the
   * dashboard's poll interval, `dashboardPollIntervalMs`, times
   * `pollsBeforeAssumedSeen`; 7.5 s as shipped), without waiting for
   * anyone to read it.
   * @returns {Promise<void>}
   */
  async function _exitRefused() {
    const waitMs = bot.guaranteedDashboardHasPolledMs();
    log.error(
      "[server] Exiting in %ss, once open dashboard tabs have shown why",
      (waitMs / 1000).toFixed(1),
    );
    await wait(waitMs);
    log.error("[server] Exiting: the launch was refused");
    exitProcess(1);
  }

  /**
   * Whether the launch's key step stands aside now
   * (`_whyKeyStepStandsAside`), logging why when it does.
   * @returns {boolean}
   */
  function _keyStepStandsAside() {
    const aside = _whyKeyStepStandsAside();
    if (aside === null) return false;
    log.info("[server] The launch's key step stands aside: %s", aside);
    return true;
  }

  /**
   * The launch's key step: resolve the private key. When it came from the
   * wallet's password, decrypt the api keys with it too. A `PRIVATE_KEY`
   * brings no password and decrypts none, and the dashboard offers no
   * unlock while the server holds a key. Then hand the key to the bot and
   * begin the start-up of the positions saved as managed, so no position
   * starts until every decrypt has finished. It stands aside while a
   * wallet import is under way and once the bot holds a key. It asks
   * before the wallet's decrypt, again after it and after the api keys',
   * since the prompt and each decrypt can take a while.
   * @returns {Promise<{startUp: Promise<void>}|null>} The start-up begun,
   *   or null when none was.
   */
  async function _keyStep() {
    let pk = null;
    let password = null;

    // 1. PRIVATE_KEY env var — plaintext, simplest.
    if (config.PRIVATE_KEY && /^(0x)?[0-9a-f]{64}$/i.test(config.PRIVATE_KEY)) {
      const refusal = _keyForAnotherWallet(config.PRIVATE_KEY);
      if (refusal !== null) {
        _refuseLaunch(refusal);
        return null;
      }
      pk = config.PRIVATE_KEY;
    }
    // 2. Encrypted wallet — env var, the --unlock-at-terminal prompt,
    //    or wait for dashboard unlock.
    else if (walletManager.hasWallet()) {
      ({ pk, password } = await _keyFromPassword());
    }

    // Asked again after the wallet's decrypt, as well as before it.
    if (_keyStepStandsAside()) return null;

    if (!pk) {
      if (askPassword) {
        /*- --unlock-at-terminal, with no key from the prompt, nor from a
         *  dashboard unlock while it waited: the server exits here, so the
         *  message names only the ways to give the password at the next
         *  start. */
        if (walletManager.hasWallet())
          log.error(
            "[server] The wallet is locked: no password was given. Set" +
              " WALLET_PASSWORD in .env, or start the server with" +
              " --unlock-at-terminal from a terminal to type it.",
          );
        else
          log.error(
            "[server] No wallet imported. Run" +
              " `node scripts/import-wallet.js` first.",
          );
        process.exit(1);
      }
      if (walletManager.hasWallet())
        log.info(
          "[server] Wallet locked — unlock" + " via dashboard to start bot.",
        );
      else log.info("[server] No wallet key" + " — dashboard-only mode.");
      return null;
    }
    if (password) {
      /*-
       *  The api keys are decrypted before the bot takes the key, so no
       *  position starts until that decrypt has ended. Asked again after
       *  it, since an import or the dashboard's unlock can come meanwhile.
       *  A failure is logged and the start goes on.
       */
      await _decryptApiKeys(password).catch((err) =>
        log.warn("[server] api key decrypt failed: %s", err.message),
      );
      if (_keyStepStandsAside()) return null;
    } else {
      log.info(
        "[server] Wallet key loaded from PRIVATE_KEY. The stored Telegram and Moralis keys, if any, are not decrypted this session, since a PRIVATE_KEY brings no wallet password. To have them, start without PRIVATE_KEY, with the wallet imported, and unlock it in the dashboard, at the --unlock-at-terminal prompt or with WALLET_PASSWORD.",
      );
    }
    bot.setPrivateKey(pk);
    // It reads the wallet's address before its first wait.
    return { startUp: bot.startManagedPositions() };
  }

  /**
   * Run the launch's key step (`_keyStep`), one at a time, and wait for
   * the start-up it begins. The wallet is marked in use from the key
   * step's first step, the terminal prompt of `--unlock-at-terminal`
   * included, until the start-up has begun or the step has ended without
   * one (src/server/wallet-in-use.js): a Clear is refused meanwhile
   * (src/server/wallet-clear.js), so the wallet is there at every step.
   * Having refused to start, the server exits after the mark has ended
   * (`_exitRefused`).
   */
  async function _tryResolveKey() {
    if (_starting) {
      log.info("[server] Start already in progress" + " — skipping");
      return;
    }
    _starting = true;
    try {
      let begun = null;
      walletInUse.begin();
      try {
        begun = await _keyStep();
      } finally {
        walletInUse.end();
      }
      if (begun !== null) await begun.startUp;
      // Having refused to start, the server waits, then exits, the wallet no longer in use.
      else if (_startRefusal !== null) await _exitRefused();
    } finally {
      _starting = false;
    }
  }

  /** Encrypt and save a third-party API key. */
  async function _handleApiKeySave(req, res) {
    const body = await readJsonBody(req);
    const pw = body.password || _sessionPassword;
    if (!body.service || !body.key || !pw)
      return jsonResponse(res, 400, {
        ok: false,
        error: "service, key, and password are required",
      });
    try {
      await saveEncryptedKey(body.service, body.key, pw);
      setApiKey(body.service, body.key);
      log.info("[server] API key saved for %s — validating…", body.service);
      if (body.service === "moralis") {
        const status = await pingMoralis();
        log.info("[server] Moralis key post-save status: %s", status);
      }
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      log.error("[server] API key save error:", err.message);
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
  }

  /** Route wrapper — delegates to src/server/moralis-key-status.js. */
  async function _handleApiKeyStatus(_, res) {
    return handleApiKeyStatus(_, res, jsonResponse);
  }

  const _tgHandlers = createTelegramHandlers({
    readJsonBody,
    jsonResponse,
    saveConfig,
    diskConfig,
    getSessionPassword: () => _sessionPassword,
  });

  /**
   * Decrypt the stored api keys, Telegram's and Moralis's, with the
   * wallet's password. It settles once every one is decrypted or has
   * failed, each failure logged, so a caller that waits for it, as the
   * launch, the unlock and the import do before the bot takes the key,
   * starts no position until Telegram and Moralis are set up or their
   * decrypt has failed (the user's ruling, 2026-11-25: "In finance,
   * reliability is more important than responsiveness").
   * @param {string} password  The wallet's password.
   * @returns {Promise<void>}
   */
  async function _decryptApiKeys(password) {
    _sessionPassword = password;
    await _tgHandlers.decryptTelegramKeys(password).catch((err) => {
      log.warn("[server] Failed to decrypt the Telegram keys: %s", err.message);
    });
    for (const svc of ["moralis"]) {
      if (!hasEncryptedKey(svc)) continue;
      try {
        const key = await loadEncryptedKey(svc, password);
        setApiKey(svc, key);
        log.info("[server] Decrypted API key: %s", svc);
      } catch (err) {
        log.warn("[server] Failed to decrypt %s key: %s", svc, err.message);
      }
    }
    /*- Honour the saved toggle as soon as the key is in memory, so an
     *  operator who turned Moralis off does not get one round of calls
     *  on the next unlock before the setting is noticed. */
    setServiceEnabled("moralis", moralisEnabledIn(diskConfig.global));
    // Validate Moralis key after decryption
    validateMoralisKey();
  }

  return {
    _handleApiConfig,
    _handleWalletImport,
    _handleWalletReveal,
    _handleStopWhenAllClear,
    _tryResolveKey,
    _handleApiKeySave,
    _handleApiKeyStatus,
    _decryptApiKeys,
    forgetSessionPassword,
    startRefusal,
    _tgHandlers,
  };
}

module.exports = { createRouteHandlers };
