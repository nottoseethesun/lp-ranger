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

const { log } = require("./log");
const config = require("./config");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { detectCompoundsOnChain } = require("./compounder");
const { coinsToUsd } = require("./coin-value");
const sendTx = require("./send-transaction");
const { getPoolCreationBlockCached } = require("./pool-creation-block");
const {
  mintBlocksByTokenId,
  scanFloorFor,
  chainScanFloor,
} = require("./nft-mint-blocks");

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
 *  rebalance (new tokenId → no cache entry → scan again).  Returns
 *  the freshly-computed { gasWei, compoundedUsd } so the caller doesn't
 *  re-read the cache it just wrote.
 */
async function _scanNftTotals(deps, position, poolState) {
  const tid = String(position.tokenId);
  const empty = { gasWei: "0", amounts: { amount0: 0, amount1: 0 } };
  if (!deps?.signer) return empty;
  try {
    const walletAddr = await deps.signer.getAddress();
    const opts = {
      positionManagerAddress: config.POSITION_MANAGER,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      walletAddress: walletAddr,
      /*- Compounder's _logCompoundSummary reads opts.wallet (not
       *  walletAddress) and opts.tokenNSymbol; mirror both fields so
       *  the log line shows the actual wallet abbreviation + token
       *  symbols instead of "?" and "Token0/Token1". */
      wallet: walletAddr,
      token0Symbol: position.token0Symbol,
      token1Symbol: position.token1Symbol,
      price0: deps._lastPrice0 || 0,
      price1: deps._lastPrice1 || 0,
      decimals0: poolState.decimals0,
      decimals1: poolState.decimals1,
    };
    /*- Bound the scan to THIS NFT's own mint block.  It cannot have
     *  emitted events before it existed, so anything earlier is a
     *  guaranteed-empty walk — and this runs inside the poll cycle,
     *  which is awaiting it, so a scan that takes minutes is a bot that
     *  reads nothing and cannot rebalance for that long.
     *
     *  The pool's creation block is the fallback for the first NFT of a
     *  chain, whose mint predates the rebalance events. */
    const mintBlocks = mintBlocksByTokenId(deps._rebalanceEvents);
    let fromBlock = scanFloorFor(mintBlocks, tid, null);
    if (fromBlock === null) {
      /*- Only reached when the chain does not name this NFT's mint —
       *  which is the never-rebalanced case, where this NFT IS the
       *  chain's first mint.  The pool lookup is therefore not paid for
       *  in the common case, and when it is, `chainScanFloor` lifts it
       *  to that first mint rather than leaving it at pool creation. */
      const creationBlock = poolState.poolAddress
        ? await getPoolCreationBlockCached({
            provider: deps.provider || sendTx.getManagedReadProvider(),
            factoryAddress: config.FACTORY,
            poolAddress: poolState.poolAddress,
          })
        : 0;
      fromBlock = chainScanFloor(deps._rebalanceEvents, creationBlock);
    }
    const r = await detectCompoundsOnChain(tid, { ...opts, fromBlock });
    const gasWei = String(r.totalNftGasWei || "0");
    /*- The coins this NFT compounded, kept instead of their value: the
     *  figure on screen is priced every poll, so it follows the pair. */
    const amounts = _sumDeposited(r.compounds, opts.decimals0, opts.decimals1);
    const gasMap = { ...(deps._botState?.nftGasWeiByTokenId || {}) };
    const compMap = {
      ...(deps._botState?.nftCompoundedAmountsByTokenId || {}),
    };
    gasMap[tid] = gasWei;
    compMap[tid] = amounts;
    if (deps._botState) {
      deps._botState.nftGasWeiByTokenId = gasMap;
      deps._botState.nftCompoundedAmountsByTokenId = compMap;
    }
    if (deps.updateBotState)
      deps.updateBotState({
        nftGasWeiByTokenId: gasMap,
        nftCompoundedAmountsByTokenId: compMap,
      });
    return { gasWei, amounts };
  } catch (e) {
    log.warn(
      "[pnl-current-nft] per-NFT scan failed for tokenId %s: %s",
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
/*- The coins a list of compound events put back, in token units. */
function _sumDeposited(compounds, d0, d1) {
  let amount0 = 0,
    amount1 = 0;
  for (const c of compounds || []) {
    amount0 += Number(c.amount0Deposited || 0) / 10 ** (d0 ?? 8);
    amount1 += Number(c.amount1Deposited || 0) / 10 ** (d1 ?? 8);
  }
  return { amount0, amount1 };
}

/*-
 *  The coins compoundHistory records against the current tokenId. Used
 *  when the bot's lifetime scan populated history (entries carry
 *  tokenId) but the per-NFT amounts are missing. Avoids an unnecessary
 *  chain scan when the figure can be derived locally.
 */
function _compoundedFromHistory(deps, tid, d0, d1) {
  const history = deps._botState?.compoundHistory;
  if (!history || !history.length) return { amount0: 0, amount1: 0 };
  const mine = history.filter(
    (c) => c.tokenId !== undefined && String(c.tokenId) === tid,
  );
  return _sumDeposited(mine, d0, d1);
}

/*- The coins, at this poll's prices. Everything on the Current panel is
 *  a current figure, so it is priced where it is shown. */
function _priced(amounts, deps) {
  return coinsToUsd(amounts, deps._lastPrice0, deps._lastPrice1);
}

async function applyCurrentNftFigures(snap, deps, position, poolState) {
  if (!snap || !position?.tokenId || !poolState) return;
  const tid = String(position.tokenId);
  const d0 = poolState.decimals0,
    d1 = poolState.decimals1;
  const cachedGas = deps._botState?.nftGasWeiByTokenId?.[tid];
  const cachedComp = deps._botState?.nftCompoundedAmountsByTokenId?.[tid];
  if (cachedGas !== undefined) {
    snap.currentGasUsd = await _weiToUsd(cachedGas);
    const amounts =
      cachedComp !== undefined
        ? cachedComp
        : _compoundedFromHistory(deps, tid, d0, d1);
    snap.currentCompoundedUsd = _priced(amounts, deps);
    return;
  }
  /*-
   *  Cache miss: one scan reads gas + compounded together (one RPC
   *  set, not two).  Both `nftGasWeiByTokenId` and
   *  `nftCompoundedAmountsByTokenId` get persisted so subsequent polls hit
   *  the cache.  Best-effort — on scan failure leaves snap fields as
   *  whatever overridePnlWithRealValues left (currentCompoundedUsd=0,
   *  currentGasUsd undefined → dashboard falls back to liveEpoch.gas).
   */
  const fresh = await _scanNftTotals(deps, position, poolState);
  snap.currentGasUsd = await _weiToUsd(fresh.gasWei);
  snap.currentCompoundedUsd = _priced(fresh.amounts, deps);
}

module.exports = { applyCurrentNftFigures };
