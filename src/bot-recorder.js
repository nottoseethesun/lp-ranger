/**
 * @file src/bot-recorder.js
 * @module bot-recorder
 * @description
 * Logging, epoch closing, history scanning, rebalance recording,
 * and HODL baseline updates.
 * Extracted from bot-loop.js.
 */

"use strict";

// Loading any bot module signals the bot subsystem is active — bot-banner
// prints on first require (cached, so exactly once per process). Server.js
// pulls in bot-recorder unconditionally for managed + unmanaged data work,
// so this is where the bot announces itself in server mode.
require("./bot-banner");

const fs = require("fs");
const path = require("path");
const config = require("./config");
const rangeMath = require("./range-math");
const { getPoolState } = require("./rebalancer");
const { scanPoolHistory } = require("./pool-scanner");
const { reconstructEpochs } = require("./epoch-reconstructor");
const { clearLpPositionCache } = require("./lp-position-cache");
const _epochCache = require("./epoch-cache");
const { buildUpdatePatch } = require("./bot-recorder-patch");
const {
  collectTokenIds: _collectTokenIds,
} = require("./bot-recorder-scan-helpers");
const {
  toFloat: _toFloat,
  fetchTokenPrices: _fetchTokenPrices,
  estimateGasCostUsd: _estimateGasCostUsd,
  actualGasCostUsd: _actualGasCostUsd,
} = require("./bot-pnl-updater");
const { _scanLifetimePoolData } = require("./bot-recorder-lifetime");

/** JSON-safe replacer that converts BigInt to string. */
function _bigIntReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Read the on-disk rebalance log and return its entries.
 * Returns [] for missing, empty, or malformed files — callers should
 * treat "no seed available" the same as "no rebalances".
 * @returns {Array<object>}
 */
function readLog() {
  try {
    const raw = fs.readFileSync(path.resolve(config.LOG_FILE), "utf8");
    const entries = JSON.parse(raw);
    return Array.isArray(entries) ? entries : [];
  } catch (_) {
    return [];
  }
}

/**
 * Append a rebalance result to the on-disk JSON log.
 * Creates the file if it does not exist.
 * @param {object} result  The rebalance result object.
 */
function appendLog(result) {
  const logPath = path.resolve(config.LOG_FILE);
  let entries = [];
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    entries = JSON.parse(raw);
  } catch (_) {
    // File missing or corrupt — start fresh.
  }
  entries.push({ ...result, loggedAt: new Date().toISOString() });
  // Ensure parent dir exists (e.g. app-config/ on first run).
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(entries, _bigIntReplacer, 2));
}

/**
 * After an epoch close, credit unclaimed fees that were re-deposited via
 * the rebalance flow (drain → swap → mint).  These were already in the
 * NFT and would otherwise be invisible to `totalCompoundedUsd` (only
 * standalone compounds bump it via bot-cycle-compound).  See the Lifetime
 * "Fees Compounded" info dialog for the user-facing explanation.
 */
function _bumpRebalanceFees(deps) {
  if (!deps._addCollectedFees || !deps._lastUnclaimedFeesUsd) return;
  const rebalanceFeesUsd = deps._lastUnclaimedFeesUsd;
  deps._addCollectedFees(rebalanceFeesUsd);
  const gc = deps._getConfig;
  const prevCompounded =
    (gc && gc("totalCompoundedUsd")) || deps._botState?.totalCompoundedUsd || 0;
  const newCompounded = prevCompounded + rebalanceFeesUsd;
  if (deps.updateBotState)
    deps.updateBotState({ totalCompoundedUsd: newCompounded });
  console.log(
    "[bot] Rebalance compound: $%s fees re-deposited (lifetime $%s)",
    rebalanceFeesUsd.toFixed(2),
    newCompounded.toFixed(2),
  );
  deps._lastUnclaimedFeesUsd = 0;
}

/** Close the current P&L epoch after a rebalance and open a new one. */
async function _closePnlEpoch(deps, result) {
  const tracker = deps._pnlTracker;
  if (!tracker || tracker.epochCount() === 0) return;
  try {
    let price0 = result.token0UsdPrice,
      price1 = result.token1UsdPrice;
    if (price0 === undefined || price1 === undefined) {
      const p = await _fetchTokenPrices(
        deps.position.token0,
        deps.position.token1,
      );
      price0 = p.price0;
      price1 = p.price1;
    }
    const rd0 = result.decimals0 ?? 18,
      rd1 = result.decimals1 ?? 18;
    const exitVal =
      result.exitValueUsd ||
      _toFloat(result.amount0Collected, rd0) * price0 +
        _toFloat(result.amount1Collected, rd1) * price1;
    const gasCost = result.totalGasCostWei
      ? await _actualGasCostUsd(result.totalGasCostWei)
      : await _estimateGasCostUsd(deps.provider);
    const gasNative = result.totalGasCostWei
      ? Number(BigInt(result.totalGasCostWei)) / 1e18
      : 0;
    tracker.closeEpoch({
      exitValue: exitVal,
      gasCost,
      gasNative,
      token0UsdPrice: price0,
      token1UsdPrice: price1,
    });
    if (deps.updateBotState)
      deps.updateBotState({ pnlEpochs: tracker.serialize() });
    _bumpRebalanceFees(deps);
    const entryVal =
      result.entryValueUsd ||
      _toFloat(result.amount0Minted, rd0) * price0 +
        _toFloat(result.amount1Minted, rd1) * price1;
    tracker.openEpoch({
      entryValue: entryVal || exitVal,
      entryPrice: result.currentPrice,
      lowerPrice: rangeMath.tickToPrice(result.newTickLower, rd0, rd1),
      upperPrice: rangeMath.tickToPrice(result.newTickUpper, rd0, rd1),
      token0UsdPrice: price0,
      token1UsdPrice: price1,
    });
  } catch (err) {
    console.warn("[bot] P&L epoch close error:", err.message);
  }
}

/** Resolve pool address and scan on-chain rebalance history (fire-and-forget). */
async function _scanHistory(
  provider,
  ethersLib,
  address,
  position,
  events,
  updateState,
  throttle,
  computeFromHistoricalPrices,
) {
  try {
    updateState({
      rebalanceScanComplete: false,
      rebalanceScanProgress: 0,
    });
    const poolState = await getPoolState(provider, ethersLib, {
      factoryAddress: config.FACTORY,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
    });
    console.log(
      "[bot] Scanning rebalance history for %s (pool %s)",
      address,
      poolState.poolAddress,
    );
    updateState({ rebalanceScanProgress: 5 });
    const found = await scanPoolHistory(provider, ethersLib, {
      walletAddress: address,
      position,
      poolAddress: poolState.poolAddress || null,
      onPoolCreationProgress: (done, total) =>
        updateState({
          rebalanceScanProgress: 5 + Math.round((done / total) * 45),
        }),
      onProgress: (done, total) =>
        updateState({
          rebalanceScanProgress: 50 + Math.round((done / total) * 45),
        }),
      computeFromHistoricalPrices: computeFromHistoricalPrices || undefined,
    });
    updateState({ rebalanceScanProgress: 95 });
    /* Replace the in-memory events list with the (already deduped + merged)
     * scan result.  A plain push(...found) caused duplicate rows because
     * _triggerScan runs after every rebalance and the scan now includes the
     * event appendToPoolCache just wrote to the disk cache. */
    events.length = 0;
    events.push(...found);
    console.log("[bot] Found %d historical rebalance events", found.length);
    if (throttle && found.length > 0) {
      const cutoff = Math.floor(
        (throttle.getState().dailyResetAt - 86_400_000) / 1000,
      );
      const recent = found.filter((e) => e.timestamp >= cutoff).length;
      if (recent > 0) throttle.rehydrate(recent);
    }
    const _d = (ts) =>
      ts ? new Date(ts * 1000).toISOString().slice(0, 10) : undefined;
    const mintEv = found.find(
      (e) => String(e.newTokenId) === String(position.tokenId),
    );
    const mintTs = mintEv?.timestamp
      ? new Date(mintEv.timestamp * 1000).toISOString()
      : undefined;
    const mintDate = mintTs ? mintTs.slice(0, 10) : undefined,
      poolFirstMintDate = _d(found.firstMintTimestamp);
    if (mintDate)
      console.log(
        "[bot] Position #%s minted on %s",
        position.tokenId,
        mintDate,
      );
    if (poolFirstMintDate)
      console.log("[bot] Pool first LP minted on %s", poolFirstMintDate);
    const stPatch = {
      rebalanceEvents: [...events],
      rebalanceScanProgress: 100,
    };
    if (mintDate) {
      stPatch.positionMintDate = mintDate;
      stPatch.positionMintTimestamp = mintTs;
    }
    if (poolFirstMintDate) stPatch.poolFirstMintDate = poolFirstMintDate;
    if (throttle) stPatch.throttleState = throttle.getState();
    updateState(stPatch);
  } catch (err) {
    console.warn("[bot] Event scan error:", err.message);
    updateState({ rebalanceScanComplete: true });
  }
}

/** Scan history and reconstruct P&L epochs under the pool lock. */
async function _scanAndReconstruct(
  provider,
  ethersLib,
  address,
  position,
  _cache,
  events,
  updateState,
  throttle,
  pnlTracker,
  botState,
  epochKey,
) {
  await _scanHistory(
    provider,
    ethersLib,
    address,
    position,
    events,
    updateState,
    throttle,
    async (scannedEvents) => {
      const evts = scannedEvents || events;
      if (!evts.length) return;
      console.log("[bot] Reconstructing epochs (%d events)\u2026", evts.length);
      const fb = await _fetchTokenPrices(
        position.token0,
        position.token1,
      ).catch(() => ({ price0: 0, price1: 0 }));
      await reconstructEpochs({
        pnlTracker,
        rebalanceEvents: evts,
        botState,
        updateBotState: updateState,
        fallbackPrices: fb,
      }).catch((e) =>
        console.warn("[pnl] Epoch reconstruction error:", e.message),
      );
    },
  );
  await _scanLifetimePoolData(
    position,
    botState,
    updateState,
    events,
    address,
    pnlTracker,
    epochKey,
  );
  console.log("[bot] Scan + epoch reconstruction complete");
  updateState({
    rebalanceScanComplete: true,
    rebalanceScanProgress: 100,
  });
}

/** Record residual delta and persist. */
function _recordResidual(deps, result) {
  if (!deps._residualTracker || !result.poolAddress) return;
  deps._residualTracker.addDelta(
    result.poolAddress,
    result.amount0Collected - result.amount0Minted,
    result.amount1Collected - result.amount1Minted,
  );
  if (deps.updateBotState)
    deps.updateBotState({
      residuals: deps._residualTracker.serialize(),
    });
}

function _activePosSummary(p) {
  return {
    tokenId: String(p.tokenId),
    token0: p.token0,
    token1: p.token1,
    fee: p.fee,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidity: String(p.liquidity || 0),
    /*- Symbols are included so the dashboard can keep its posStore
     *  entry's `token0Symbol` / `token1Symbol` in sync after a
     *  rebalance-follow migration.  Without these, the entry's
     *  addresses/fee can drift to a new pool while the stale Maximus-
     *  era symbols persist forever in localStorage, producing the
     *  "tokenId correct, pool name wrong" mixed-state render bug. */
    token0Symbol: p.token0Symbol,
    token1Symbol: p.token1Symbol,
  };
}

function _notifyRebalance(deps, throttle, position, events) {
  /*- `lastRebalanceAt` is a ms-since-epoch number (matches what
   *  `bot-cycle-residual._updateCleanupState` writes and what callers
   *  compare against `Date.now()`).  Previously this wrote an ISO
   *  string via `Object.assign` which stomped the numeric value and
   *  produced NaN arithmetic in the residual-cleanup cooldown gate. */
  deps.updateBotState({
    rebalanceCount: (deps._rebalanceCount || 0) + 1,
    lastRebalanceAt: Date.now(),
    throttleState: throttle.getState(),
    rebalanceEvents: events ? [...events] : undefined,
    activePosition: _activePosSummary(position),
    activePositionId: String(position.tokenId),
  });
}

/** Update HODL baseline from rebalance result. */
function _updateHodlBaseline(botState, result, mintNow) {
  const d0 = result.decimals0 ?? 18,
    d1 = result.decimals1 ?? 18;
  const a0 = _toFloat(result.amount0Minted, d0),
    a1 = _toFloat(result.amount1Minted, d1),
    p0 = result.token0UsdPrice || 0,
    p1 = result.token1UsdPrice || 0;
  /*- mintNow is an ISO string (used elsewhere as a position-mint label).
      Canonical hodlBaseline.mintTimestamp is Unix seconds, so convert
      here.  See public/dashboard-date-utils.js#toMintTsSeconds. */
  const mintTs = Math.floor(new Date(mintNow).getTime() / 1000);
  botState.hodlBaseline = {
    mintDate: mintNow.slice(0, 10),
    mintTimestamp: mintTs,
    entryValue: a0 * p0 + a1 * p1,
    hodlAmount0: a0,
    hodlAmount1: a1,
    token0UsdPrice: p0,
    token1UsdPrice: p1,
    // Preserve mint gas from the rebalance result so _applyMintGas can
    // add it to the new epoch.  Without this, the gas field shows "—".
    mintGasWei: result.mintGasCostWei ? String(result.mintGasCostWei) : "0",
  };
}

/** Update in-memory position + events after a successful rebalance. */
/** Append a rebalance event to the in-memory event list. */
function _pushRebalanceEvent(events, result) {
  if (!events) return;
  const ts = Math.floor(Date.now() / 1000);
  events.push({
    index: events.length + 1,
    timestamp: ts,
    dateStr: new Date(ts * 1000).toISOString(),
    oldTokenId: String(result.oldTokenId || "?"),
    newTokenId: String(result.newTokenId || "?"),
    txHash:
      (result.txHashes && result.txHashes[result.txHashes.length - 1]) || "",
    blockNumber: 0,
    swapSources: result.swapSources || "(no swap)",
    /*- Trigger is set in bot-cycle._executeAndRecord before rebalance
     *  runs; falls back to "out-of-range" for safety.  Historical
     *  chain-scanned events won't have a trigger field — consumers
     *  treat that as unknown/legacy. */
    trigger: result.trigger || "out-of-range",
  });
  console.log(
    "[route-trace] event pushed ss=%s trigger=%s",
    result.swapSources,
    result.trigger,
  );
}

function _applyRebalanceResult(deps, result) {
  const { position } = deps;
  if (result.newTokenId && result.newTokenId !== 0n)
    position.tokenId = String(result.newTokenId);
  position.tickLower = result.newTickLower;
  position.tickUpper = result.newTickUpper;
  if (result.liquidity !== undefined)
    position.liquidity = String(result.liquidity);
  _pushRebalanceEvent(deps._rebalanceEvents, result);
  const mintNow = new Date().toISOString();
  if (deps._botState) {
    deps._botState.oorSince = null;
    // Reset mint gas flag so the new position's mint gas gets applied
    deps._botState._mintGasApplied = false;
    /*- Clear cached HODL so re-scan picks up the new rebalance boundary.
     *  `lastNftScanBlock` MUST be reset too — otherwise the next scan uses
     *  the pre-rebalance max block as `fromBlock` and filters out every
     *  historical IncreaseLiquidity event, caching an empty hodl/deposits
     *  result and leaving `totalLifetimeDepositUsd` at 0.
     */
    deps._botState.lifetimeHodlAmounts = null;
    deps._botState.totalLifetimeDepositUsd = 0;
    deps._botState.depositUsedFallback = false;
    if (deps._pnlTracker?._epochKey) {
      _epochCache.setCachedLifetimeHodl(deps._pnlTracker._epochKey, null);
      _epochCache.setCachedFreshDeposits(deps._pnlTracker._epochKey, null);
      _epochCache.setLastNftScanBlock(deps._pnlTracker._epochKey, 0);
    }
    _updateHodlBaseline(deps._botState, result, mintNow);
  }
  console.log(
    "[bot] Post-rebalance: position.tokenId=%s",
    String(position.tokenId),
  );
  if (deps._botState?.walletAddress)
    clearLpPositionCache(deps._botState.walletAddress, {
      contract: config.POSITION_MANAGER,
    });
  if (!deps.updateBotState) return;
  const events = deps._rebalanceEvents;
  _notifyRebalance(deps, deps.throttle || deps._throttle, position, events);
  deps.updateBotState(buildUpdatePatch(deps, result, mintNow));
}

module.exports = {
  _bigIntReplacer,
  appendLog,
  readLog,
  _closePnlEpoch,
  _scanHistory,
  _scanAndReconstruct,
  _recordResidual,
  _activePosSummary,
  _notifyRebalance,
  _updateHodlBaseline,
  _applyRebalanceResult,
  _collectTokenIds,
  _pushRebalanceEvent,
};
