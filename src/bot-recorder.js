/**
 * @file src/bot-recorder.js
 * @module bot-recorder
 * @description
 * Logging, epoch closing, history scanning, rebalance recording,
 * and HODL baseline updates.
 * Extracted from bot-loop.js.
 */

"use strict";
const fs = require("fs");
const path = require("path");
const config = require("./config");
const rangeMath = require("./range-math");
const { getPoolState } = require("./rebalancer");
const { scanPoolHistory } = require("./pool-scanner");
const { reconstructEpochs } = require("./epoch-reconstructor");
const { clearLpPositionCache } = require("./lp-position-cache");
const _epochCache = require("./epoch-cache");
const {
  toFloat: _toFloat,
  fetchTokenPrices: _fetchTokenPrices,
  estimateGasCostUsd: _estimateGasCostUsd,
  actualGasCostUsd: _actualGasCostUsd,
} = require("./bot-pnl-updater");

/** JSON-safe replacer that converts BigInt to string. */
function _bigIntReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
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
    if (deps._addCollectedFees && deps._lastUnclaimedFeesUsd) {
      deps._addCollectedFees(deps._lastUnclaimedFeesUsd);
      deps._lastUnclaimedFeesUsd = 0;
    }
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

/** Add historical compound gas to the P&L tracker if available. */
async function _applyCompoundGas(totalGasWei, pnlTracker) {
  if (!totalGasWei || totalGasWei === 0n) return;
  if (!pnlTracker || pnlTracker.epochCount() === 0) return;
  const { actualGasCostUsd } = require("./bot-pnl-updater");
  const gasUsd = await actualGasCostUsd(totalGasWei);
  const gasNative = Number(totalGasWei) / 1e18;
  if (gasUsd > 0) pnlTracker.addGas(gasUsd, gasNative);
}

/** Classify compounds across all NFTs and persist results. */
async function _classifyAllCompounds(
  ids,
  allNftEvents,
  opts,
  updateState,
  pnlTracker,
) {
  const { classifyCompounds } = require("./compounder");
  const allCompounds = [];
  let totalUsd = 0;
  let totalCompoundGasWei = 0n;
  for (const tid of ids) {
    const r = await classifyCompounds(allNftEvents.get(tid), {
      ...opts,
      tokenId: tid,
    });
    for (const c of r.compounds) allCompounds.push({ ...c, tokenId: tid });
    totalUsd += r.totalCompoundedUsd;
    totalCompoundGasWei += BigInt(r.totalGasWei || "0");
  }
  console.log(
    "[bot] Lifetime compound scan: %d NFTs, %d compounds, $%s",
    ids.size,
    allCompounds.length,
    totalUsd.toFixed(2),
  );
  if (allCompounds.length > 0) {
    const history = allCompounds.map((c) => ({
      timestamp: null,
      txHash: null,
      tokenId: c.tokenId,
      amount0Deposited: c.amount0Deposited,
      amount1Deposited: c.amount1Deposited,
      usdValue: totalUsd / allCompounds.length,
      trigger: "historical",
    }));
    updateState({ compoundHistory: history, totalCompoundedUsd: totalUsd });
    await _applyCompoundGas(totalCompoundGasWei, pnlTracker);
  }
}

/** Collect all unique tokenIds from rebalance chain + current position. */
function _collectTokenIds(position, rebalanceEvents) {
  const ids = new Set([String(position.tokenId)]);
  for (const ev of rebalanceEvents || []) {
    if (ev.oldTokenId) ids.add(String(ev.oldTokenId));
    if (ev.newTokenId) ids.add(String(ev.newTokenId));
  }
  return ids;
}

/** Fetch NFT events for all tokenIds, track max block for incremental scan. */
async function _fetchAllNftEvents(ids, fromBlock) {
  const { scanNftEvents } = require("./compounder");
  const allNftEvents = new Map();
  let maxBlock = fromBlock;
  for (const tid of ids) {
    const ev = await scanNftEvents(tid, { fromBlock });
    allNftEvents.set(tid, ev);
    for (const e of [...ev.ilEvents, ...ev.collectEvents, ...ev.dlEvents]) {
      if (e.blockNumber > maxBlock) maxBlock = e.blockNumber;
    }
  }
  return { allNftEvents, maxBlock };
}

/**
 * Unified lifetime pool scan: fetch NFT events once per tokenId, then run
 * both compound classification and lifetime HODL accumulation.
 * Incremental: reads lastNftScanBlock from epoch cache, scans only new blocks.
 */
async function _scanLifetimePoolData(
  position,
  botState,
  updateState,
  rebalanceEvents,
  walletAddress,
  pnlTracker,
  epochKey,
) {
  const cachedHodl = epochKey
    ? _epochCache.getCachedLifetimeHodl(epochKey)
    : null;
  const gc = botState._getConfig
    ? botState._getConfig("compoundHistory")
    : undefined;
  const hasCompounds = gc?.length > 0;
  if (hasCompounds && cachedHodl) return;
  try {
    const { computeLifetimeHodl } = require("./lifetime-hodl");
    const fromBlock = epochKey ? _epochCache.getLastNftScanBlock(epochKey) : 0;
    const prices = await _fetchTokenPrices(
      position.token0,
      position.token1,
    ).catch(() => ({ price0: 0, price1: 0 }));
    const opts = {
      decimals0: position.decimals0,
      decimals1: position.decimals1,
      price0: prices.price0,
      price1: prices.price1,
      token0Symbol: position.token0Symbol || "Token0",
      token1Symbol: position.token1Symbol || "Token1",
      wallet: walletAddress,
    };
    const ids = _collectTokenIds(position, rebalanceEvents);
    const { allNftEvents, maxBlock } = await _fetchAllNftEvents(ids, fromBlock);
    if (!hasCompounds)
      await _classifyAllCompounds(
        ids,
        allNftEvents,
        opts,
        updateState,
        pnlTracker,
      );
    if (!cachedHodl) {
      const { computeAndCacheHodl } = require("./bot-hodl-scan");
      const hodl = await computeAndCacheHodl(
        computeLifetimeHodl,
        allNftEvents,
        rebalanceEvents,
        position,
        opts,
        walletAddress,
        epochKey,
      );
      botState.lifetimeHodlAmounts = hodl;
      updateState({ lifetimeHodlAmounts: hodl });
    } else {
      botState.lifetimeHodlAmounts = cachedHodl;
    }
    const { computeDepositUsd } = require("./bot-hodl-scan");
    await computeDepositUsd(botState, updateState, position, opts);
    if (epochKey && maxBlock > fromBlock)
      _epochCache.setLastNftScanBlock(epochKey, maxBlock);
  } catch (err) {
    console.warn("[bot] Lifetime pool scan failed:", err.message);
  }
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
  };
}

function _notifyRebalance(deps, throttle, position, events) {
  deps.updateBotState({
    rebalanceCount: (deps._rebalanceCount || 0) + 1,
    lastRebalanceAt: new Date().toISOString(),
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
  botState.hodlBaseline = {
    mintDate: mintNow.slice(0, 10),
    mintTimestamp: mintNow,
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
  });
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
    // Clear cached HODL so re-scan picks up the new rebalance boundary
    deps._botState.lifetimeHodlAmounts = null;
    deps._botState.totalLifetimeDepositUsd = 0;
    deps._botState.depositUsedFallback = false;
    if (deps._pnlTracker?._epochKey) {
      _epochCache.setCachedLifetimeHodl(deps._pnlTracker._epochKey, null);
      _epochCache.setCachedFreshDeposits(deps._pnlTracker._epochKey, null);
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
  const patch = {
    oorSince: null,
    positionMintDate: mintNow.slice(0, 10),
    positionMintTimestamp: mintNow,
    pnlSnapshot: null,
    // Push updated HODL baseline to dashboard + disk config so the deposit
    // value reflects the new NFT's actual minted amounts, not the old one's.
    hodlBaseline: deps._botState?.hodlBaseline || null,
  };
  if (
    result.requestedRangePct &&
    result.effectiveRangePct &&
    Math.abs(result.effectiveRangePct - result.requestedRangePct) > 0.01
  )
    patch.rangeRounded = {
      requested: result.requestedRangePct,
      effective: result.effectiveRangePct,
    };
  deps.updateBotState(patch);
}

module.exports = {
  _bigIntReplacer,
  appendLog,
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
  _applyCompoundGas,
};
