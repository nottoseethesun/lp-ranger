/**
 * @file src/bot-recorder-lifetime.js
 * @module bot-recorder-lifetime
 * @description
 * Lifetime pool scan: classify compounds + accumulate HODL across all
 * NFTs in the rebalance chain.  Extracted from bot-recorder.js for
 * line-count compliance.
 */

"use strict";

const config = require("./config");
const _epochCache = require("./epoch-cache");
const { fetchTokenPrices: _fetchTokenPrices } = require("./bot-pnl-updater");
const { classifyCompounds } = require("./compounder");
const { computeLifetimeHodl } = require("./lifetime-hodl");
const { computeAndCacheHodl, computeDepositUsd } = require("./bot-hodl-scan");
const {
  resolvePoolCreationBlockForPosition,
} = require("./pool-creation-block");
const {
  collectTokenIds: _collectTokenIds,
  fetchAllNftEvents: _fetchAllNftEvents,
} = require("./bot-recorder-scan-helpers");
const { actualGasCostUsd: _actualGasCostUsd } = require("./bot-pnl-updater");

/** Add historical compound gas to the P&L tracker if available. */
async function _applyCompoundGas(totalGasWei, pnlTracker) {
  if (!totalGasWei || totalGasWei === 0n) return;
  if (!pnlTracker || pnlTracker.epochCount() === 0) return;
  const gasUsd = await _actualGasCostUsd(totalGasWei);
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
  const d0 = opts.decimals0 ?? 8,
    d1 = opts.decimals1 ?? 8;
  const p0 = opts.price0 || 0,
    p1 = opts.price1 || 0;
  /*-
   *  Per-event USD for a standalone (auto/manual) compound — the event's
   *  own deposit value priced at current rates.  Used both for logging
   *  the standalone-only subtotal and for populating compoundHistory.
   */
  const _eventUsd = (c) =>
    (Number(c.amount0Deposited) / 10 ** d0) * p0 +
    (Number(c.amount1Deposited) / 10 ** d1) * p1;
  const standaloneUsd = allCompounds.reduce((s, c) => s + _eventUsd(c), 0);
  const rebalanceUsd = Math.max(0, totalUsd - standaloneUsd);
  console.log(
    "[bot] Lifetime compound scan: %d NFTs across rebalance chain",
    ids.size,
  );
  console.log(
    "[bot]   standalone (auto/manual): %d events totaling $%s",
    allCompounds.length,
    standaloneUsd.toFixed(2),
  );
  console.log(
    "[bot]   rebalance-driven re-deposits: $%s",
    rebalanceUsd.toFixed(2),
  );
  console.log("[bot]   combined lifetime compounded: $%s", totalUsd.toFixed(2));
  /*-
   *  Persist totalCompoundedUsd whenever it's > 0 even if there are no
   *  standalone compound events — a position that only ever rebalanced
   *  (no auto/manual compound) still has fees that were re-deposited
   *  via the rebalance flow.
   */
  if (totalUsd > 0) {
    const history = allCompounds.map((c) => ({
      /*-
       *  Block timestamp + tx hash come from _fetchCompoundGas in
       *  src/compounder.js.  Both can still be null if the receipt or
       *  block fetch failed — consumers must tolerate null.
       */
      timestamp: c.timestamp || null,
      txHash: c.txHash || null,
      tokenId: c.tokenId,
      amount0Deposited: c.amount0Deposited,
      amount1Deposited: c.amount1Deposited,
      /*-
       *  Per-event USD = the event's own deposit value. Previously this
       *  was an average of the lifetime total, which is now misleading
       *  because the total includes rebalance-time fees that don't
       *  correspond to any compound event in this list.
       */
      usdValue: _eventUsd(c),
      trigger: "historical",
    }));
    updateState({ compoundHistory: history, totalCompoundedUsd: totalUsd });
    await _applyCompoundGas(totalCompoundGasWei, pnlTracker);
  }
}

/**
 * Resolve whether disk already has authoritative compound data and whether
 * a cached lifetime-hodl exists for this epoch.  Extracted to keep
 * `_scanLifetimePoolData` under the cyclomatic-complexity cap.
 *
 * Disk is treated as source-of-truth for the lifetime compound total.
 * Either `compoundHistory` or `totalCompoundedUsd` is sufficient: the
 * bot's own scans populate both fields, but the unmanaged-view detail
 * scan (`position-details._scanCompounds`) persists only
 * `totalCompoundedUsd`.  Without this, a fresh `Manage Position` on a
 * previously-viewed position would re-run `_classifyAllCompounds` from
 * a stale `lastNftScanBlock`, get a partial sum, and stomp the correct
 * disk value.  Live compounds that fire while managed update the total
 * incrementally via `_recordCompound`, so no rescan is ever needed.
 */
function _resolveDiskState(botState, epochKey) {
  const cachedHodl = epochKey
    ? _epochCache.getCachedLifetimeHodl(epochKey)
    : null;
  const get = botState._getConfig;
  const gc = get ? get("compoundHistory") : undefined;
  const diskTotal = get ? get("totalCompoundedUsd") : undefined;
  const hasCompoundData = gc?.length > 0 || (diskTotal || 0) > 0;
  return { cachedHodl, hasCompoundData };
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
  const { cachedHodl, hasCompoundData } = _resolveDiskState(botState, epochKey);
  if (hasCompoundData && cachedHodl) return;
  try {
    const cachedFromBlock = epochKey
      ? _epochCache.getLastNftScanBlock(epochKey)
      : 0;
    /*-
     *  First-run lower bound: pool creation block.  Avoids replaying every
     *  chain block back to genesis when the epoch cache has nothing yet.
     */
    const fromBlock =
      cachedFromBlock > 0
        ? cachedFromBlock
        : await resolvePoolCreationBlockForPosition({
            factoryAddress: config.FACTORY,
            position,
          });
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
    if (!hasCompoundData)
      await _classifyAllCompounds(
        ids,
        allNftEvents,
        opts,
        updateState,
        pnlTracker,
      );
    if (!cachedHodl) {
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
    await computeDepositUsd(botState, updateState, position, opts, epochKey);
    if (epochKey && maxBlock > fromBlock)
      _epochCache.setLastNftScanBlock(epochKey, maxBlock);
  } catch (err) {
    console.warn("[bot] Lifetime pool scan failed:", err.message);
  }
}

module.exports = {
  _applyCompoundGas,
  _classifyAllCompounds,
  _scanLifetimePoolData,
};
