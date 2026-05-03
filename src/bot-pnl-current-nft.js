/**
 * @file src/bot-pnl-current-nft.js
 * @module bot-pnl-current-nft
 * @description
 *   Current-panel per-NFT figures for the Managed dashboard:
 *   "Fees Compounded" and "Gas".  Both must match what the Unmanaged
 *   on-chain scan reports for the same NFT (see
 *   `position-details-compound.js`).
 *
 *   Lives outside `bot-pnl-updater.js` so the heavy `compounder` require
 *   chain (ethers Interface construction at module-load) doesn't get
 *   pulled into modules that mock ethers (bot-hodl-scan tests) and would
 *   otherwise blow up with `ethers.Interface is not a constructor`.
 *
 *   Lifetime panel is intentionally untouched — `snap.totalCompoundedUsd`
 *   and `snap.totalGas` remain the lifetime sources.
 */

"use strict";

const config = require("./config");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { detectCompoundsOnChain } = require("./compounder");

/*-
 *  Convert wei (string-safe) to USD at the current native-token price.
 *  Inlined here rather than re-exporting `actualGasCostUsd` to keep the
 *  module's own require chain free of bot-pnl-updater (avoids reverse
 *  coupling and keeps the test-mock surface small).
 */
async function _weiToUsd(weiStr) {
  const wei = BigInt(weiStr || "0");
  if (wei <= 0n) return 0;
  try {
    const p = await fetchTokenPriceUsd(config.CHAIN.nativeWrappedToken);
    return (Number(wei) / 1e18) * p;
  } catch {
    return 0;
  }
}

/*-
 *  One-shot per-NFT scan that fills both per-NFT caches on miss.  Cheap
 *  (~one filtered Transfer query per NFT, not the full chain scan) and
 *  runs at most once per NFT until invalidated by `recordCompound` or a
 *  rebalance (new tokenId → no cache entry → backfill again).  Returns
 *  the freshly-computed { gasWei, compoundedUsd } so the caller doesn't
 *  re-read the cache it just wrote.
 */
async function _backfill(deps, position, poolState) {
  const tid = String(position.tokenId);
  const empty = { gasWei: "0", compoundedUsd: 0 };
  if (!deps?.signer) return empty;
  try {
    const opts = {
      positionManagerAddress: config.POSITION_MANAGER,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      walletAddress: await deps.signer.getAddress(),
      price0: deps._lastPrice0 || 0,
      price1: deps._lastPrice1 || 0,
      decimals0: poolState.decimals0,
      decimals1: poolState.decimals1,
    };
    const r = await detectCompoundsOnChain(tid, opts);
    const gasWei = String(r.totalNftGasWei || "0");
    const compoundedUsd = (r.compounds || []).reduce(
      (s, c) => s + (c.usdValue || 0),
      0,
    );
    const gasMap = { ...(deps._botState?.nftGasWeiByTokenId || {}) };
    const compMap = { ...(deps._botState?.nftCompoundedUsdByTokenId || {}) };
    gasMap[tid] = gasWei;
    compMap[tid] = compoundedUsd;
    if (deps._botState) {
      deps._botState.nftGasWeiByTokenId = gasMap;
      deps._botState.nftCompoundedUsdByTokenId = compMap;
    }
    if (deps.updateBotState)
      deps.updateBotState({
        nftGasWeiByTokenId: gasMap,
        nftCompoundedUsdByTokenId: compMap,
      });
    return { gasWei, compoundedUsd };
  } catch (e) {
    console.warn(
      "[pnl-current-nft] per-NFT backfill failed for tokenId %s: %s",
      tid,
      e.message,
    );
    return empty;
  }
}

/*-
 *  Populate `snap.currentGasUsd` and (when the cache is fresher than the
 *  history-derived value) `snap.currentCompoundedUsd` for the Current panel.
 *  Match Unmanaged's `currentGasUsd` / `current` so both views agree on the
 *  same NFT.  Best-effort — never throws; on any failure leaves snap fields
 *  untouched so the dashboard's existing `?? liveEpoch.gas` fallback kicks in.
 */
/*-
 *  Sum compoundHistory.usdValue entries that match the current tokenId.
 *  Used when the bot's lifetime scan populated history (entries carry
 *  tokenId) but the per-NFT compounded cache is missing.  Avoids an
 *  unnecessary backfill scan when the figure can be derived locally.
 */
function _compoundedFromHistory(deps, tid) {
  const history = deps._botState?.compoundHistory;
  if (!history || !history.length) return 0;
  let sum = 0;
  for (const c of history) {
    if (c.tokenId !== undefined && String(c.tokenId) === tid)
      sum += c.usdValue || 0;
  }
  return sum;
}

async function applyCurrentNftFigures(snap, deps, position, poolState) {
  if (!snap || !position?.tokenId || !poolState) return;
  const tid = String(position.tokenId);
  const cachedGas = deps._botState?.nftGasWeiByTokenId?.[tid];
  const cachedComp = deps._botState?.nftCompoundedUsdByTokenId?.[tid];
  if (cachedGas !== undefined) {
    snap.currentGasUsd = await _weiToUsd(cachedGas);
    snap.currentCompoundedUsd =
      cachedComp !== undefined ? cachedComp : _compoundedFromHistory(deps, tid);
    return;
  }
  /*-
   *  Cache miss: backfill scans both gas + compounded together (one RPC
   *  set, not two).  Both `nftGasWeiByTokenId` and
   *  `nftCompoundedUsdByTokenId` get persisted so subsequent polls hit
   *  the cache.  Best-effort — on scan failure leaves snap fields as
   *  whatever overridePnlWithRealValues left (currentCompoundedUsd=0,
   *  currentGasUsd undefined → dashboard falls back to liveEpoch.gas).
   */
  const fresh = await _backfill(deps, position, poolState);
  snap.currentGasUsd = await _weiToUsd(fresh.gasWei);
  snap.currentCompoundedUsd = fresh.compoundedUsd;
}

module.exports = { applyCurrentNftFigures };
