/**
 * @file src/server-auto-start.js
 * @description
 * Auto-start logic for managed positions on server boot. Initialises the
 * app-wide shared signer (one NonceManager for the wallet), then walks
 * managed positions and starts a bot loop for each one whose NFT is still
 * owned by the loaded wallet.
 *
 * Exported as `createAutoStartManagedPositions(deps)` factory.
 */

"use strict";

const ethers = require("ethers");
const config = require("./config");
const {
  getPositionConfig,
  saveConfig,
  managedKeys,
  removeManagedPosition,
} = require("./bot-config-v2");
const { startBotLoop } = require("./bot-loop");
const { createOnRetire } = require("./server-positions");

/**
 * Factory that returns `_autoStartManagedPositions`.
 *
 * @param {object} deps
 * @param {object} deps.diskConfig
 * @param {object} deps.positionMgr
 * @param {{ current: string|null }} deps.privateKeyRef
 * @param {object} deps.walletManager
 * @param {Function} deps.getAllPositionBotStates
 * @param {Function} deps.createPerPositionBotState
 * @param {Function} deps.attachMultiPosDeps
 * @param {Function} deps.updatePositionState
 * @param {Function} deps.readConfigValue
 * @returns {Function} Async function that auto-starts all running positions.
 */
function createAutoStartManagedPositions(deps) {
  const {
    diskConfig,
    positionMgr,
    privateKeyRef,
    walletManager,
    getAllPositionBotStates,
    createPerPositionBotState,
    attachMultiPosDeps,
    updatePositionState,
    readConfigValue,
  } = deps;

  /** Initialise the app-wide shared NonceManager signer (best-effort). */
  async function _initSharedSigner(eth) {
    if (!privateKeyRef.current && !config.DRY_RUN) return null;
    try {
      return await positionMgr.getSharedSigner({
        privateKey: privateKeyRef.current,
        ethersLib: eth,
        dryRun: config.DRY_RUN,
      });
    } catch (err) {
      console.warn(
        "[server] Shared signer init failed: %s —" +
          " positions will start without injected signer",
        err.message,
      );
      return null;
    }
  }

  /** Check NFT ownership before starting a bot loop for it. */
  async function _verifyOwnership(pmC, wAddr, tokenId, key) {
    if (!wAddr) return true;
    try {
      const own = await pmC.ownerOf(tokenId);
      if (own.toLowerCase() !== wAddr.toLowerCase()) {
        console.warn(
          "[server] NFT #%s not owned — removing from managed",
          tokenId,
        );
        removeManagedPosition(diskConfig, key);
        saveConfig(diskConfig);
        return false;
      }
      return true;
    } catch (_e) {
      console.warn(
        "[server] ownerOf #%s failed: %s — skipping (will retry next start)",
        tokenId,
        _e.message,
      );
      return false;
    }
  }

  /** Start a single bot loop for `key` using the shared signer. */
  async function _startOne(key, pc, shared) {
    const tokenId = key.split("-").pop();
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
            provider: shared?.provider,
            signer: shared?.signer,
            address: shared?.address,
            dryRun: config.DRY_RUN,
            eagerScan: false,
            updateBotState: (patch) =>
              updatePositionState(kRef, patch, diskConfig, positionMgr),
            botState: perPositionBotState,
            positionId: tokenId,
            getConfig: (k) => readConfigValue(diskConfig, kRef.current, k),
            getPositionCount: () => positionMgr.runningCount(),
            onRetire: createOnRetire({
              keyRef: kRef,
              diskConfig,
              positionMgr,
            }),
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
  }

  return async function _autoStartManagedPositions() {
    const keys = managedKeys(diskConfig);
    const cnt = keys.length;
    const stMs =
      cnt > 1 ? Math.floor((config.CHECK_INTERVAL_SEC * 1000) / cnt) : 0;
    const prov = new ethers.JsonRpcProvider(config.RPC_URL);
    const pmC = new ethers.Contract(
      config.POSITION_MANAGER,
      ["function ownerOf(uint256) view returns (address)"],
      prov,
    );
    const wAddr = walletManager.getAddress();
    const shared = await _initSharedSigner(ethers);
    let i = 0;
    for (const key of [...keys]) {
      const pc = getPositionConfig(diskConfig, key);
      if (i > 0 && stMs > 0) {
        console.log("[server] Stagger: %dms before %d/%d", stMs, i + 1, cnt);
        await new Promise((r) => setTimeout(r, stMs));
      }
      const tokenId = key.split("-").pop();
      const ok = await _verifyOwnership(pmC, wAddr, tokenId, key);
      if (!ok) {
        i++;
        continue;
      }
      await _startOne(key, pc, shared);
      i++;
    }
    console.log(
      "[server] Auto-started %d of %d positions",
      positionMgr.runningCount(),
      keys.length,
    );
  };
}

module.exports = { createAutoStartManagedPositions };
