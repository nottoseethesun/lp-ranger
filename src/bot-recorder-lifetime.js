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
const { emojiId } = require("./logger");
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
  /*-
   *  Per-NFT total gas wei (mint + standalone compounds), keyed by tokenId.
   *  Drives the Managed Current-panel "Gas" row so it matches the Unmanaged
   *  on-chain scan for the same NFT.  Lifetime panel is untouched —
   *  `_applyCompoundGas` still feeds the tracker for the lifetime sum.
   */
  const nftGasWeiByTokenId = {};
  for (const tid of ids) {
    const r = await classifyCompounds(allNftEvents.get(tid), {
      ...opts,
      tokenId: tid,
    });
    for (const c of r.compounds) allCompounds.push({ ...c, tokenId: tid });
    totalUsd += r.totalCompoundedUsd;
    totalCompoundGasWei += BigInt(r.totalGasWei || "0");
    nftGasWeiByTokenId[String(tid)] = String(r.totalNftGasWei || "0");
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
    updateState({
      compoundHistory: history,
      totalCompoundedUsd: totalUsd,
      nftGasWeiByTokenId,
    });
    await _applyCompoundGas(totalCompoundGasWei, pnlTracker);
  } else {
    /*-
     *  No standalone compounds, but the per-NFT mint-gas figures we just
     *  scanned still drive the Current-panel "Gas" row.  Persist them
     *  even when totalUsd is zero so a never-compounded NFT still shows
     *  the matching Unmanaged gas figure.
     */
    if (Object.keys(nftGasWeiByTokenId).length > 0)
      updateState({ nftGasWeiByTokenId });
  }
}

/**
 * Resolve which lifetime aggregates already have authoritative values on
 * disk and whether a cached lifetime-hodl exists for this epoch.
 * Extracted to keep `_scanLifetimePoolData` under the cyclomatic-complexity
 * cap.
 *
 * Disk is treated as source-of-truth for two independent lifetime totals,
 * each guarded against stomp by a stale-`lastNftScanBlock` partial scan:
 *
 *   1. **Compound total** (`hasCompoundData`).  Either `compoundHistory`
 *      or `totalCompoundedUsd` is sufficient: the bot's own scans
 *      populate both, but the unmanaged-view detail scan
 *      (`position-details._scanCompounds`) persists only
 *      `totalCompoundedUsd`.  Without this guard, a fresh
 *      `Manage Position` on a previously-viewed position would re-run
 *      `_classifyAllCompounds` from a stale `lastNftScanBlock`, get a
 *      partial sum, and stomp the correct disk value.  Live compounds
 *      that fire while managed update the total incrementally via
 *      `_recordCompound`, so no rescan is ever needed.
 *
 *   2. **Lifetime deposit** (`hasDepositData`).  A non-zero
 *      `totalLifetimeDepositUsd` on disk means a previous run already
 *      summed every `IncreaseLiquidity` event across the rebalance
 *      chain into a USD total.  An incremental rescan from a stale
 *      `lastNftScanBlock` only sees a subset of those events, summing
 *      to a smaller (wrong) total — which `computeDepositUsd` would
 *      then write back, overwriting the correct value.  When this flag
 *      is true we leave the disk total alone and let the dashboard
 *      keep rendering it.  New deposits while managed flow through the
 *      live mint/rebalance path and update the total incrementally,
 *      so no rescan is ever needed.
 */
function _resolveDiskState(botState, epochKey) {
  const cachedHodl = epochKey
    ? _epochCache.getCachedLifetimeHodl(epochKey)
    : null;
  const get = botState._getConfig;
  const gc = get ? get("compoundHistory") : undefined;
  const diskTotal = get ? get("totalCompoundedUsd") : undefined;
  const diskDeposit = get ? get("totalLifetimeDepositUsd") : undefined;
  const hasCompoundData = gc?.length > 0 || (diskTotal || 0) > 0;
  const hasDepositData = (diskDeposit || 0) > 0;
  return { cachedHodl, hasCompoundData, hasDepositData };
}

/**
 * Unified lifetime pool scan: fetch NFT events once per tokenId, then run
 * both compound classification and lifetime HODL accumulation.
 * Incremental: reads lastNftScanBlock from epoch cache, scans only new blocks.
 */
/** Build a logging-context bundle (symbols + tokenId + emoji) for the scan. */
function _scanLogCtx(position) {
  const tokenIdStr = String(position.tokenId || "");
  return {
    t0Sym: position.token0Symbol || "Token0",
    t1Sym: position.token1Symbol || "Token1",
    tokenIdStr,
    tokenEmoji: emojiId(tokenIdStr),
  };
}

/** Persist scan-success state on the bot and through the update channel. */
function _recordScanSuccess(botState, updateState, ctx) {
  if (botState) {
    botState._needsFullRescan = false;
    botState._lifetimeScanError = null;
    botState._lifetimeScanErrorAt = null;
    updateState({
      _needsFullRescan: false,
      _lifetimeScanError: null,
      _lifetimeScanErrorAt: null,
    });
  }
  console.log(
    "[bot] %s/%s NFT #%s %s: Lifetime scan complete",
    ctx.t0Sym,
    ctx.t1Sym,
    ctx.tokenIdStr,
    ctx.tokenEmoji,
  );
}

/** Resolve the starting block for the event scan, honoring the rescan flag. */
async function _resolveScanFromBlock(epochKey, fullRescan, position) {
  const cachedFromBlock =
    epochKey && !fullRescan ? _epochCache.getLastNftScanBlock(epochKey) : 0;
  if (cachedFromBlock > 0) return cachedFromBlock;
  return resolvePoolCreationBlockForPosition({
    factoryAddress: config.FACTORY,
    position,
  });
}

/** Persist scan-failure state so the 30-min auto-rescan can see the gap. */
function _recordScanFailure(botState, updateState, err, ctx) {
  if (botState) {
    botState._lifetimeScanError = err.message;
    botState._lifetimeScanErrorAt = Date.now();
    updateState({
      _lifetimeScanError: err.message,
      _lifetimeScanErrorAt: botState._lifetimeScanErrorAt,
    });
  }
  console.warn(
    "[bot] %s/%s NFT #%s %s: Lifetime pool scan failed: %s",
    ctx.t0Sym,
    ctx.t1Sym,
    ctx.tokenIdStr,
    ctx.tokenEmoji,
    err.message,
  );
}

async function _scanLifetimePoolData(
  position,
  botState,
  updateState,
  rebalanceEvents,
  walletAddress,
  pnlTracker,
  epochKey,
) {
  const ctx = _scanLogCtx(position);
  const fullRescan = !!botState?._needsFullRescan;
  const { cachedHodl, hasCompoundData, hasDepositData } = _resolveDiskState(
    botState,
    epochKey,
  );
  /*- The rebalance path sets `_needsFullRescan` to force re-classification
   *  of every IncreaseLiquidity event in the (now-extended) chain. Bypass
   *  the early-return so we don't skip the scan just because the prior
   *  totals are still cached. */
  if (!fullRescan && hasCompoundData && cachedHodl && hasDepositData) return;
  console.log(
    "[bot] %s/%s NFT #%s %s: Starting lifetime scan (fullRescan=%s)",
    ctx.t0Sym,
    ctx.t1Sym,
    ctx.tokenIdStr,
    ctx.tokenEmoji,
    fullRescan,
  );
  try {
    /*- When `_needsFullRescan` is set we treat the cache as untrusted and
     *  start the event scan from the pool creation block. Otherwise we
     *  resume incrementally from the last scanned block. */
    const fromBlock = await _resolveScanFromBlock(
      epochKey,
      fullRescan,
      position,
    );
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
    /*-
     *  Skip the deposit recompute when disk already has a non-zero total
     *  (see `_resolveDiskState` JSDoc, item 2).  An incremental scan from
     *  a stale `lastNftScanBlock` would otherwise overwrite the correct
     *  total with a partial sum.
     */
    if (!hasDepositData || fullRescan)
      await computeDepositUsd(botState, updateState, position, opts, epochKey);
    if (epochKey && maxBlock > fromBlock)
      _epochCache.setLastNftScanBlock(epochKey, maxBlock);
    _recordScanSuccess(botState, updateState, ctx);
  } catch (err) {
    _recordScanFailure(botState, updateState, err, ctx);
  }
}

module.exports = {
  _applyCompoundGas,
  _classifyAllCompounds,
  _scanLifetimePoolData,
};
