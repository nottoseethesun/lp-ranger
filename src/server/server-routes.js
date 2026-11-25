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

const { log } = require("../lib/log");
const config = require("../lib/config");
const { readEnv } = require("../lib/env-settings");
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

/**
 * Create route handler functions.
 * @param {object} deps
 * @param {object} deps.bot  The bot's interface (src/bot/bot-interface.js).
 * @param {object} deps.diskConfig  The loaded bot-config.json: Telegram's
 *   settings and the Moralis switch are read from it.
 * @param {object} deps.walletManager
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @param {Function|null} [deps.askPassword]  Prompts on the terminal for
 *   the wallet password (`--headless`), else null.
 * @param {() => (string|undefined)} [deps.envWalletPassword]  Reads
 *   WALLET_PASSWORD from the environment, through `readEnv`, which takes
 *   a blank value as none; a test passes its own.
 * @param {Function} deps.notifyShutdown  Sends the shutdown alert
 *   (src/server/telegram-notifications/server-shutdown.js).
 * @returns {object} Handler function map.
 */
function createRouteHandlers(deps) {
  const {
    bot,
    diskConfig,
    walletManager,
    jsonResponse,
    readJsonBody,
    askPassword,
    notifyShutdown,
    envWalletPassword = () => readEnv("WALLET_PASSWORD"),
  } = deps;

  /** Cached wallet password for API key encryption (set on unlock). */
  let _sessionPassword = null;

  /** POST /api/config: the bot saves the settings (src/bot/settings-save.js). */
  async function _handleApiConfig(req, res) {
    const body = await readJsonBody(req);
    sendBotResult(jsonResponse, res, bot.saveSettings(body));
  }

  /**
   * POST /api/wallet: import a wallet, stop every position, and start the
   * new wallet's saved ones. Refused while the app may start nothing (a
   * stop, a start-up or another import under way, src/bot/app-phase.js).
   * From its first step until its closing start-up has finished, the bot
   * holds the import as under way: a Manage, an unlock and any start-up
   * but the import's own are refused, and the dashboard's badge reads
   * Syncing.
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
   * key decrypted and the new wallet's saved positions started.
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
     *  Nothing of the previous wallet is kept once its positions have
     *  stopped: its key and the signer built from it (the bot's
     *  `forgetWallet`), and its password. Cleared before the new wallet
     *  is decrypted, so a failure there leaves the wallet locked rather
     *  than the old key in use.
     */
    await bot.forgetWallet();
    _sessionPassword = null;
    jsonResponse(res, 200, {
      ok: true,
      address: body.address,
    });
    try {
      bot.setPrivateKey(
        (await walletManager.revealWallet(body.password)).privateKey,
      );
      log.info("[server] Loading key from imported wallet");
      _decryptApiKeys(body.password).catch(() => {});
      await bot.startManagedPositions({ forImport: true });
    } catch (err) {
      log.warn("[server] Key resolution after import:", err.message);
    }
  }

  async function _handleWalletReveal(req, res) {
    const body = await readJsonBody(req);
    const s = await walletManager.revealWallet(body.password);
    jsonResponse(res, 200, {
      ok: true,
      address: walletManager.getAddress(),
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
   * from the dashboard while the launch waited on the prompt or the
   * decrypt: an unlock has started the saved positions, and an import has
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
   * or the terminal prompt (`--headless`), and the password. The key is
   * null when no password came, or when the key step stands aside by the
   * time one did (`_whyKeyStepStandsAside`): then nothing is decrypted.
   * @returns {Promise<{pk: string|null, password: string|null}>}
   */
  async function _keyFromPassword() {
    const fromEnv = envWalletPassword();
    const password =
      fromEnv ||
      (askPassword && (await askPassword("[server] Enter wallet password: ")));
    if (!password || _whyKeyStepStandsAside() !== null)
      return { pk: null, password: password || null };
    const pk = (await walletManager.revealWallet(password)).privateKey;
    const via = fromEnv ? "WALLET_PASSWORD" : "terminal";
    log.info("[server] Wallet unlocked via %s", via);
    return { pk, password };
  }

  /**
   * The launch's key step: resolve the private key, hand it to the bot
   * and start the positions saved as managed. It stands aside while a
   * wallet import is under way, and once the bot holds a key, asked
   * before the decrypt and again after it, since the prompt and the
   * decrypt can each take a while.
   */
  async function _tryResolveKey() {
    if (_starting) {
      log.info("[server] Start already in progress" + " — skipping");
      return;
    }
    _starting = true;
    try {
      let pk = null;
      let password = null;

      // 1. PRIVATE_KEY env var — plaintext, simplest.
      if (
        config.PRIVATE_KEY &&
        /^(0x)?[0-9a-f]{64}$/i.test(config.PRIVATE_KEY)
      ) {
        pk = config.PRIVATE_KEY;
      }
      // 2. Encrypted wallet — env var, headless prompt,
      //    or wait for dashboard unlock.
      else if (walletManager.hasWallet()) {
        ({ pk, password } = await _keyFromPassword());
      }

      // Asked again after the decrypt, as well as before it.
      const aside = _whyKeyStepStandsAside();
      if (aside !== null) {
        log.info("[server] The launch's key step stands aside: %s", aside);
        return;
      }

      if (!pk) {
        if (askPassword) {
          // --headless: CLI is the only path — don't suggest the dashboard.
          if (walletManager.hasWallet())
            log.error(
              "[server] The wallet is locked: no password was given. Set" +
                " WALLET_PASSWORD in .env, or start the server with" +
                " --headless from a terminal to type it.",
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
        return;
      }
      bot.setPrivateKey(pk);
      if (password) {
        _sessionPassword = password;
        _decryptApiKeys(password).catch(() => {});
      } else {
        log.info(
          "[server] Wallet key loaded without password — encrypted Telegram/Moralis keys (if any) will NOT be decrypted this session. Unlock via dashboard to enable notifications.",
        );
      }
      await bot.startManagedPositions();
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

  /** Decrypt all API keys + Telegram credentials after wallet unlock. */
  async function _decryptApiKeys(password) {
    _sessionPassword = password;
    _tgHandlers.decryptTelegramKeys(password).catch(() => {});
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
    _tgHandlers,
  };
}

module.exports = { createRouteHandlers };
