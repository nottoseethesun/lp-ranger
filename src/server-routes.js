/**
 * @file src/server-routes.js
 * @description
 * Route handler functions extracted from server.js.
 * Exported as `createRouteHandlers(deps)` factory.
 */

"use strict";

const config = require("./config");
const {
  getPositionConfig,
  saveConfig,
  managedKeys,
  compositeKey,
  parseCompositeKey,
  readConfigValue,
  GLOBAL_KEYS,
  POSITION_KEYS,
} = require("./bot-config-v2");
// position-detector used via server-scan.js
const { startBotLoop, resolvePrivateKey } = require("./bot-loop");
const {
  computeQuickDetails,
  computeLifetimeDetails,
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
  } = deps;

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
  const { createScanHandlers } = require("./server-scan");
  let _globalScanStatus = "idle";
  let _globalScanProgress = null;
  const scanHandlers = createScanHandlers({
    walletManager,
    jsonResponse,
    readJsonBody,
    getGlobalScanStatus: () => ({
      status: _globalScanStatus,
      progress: _globalScanProgress,
    }),
    setGlobalScanStatus: (s, p) => {
      _globalScanStatus = s;
      _globalScanProgress = p || null;
    },
  });
  const _handlePositionsScan = scanHandlers._handlePositionsScan;
  const _handlePositionsRefresh = scanHandlers._handlePositionsRefresh;
  const _resolveTokenSymbol = scanHandlers.resolveTokenSymbol;

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
      const eth = require("ethers");
      const prov = new eth.JsonRpcProvider(config.RPC_URL);
      body.walletAddress =
        body.walletAddress || walletManager.getAddress() || "";
      body.contractAddress = body.contractAddress || config.POSITION_MANAGER;
      jsonResponse(
        res,
        200,
        await computeQuickDetails(
          prov,
          eth,
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
    s.rebalanceScanComplete = true;
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
      const eth = require("ethers");
      const prov = new eth.JsonRpcProvider(config.RPC_URL);
      body.walletAddress =
        body.walletAddress || walletManager.getAddress() || "";
      body.contractAddress = body.contractAddress || config.POSITION_MANAGER;
      const result = await computeLifetimeDetails(prov, eth, body, diskConfig);
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
      const pk = await resolvePrivateKey({
        askPassword: null,
      });
      if (!pk) {
        if (walletManager.hasWallet())
          console.log(
            "[server] Wallet locked — unlock" + " via dashboard to start bot.",
          );
        else console.log("[server] No wallet key" + " — dashboard-only mode.");
        return;
      }
      privateKeyRef.current = pk;
      await _autoStartManagedPositions();
    } finally {
      _starting = false;
    }
  }

  /**
   * Start bot loops for all managed positions
   * that have status 'running' in config.
   */
  async function _autoStartManagedPositions() {
    const keys = managedKeys(diskConfig);
    const cnt = keys.length;
    const stMs =
      cnt > 1 ? Math.floor((config.CHECK_INTERVAL_SEC * 1000) / cnt) : 0;
    const eth = require("ethers");
    const prov = new eth.JsonRpcProvider(config.RPC_URL);
    const pmC = new eth.Contract(
      config.POSITION_MANAGER,
      ["function ownerOf(uint256)" + " view returns (address)"],
      prov,
    );
    const wAddr = walletManager.getAddress();
    let i = 0;
    for (const key of [...keys]) {
      const pc = getPositionConfig(diskConfig, key);
      if (i > 0 && stMs > 0) {
        console.log("[server] Stagger: %dms before %d/%d", stMs, i + 1, cnt);
        await new Promise((r) => setTimeout(r, stMs));
      }
      const tokenId = key.split("-").pop();
      if (wAddr) {
        try {
          const own = await pmC.ownerOf(tokenId);
          if (own.toLowerCase() !== wAddr.toLowerCase()) {
            console.warn(
              "[server] NFT #%s not owned" + " — removing from managed",
              tokenId,
            );
            const { removeManagedPosition } = require("./bot-config-v2");
            removeManagedPosition(diskConfig, key);
            saveConfig(diskConfig);
            i++;
            continue;
          }
        } catch (_e) {
          console.warn(
            "[server] ownerOf #%s failed: %s" +
              " — skipping (will retry next start)",
            tokenId,
            _e.message,
          );
          i++;
          continue;
        }
      }
      const perPositionBotState = createPerPositionBotState(
        diskConfig.global,
        pc,
      );
      attachMultiPosDeps(perPositionBotState, positionMgr);
      getAllPositionBotStates().set(key, perPositionBotState);
      try {
        const kRef = { current: key };
        await positionMgr.startPosition(key, {
          tokenId,
          startLoop: () =>
            startBotLoop({
              privateKey: privateKeyRef.current,
              dryRun: config.DRY_RUN,
              eagerScan: false,
              updateBotState: (patch) =>
                updatePositionState(kRef, patch, diskConfig, positionMgr),
              botState: perPositionBotState,
              positionId: tokenId,
              getConfig: (k) => readConfigValue(diskConfig, kRef.current, k),
            }),
          savedConfig: pc,
        });
      } catch (err) {
        console.warn(
          "[server] Failed to auto-start %s: %s" +
            " — will retry when key is available",
          key,
          err.message,
        );
      }
      i++;
    }
    console.log(
      "[server] Auto-started %d of %d positions",
      positionMgr.runningCount(),
      keys.length,
    );
  }

  return {
    _handleApiConfig,
    _handleWalletImport,
    _handleWalletReveal,
    _resolveTokenSymbol,
    _handlePositionsScan,
    _handlePositionsRefresh,
    getPositionScanStatus: () => ({
      status: _globalScanStatus,
      progress: _globalScanProgress,
    }),
    _handleShutdown,
    _handlePositionDetails,
    _handlePositionLifetime,
    _tryResolveKey,
    _autoStartManagedPositions,
  };
}

module.exports = { createRouteHandlers };
