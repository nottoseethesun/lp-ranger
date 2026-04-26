/**
 * @file src/server-routes.js
 * @description
 * Route handler functions extracted from server.js.
 * Exported as `createRouteHandlers(deps)` factory.
 */

"use strict";

const ethers = require("ethers");
const config = require("./config");
const {
  saveEncryptedKey,
  loadEncryptedKey,
  hasEncryptedKey,
} = require("./api-key-store");
const { setApiKey } = require("./api-key-holder");
const {
  pingMoralis,
  validateMoralisKey,
  handleApiKeyStatus,
} = require("./server-moralis");
const { createTelegramHandlers } = require("./server-telegram");
const {
  getPositionConfig,
  saveConfig,
  compositeKey,
  parseCompositeKey,
  readConfigValue,
  GLOBAL_KEYS,
  POSITION_KEYS,
} = require("./bot-config-v2");
// position-detector used via server-scan.js
const { createScanHandlers } = require("./server-scan");
const { createAutoStartManagedPositions } = require("./server-auto-start");
const {
  computeQuickDetails: _defaultComputeQuickDetails,
  computeLifetimeDetails: _defaultComputeLifetimeDetails,
} = require("./position-details");
const { emojiId } = require("./logger");
const { fetchTokenPriceUsd } = require("./price-fetcher");

/** Recompute gas at current native token price for unmanaged results. */
async function _recomputeGasUsd(result) {
  if (!result.totalGasNative) return;
  try {
    const p = await fetchTokenPriceUsd(config.CHAIN.nativeWrappedToken);
    result.ltGas = result.totalGasNative * p;
    if (result.dailyPnl)
      for (const d of result.dailyPnl)
        if (d.gasNative > 0) d.gasCost = d.gasNative * p;
  } catch {
    /* keep historical USD */
  }
}

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
    /*- position-details functions are overridable from tests so we
     *  don't exercise a real RPC in unit tests. */
    computeQuickDetails = _defaultComputeQuickDetails,
    computeLifetimeDetails = _defaultComputeLifetimeDetails,
  } = deps;

  /** Cached wallet password for API key encryption (set on unlock). */
  let _sessionPassword = null;

  async function _handleApiConfig(req, res) {
    const body = await readJsonBody(req);
    const gPatch = {},
      pPatch = {};
    for (const k of GLOBAL_KEYS) if (body[k] !== undefined) gPatch[k] = body[k];
    for (const k of POSITION_KEYS)
      if (body[k] !== undefined) pPatch[k] = body[k];
    Object.assign(diskConfig.global, gPatch);
    const hasPosKeys = Object.keys(pPatch).length > 0;
    if (hasPosKeys) {
      const parsed = parseCompositeKey(body.positionKey);
      if (!parsed) {
        jsonResponse(res, 400, {
          ok: false,
          error:
            "positionKey required for position" +
            "-specific config (blockchain-wallet" +
            "-contract-tokenId)",
        });
        return;
      }
      const posRef = getPositionConfig(diskConfig, body.positionKey);
      const statusBefore = posRef.status;
      Object.assign(posRef, pPatch);
      if (statusBefore && !posRef.status)
        console.warn(
          "[api/config] status WIPED for %s! pPatch keys: %s",
          body.positionKey.slice(-10),
          Object.keys(pPatch).join(", "),
        );
      if (pPatch.offsetToken0Pct !== undefined)
        console.log(
          "[offset-trace] POST /api/config key=%s offsetToken0Pct=%d",
          body.positionKey.slice(-10),
          pPatch.offsetToken0Pct,
        );
    }
    saveConfig(diskConfig);
    if (pPatch.slippagePct !== undefined) {
      for (const [, s] of getAllPositionBotStates())
        if (s.rebalancePaused) {
          s.rebalancePaused = false;
          s.rebalanceError = null;
        }
    }
    jsonResponse(res, 200, {
      ok: true,
      applied: { ...gPatch, ...pPatch },
    });
  }

  async function _handleWalletImport(req, res) {
    const body = await readJsonBody(req);
    console.log(
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
    jsonResponse(res, 200, {
      ok: true,
      address: body.address,
    });
    try {
      privateKeyRef.current = (
        await walletManager.revealWallet(body.password)
      ).privateKey;
      console.log("[bot] Loading key from imported wallet");
      _decryptApiKeys(body.password).catch(() => {});
      await _autoStartManagedPositions();
    } catch (err) {
      console.warn("[server] Key resolution after import:", err.message);
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
    getGlobalScanStatus: () => ({
      status: _globalScanStatus,
      progress: _globalScanProgress,
    }),
    setGlobalScanStatus: (s, p) => {
      _globalScanStatus = s;
      _globalScanProgress = p || null;
    },
  });

  async function _handleShutdown(_req, res, srv) {
    jsonResponse(res, 200, {
      ok: true,
      message: "Shutting down\u2026",
    });
    console.log("[server] Shutdown requested via API");
    await positionMgr.stopAll();
    srv.close(() => process.exit(0));
  }

  async function _handlePositionDetails(req, res) {
    const body = await readJsonBody(req);
    if (!body.tokenId || !body.token0 || !body.token1 || !body.fee)
      return jsonResponse(res, 400, {
        ok: false,
        error: "Missing tokenId, token0, token1, or fee",
      });
    console.log(
      "[server] Position selected: NFT #%s %s",
      body.tokenId,
      emojiId(String(body.tokenId)),
    );
    try {
      const prov = new ethers.JsonRpcProvider(config.RPC_URL);
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
      console.error("[server] Position details error:", err.message);
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
    // pnlSnapshot is already enriched by computeLifetimeDetails with
    // currentValue, lifetimeIL, totalCompoundedUsd, initialDeposit.
    if (result.pnlSnapshot) s.pnlSnapshot = result.pnlSnapshot;
    if (result.entryValue) s.entryValue = result.entryValue;
    const bl = diskConfig.positions[pk]?.hodlBaseline;
    if (bl) s.hodlBaseline = bl;
    if (!states.has(pk)) states.set(pk, s);
    const _sn = s.pnlSnapshot;
    console.log(
      "[server] _syncLifetimeState %s: fees=%s gas=%s comp=%s entry=%s bl=%s",
      pk.split("-").pop(),
      _sn?.totalFees,
      _sn?.totalGas,
      _sn?.totalCompoundedUsd,
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
      const prov = new ethers.JsonRpcProvider(config.RPC_URL);
      body.walletAddress =
        body.walletAddress || walletManager.getAddress() || "";
      body.contractAddress = body.contractAddress || config.POSITION_MANAGER;
      const result = await computeLifetimeDetails(
        prov,
        ethers,
        body,
        diskConfig,
      );
      await _recomputeGasUsd(result);
      // Mark scan complete in the position's server state so the poll
      // cycle reports it — same path as managed positions.  This is the
      // ONLY way the dashboard detects "Synced" (no separate client flag).
      const pk = compositeKey(
        config.CHAIN_NAME,
        body.walletAddress,
        body.contractAddress,
        body.tokenId,
      );
      _syncLifetimeState(pk, result);
      jsonResponse(res, 200, result);
    } catch (err) {
      console.error("[server] Lifetime details error:", err.message);
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
      console.log("[server] Start already in progress" + " — skipping");
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
          console.log("[server] Wallet unlocked via %s", via);
        }
      }

      if (!pk) {
        if (askPassword) {
          // --headless: CLI is the only path — don't suggest the dashboard.
          if (walletManager.hasWallet())
            console.error(
              "[server] Wallet locked — password not" +
                " provided. Set WALLET_PASSWORD in .env" +
                " or re-run with --headless to be prompted.",
            );
          else
            console.error(
              "[server] No wallet imported. Run" +
                " `node scripts/import-wallet.js` first.",
            );
          process.exit(1);
        }
        if (walletManager.hasWallet())
          console.log(
            "[server] Wallet locked — unlock" + " via dashboard to start bot.",
          );
        else console.log("[server] No wallet key" + " — dashboard-only mode.");
        return;
      }
      privateKeyRef.current = pk;
      if (password) {
        _sessionPassword = password;
        _decryptApiKeys(password).catch(() => {});
      } else {
        console.log(
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
      console.log("[server] API key saved for %s — validating…", body.service);
      if (body.service === "moralis") {
        const status = await pingMoralis();
        console.log("[server] Moralis key post-save status: %s", status);
      }
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      console.error("[server] API key save error:", err.message);
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
        console.log("[server] Decrypted API key: %s", svc);
      } catch (err) {
        console.warn("[server] Failed to decrypt %s key: %s", svc, err.message);
      }
    }
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
    _handleShutdown,
    _handlePositionDetails,
    _handlePositionLifetime,
    _handlePositionScanCancel: scanHandlers._handlePositionScanCancel,
    _tryResolveKey,
    _autoStartManagedPositions,
    _handleApiKeySave,
    _handleApiKeyStatus,
    _decryptApiKeys,
    _tgHandlers,
  };
}

module.exports = { createRouteHandlers };
