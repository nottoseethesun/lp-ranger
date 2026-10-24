/**
 * @file src/lib/server-routes.js
 * @description
 * Route handler functions extracted from server.js.
 * Exported as `createRouteHandlers(deps)` factory.
 */

"use strict";

const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const sendTx = require("./send-transaction");
const {
  saveEncryptedKey,
  loadEncryptedKey,
  hasEncryptedKey,
} = require("./api-key-store");
const { setApiKey, setServiceEnabled } = require("./api-key-holder");
const {
  moralisEnabledIn,
  pingMoralis,
  validateMoralisKey,
  handleApiKeyStatus,
} = require("./server-moralis");
const {
  createTelegramHandlers,
} = require("./telegram-notifications/server-telegram");
const {
  saveConfig,
  compositeKey,
  readConfigValue,
} = require("./bot-config-v2");
const { resolveLiveKey } = require("./server-key-resolver");
// position-detector used via server-scan.js
const { createScanHandlers } = require("./server-scan");
const { createReloadPositionHandler } = require("./server-reload-position");
const { createRescanPricesHandler } = require("./server-rescan-prices");
const { createAutoStartManagedPositions } = require("./server-auto-start");
const { markStopping, refusalToStart } = require("./app-phase");
const { createStopWhenAllClear } = require("./stop-when-all-clear");
const { createConfigRouteHandler } = require("./server-config-route");
const {
  computeQuickDetails: _defaultComputeQuickDetails,
  computeLifetimeDetails: _defaultComputeLifetimeDetails,
} = require("./position-details");
const { emojiId } = require("./logger");

/**
 * Create route handler functions.
 * @param {object} deps
 * @param {object} deps.diskConfig
 * @param {object} deps.positionMgr
 * @param {{ current: string|null }}
 *   deps.privateKeyRef
 * @param {object} deps.walletManager
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @param {Function}
 *   deps.getAllPositionBotStates
 * @param {Function}
 *   deps.createPerPositionBotState
 * @param {Function} deps.attachMultiPosDeps
 * @param {Function} deps.updatePositionState
 * @param {Function} deps.notifyShutdown  Sends the shutdown alert
 *   (src/lib/telegram-notifications/server-shutdown.js).
 * @returns {object} Handler function map.
 */
function createRouteHandlers(deps) {
  const {
    diskConfig,
    positionMgr,
    privateKeyRef,
    walletManager,
    jsonResponse,
    readJsonBody,
    getAllPositionBotStates,
    createPerPositionBotState,
    attachMultiPosDeps,
    updatePositionState,
    askPassword,
    notifyShutdown,
    /*- position-details functions are overridable from tests so we
     *  don't exercise a real RPC in unit tests. */
    computeQuickDetails = _defaultComputeQuickDetails,
    computeLifetimeDetails = _defaultComputeLifetimeDetails,
  } = deps;

  /** Cached wallet password for API key encryption (set on unlock). */
  let _sessionPassword = null;

  // POST /api/config, built by its own module.
  const _handleApiConfig = createConfigRouteHandler(deps);

  /*-
   *  POST /api/wallet: import a wallet, then stop every position and
   *  start the saved ones again under it. Refused while the start-up is
   *  under way or the app is stopping (src/lib/app-phase.js), since it would
   *  start positions then.
   */
  async function _handleWalletImport(req, res) {
    const refusal = refusalToStart();
    if (refusal !== null)
      return jsonResponse(res, 409, { ok: false, error: refusal });
    const body = await readJsonBody(req);
    log.info(
      "[server] Wallet import for %s (running: %d)",
      body.address?.slice(0, 10),
      positionMgr.runningCount(),
    );
    await walletManager.importWallet({
      address: body.address,
      privateKey: body.privateKey,
      mnemonic: body.mnemonic || null,
      source: body.source || "key",
      password: body.password,
    });
    await positionMgr.stopAll();
    /*-
     *  Nothing of the previous wallet is kept once its positions have
     *  stopped: its key, its password, and the signer built from the key,
     *  which would otherwise sign for the new wallet's positions. Cleared
     *  before the new wallet is decrypted, so a failure there leaves the
     *  wallet locked rather than the old key in use.
     */
    privateKeyRef.current = null;
    _sessionPassword = null;
    positionMgr.resetSharedSigner();
    jsonResponse(res, 200, {
      ok: true,
      address: body.address,
    });
    try {
      privateKeyRef.current = (
        await walletManager.revealWallet(body.password)
      ).privateKey;
      log.info("[bot] Loading key from imported wallet");
      _decryptApiKeys(body.password).catch(() => {});
      await _autoStartManagedPositions();
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

  // Scan handlers delegated to server-scan.js
  let _globalScanStatus = "idle";
  let _globalScanProgress = null;
  const scanHandlers = createScanHandlers({
    walletManager,
    jsonResponse,
    readJsonBody,
    getAllPositionBotStates,
    positionMgr,
    getGlobalScanStatus: () => ({
      status: _globalScanStatus,
      progress: _globalScanProgress,
    }),
    setGlobalScanStatus: (s, p) => {
      _globalScanStatus = s;
      _globalScanProgress = p || null;
    },
  });

  const _handlePositionReload = createReloadPositionHandler({
    jsonResponse,
    readJsonBody,
    getAllPositionBotStates,
    positionMgr,
    walletManager,
    diskConfig,
  });

  const _handleRescanPrices = createRescanPricesHandler({
    jsonResponse,
    readJsonBody,
    getAllPositionBotStates,
    positionMgr,
    walletManager,
    diskConfig,
  });

  /*- The held stop, made by the first stop request. */
  let _heldStop = null;

  /**
   * POST /api/stop-when-all-clear: stop the server once nothing it has
   * under way is left (src/lib/stop-when-all-clear.js). From the first
   * request on, the app is stopping for good (src/lib/app-phase.js), so no
   * position starts and no rebalance, compound or Reload begins; the
   * server exits once each position's move and scan under way has
   * finished. `npm run gentle-stop` sends it, and repeats it to show what
   * the stop still waits for: every request answers that, and only the
   * first changes anything. The positions saved as managed stay saved,
   * so the next launch starts them again. The shutdown alert goes out
   * as it does on Ctrl+C.
   */
  function _handleStopWhenAllClear(_req, res, srv) {
    if (_heldStop === null)
      _heldStop = createStopWhenAllClear({
        markStopping,
        notifyShutdown,
        stopAll: () => positionMgr.stopAll(),
        getStates: getAllPositionBotStates,
        exit: () => srv.close(() => process.exit(0)),
      });
    const { waitingFor } = _heldStop.request();
    jsonResponse(res, 200, { ok: true, stopping: true, waitingFor });
  }

  async function _handlePositionDetails(req, res) {
    const body = await readJsonBody(req);
    if (!body.tokenId || !body.token0 || !body.token1 || !body.fee)
      return jsonResponse(res, 400, {
        ok: false,
        error: "Missing tokenId, token0, token1, or fee",
      });
    log.info(
      "[server] Position selected: NFT #%s %s",
      body.tokenId,
      emojiId(String(body.tokenId)),
    );
    try {
      const prov = sendTx.getManagedReadProvider();
      body.walletAddress =
        body.walletAddress || walletManager.getAddress() || "";
      body.contractAddress = body.contractAddress || config.POSITION_MANAGER;
      jsonResponse(
        res,
        200,
        await computeQuickDetails(
          prov,
          ethers,
          body,
          diskConfig,
          privateKeyRef.current,
        ),
      );
    } catch (err) {
      log.error("[server] Position details error:", err.message);
      jsonResponse(res, 500, {
        ok: false,
        error: err.message,
      });
    }
  }

  /** Sync lifetime result into the position's bot state for poll access. */
  function _syncLifetimeState(pk, result) {
    if (!pk) return;
    const states = getAllPositionBotStates();
    const s = states.get(pk) || {};
    // For managed positions the bot loop owns the sync flag — setting it
    // here would cause a "Done Syncing" → "Syncing…" flash when the bot's
    // own scan starts moments later.
    const isManaged = diskConfig.positions[pk]?.status === "running";
    if (!isManaged) s.rebalanceScanComplete = true;
    /*-
     *  The snapshot belongs to the bot on a managed position, and this
     *  route can still be asked about one: the dashboard suppresses its
     *  fetch only once a poll has landed, so a page load fires it before
     *  the first poll. What this route builds covers what an UNMANAGED
     *  position shows — the Current panel's two figures — and writing it
     *  over the bot's would drop the Lifetime panel's figures until the
     *  next poll rebuilt them, which is one `CHECK_INTERVAL_SEC` away.
     */
    const snapshot = result.pnlSnapshot;
    if (!isManaged && snapshot !== undefined && snapshot !== null)
      s.pnlSnapshot = snapshot;
    if (result.entryValue) s.entryValue = result.entryValue;
    const bl = diskConfig.positions[pk]?.hodlBaseline;
    if (bl) s.hodlBaseline = bl;
    if (!states.has(pk)) states.set(pk, s);
    /*- Note: `lifetimeScanComplete` is intentionally NOT set here.
     *  Unmanaged positions don't render a Lifetime panel (the placeholder
     *  "Click Manage to get reporting of Lifetime values." takes its
     *  place), so the flag is structurally irrelevant on their state.
     *  The dashboard's `_syncStatus` gates on the flag only when the
     *  active position is managed. */
    const _sn = s.pnlSnapshot;
    log.info(
      "[server] _syncLifetimeState %s: curFees=%s gas=%s comp=%s residual=%s entry=%s bl=%s",
      pk.split("-").pop(),
      _sn?.currentFeesUsd,
      _sn?.totalGas,
      _sn?.totalCompoundedUsd,
      _sn?.residualValueUsd,
      s.entryValue || "none",
      !!s.hodlBaseline,
    );
  }

  async function _handlePositionLifetime(req, res) {
    const body = await readJsonBody(req);
    if (!body.tokenId || !body.token0 || !body.token1 || !body.fee)
      return jsonResponse(res, 400, {
        ok: false,
        error: "Missing fields",
      });
    try {
      // Trigger lazy rebalance history scan
      // for managed positions (fire-and-forget)
      for (const [, bs] of getAllPositionBotStates()) {
        const ap = bs.activePosition;
        if (
          ap &&
          String(ap.tokenId) === String(body.tokenId) &&
          bs._triggerScan
        ) {
          bs._triggerScan();
          break;
        }
      }
      const prov = sendTx.getManagedReadProvider();
      body.walletAddress =
        body.walletAddress || walletManager.getAddress() || "";
      body.contractAddress = body.contractAddress || config.POSITION_MANAGER;
      const result = await computeLifetimeDetails(
        prov,
        ethers,
        body,
        diskConfig,
      );
      // Mark scan complete in the position's server state so the poll
      // cycle reports it — same path as managed positions.  This is the
      // ONLY way the dashboard detects "Synced" (no separate client flag).
      const pk = compositeKey(
        config.CHAIN_NAME,
        body.walletAddress,
        body.contractAddress,
        body.tokenId,
      );
      /*- Resolve to the LIVE composite key.  computeLifetimeDetails
       *  awaits multi-second on-chain event scans; during that window
       *  a parallel rebalance can migrate the key, leaving the stale
       *  `pk` pointing at a dead tokenId.  _syncLifetimeState would
       *  then create or update a phantom bot-state entry under that
       *  stale key (because `if (!states.has(pk)) states.set(pk, s)`
       *  inside it creates the entry on first access). */
      const livePk = resolveLiveKey(positionMgr, pk, (k) =>
        getAllPositionBotStates().get(k),
      );
      _syncLifetimeState(livePk, result);
      jsonResponse(res, 200, result);
    } catch (err) {
      log.error("[server] Lifetime details error:", err.message);
      jsonResponse(res, 500, {
        ok: false,
        error: err.message,
      });
    }
  }

  let _starting = false;

  /**
   * Resolve the private key and auto-start all
   * managed positions from v2 config.
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
        password =
          process.env.WALLET_PASSWORD ||
          (askPassword &&
            (await askPassword("[server] Enter wallet password: ")));
        if (password) {
          pk = (await walletManager.revealWallet(password)).privateKey;
          const via = process.env.WALLET_PASSWORD
            ? "WALLET_PASSWORD"
            : "terminal";
          log.info("[server] Wallet unlocked via %s", via);
        }
      }

      if (!pk) {
        if (askPassword) {
          // --headless: CLI is the only path — don't suggest the dashboard.
          if (walletManager.hasWallet())
            log.error(
              "[server] Wallet locked — password not" +
                " provided. Set WALLET_PASSWORD in .env" +
                " or re-run with --headless to be prompted.",
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
      privateKeyRef.current = pk;
      if (password) {
        _sessionPassword = password;
        _decryptApiKeys(password).catch(() => {});
      } else {
        log.info(
          "[server] Wallet key loaded without password — encrypted Telegram/Moralis keys (if any) will NOT be decrypted this session. Unlock via dashboard to enable notifications.",
        );
      }
      await _autoStartManagedPositions();
    } finally {
      _starting = false;
    }
  }

  /**
   * Start bot loops for all managed positions with status 'running'.
   * Delegated to `./server-auto-start` so this file stays under max-lines.
   */
  const _autoStartManagedPositions = createAutoStartManagedPositions({
    diskConfig,
    positionMgr,
    privateKeyRef,
    walletManager,
    getAllPositionBotStates,
    createPerPositionBotState,
    attachMultiPosDeps,
    updatePositionState,
    readConfigValue,
  });

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

  /** Route wrapper — delegates to server-moralis.js. */
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
    _resolveTokenSymbol: scanHandlers.resolveTokenSymbol,
    _handlePositionsScan: scanHandlers._handlePositionsScan,
    _handlePositionsRefresh: scanHandlers._handlePositionsRefresh,
    getPositionScanStatus: () => ({
      status: _globalScanStatus,
      progress: _globalScanProgress,
    }),
    _handleStopWhenAllClear,
    _handlePositionDetails,
    _handlePositionLifetime,
    _handlePositionScanCancel: scanHandlers._handlePositionScanCancel,
    _handlePositionReload,
    _handleRescanPrices,
    _tryResolveKey,
    _autoStartManagedPositions,
    _handleApiKeySave,
    _handleApiKeyStatus,
    _decryptApiKeys,
    _tgHandlers,
  };
}

module.exports = { createRouteHandlers };
