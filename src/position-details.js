/**
 * @file position-details.js
 * @description Phase 2 of the unmanaged position detail request: the
 *   pool's rebalance-event scan. Phase 1 (fast) is in
 *   position-details-quick.js.
 *
 *   An unmanaged position shows no Lifetime panel — `ltContent` is
 *   replaced by a placeholder telling the operator to click Manage — and
 *   no Per-Day P&L. So this phase computes neither. What it returns is
 *   what such a position actually displays: the Rebalance Events table,
 *   and the Current panel's Fees Compounded and Gas.
 *
 *   That is why nothing here walks the rebalance chain. The per-NFT walk
 *   is the largest repeated cost in the app, and on this path it can
 *   only produce figures no panel renders. The Current panel's two come
 *   from a single-NFT scan bounded to that NFT's own mint block.
 *
 *   Epochs already saved for the pool are still restored, so a position
 *   managed earlier keeps what it built then. Reconstruction from chain
 *   is not run.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const { getPoolState } = require("./rebalancer");
const { positionValueUsd, fetchTokenPrices } = require("./bot-pnl-updater");
const { reconstructEpochs } = require("./epoch-reconstructor");
const { createPnlTracker } = require("./pnl-tracker");
const { getCachedEpochs, setCachedEpochs } = require("./epoch-cache");
const { scanPoolHistory } = require("./pool-scanner");
const { compositeKey } = require("./bot-config-v2");
const {
  computeQuickDetails,
  _currentPnl,
  _applyPriceOverrides,
  _walletResiduals,
} = require("./position-details-quick");
const {
  _detectCurrentNftValues,
  savedNftCompoundedUsd,
} = require("./position-details-compound");
const { resolvePositionSymbols } = require("./resolve-position-symbols");
const { applyInitialResidualFromCache } = require("./bot-pnl-initial-residual");

/**
 * Run the pool's event scan and bring the P&L history up to date.
 *
 * Starts from the history saved for the pool. `reconstructEpochs` keeps
 * that history only when it covers every closed NFT in the chain, and
 * rebuilds it otherwise.
 *
 * `epochChainFor(events)` answers the request's chain reader when the
 * request's other consumers are going to read the chain anyway, so epoch
 * reconstruction takes its histories from that read; otherwise undefined,
 * and reconstruction reads for itself.
 *
 * @param {object} provider  ethers provider.
 * @param {object} ethersLib  ethers library.
 * @param {object} position  Position with `token0`, `token1`, `fee`.
 * @param {string} walletAddr  Wallet address, or "".
 * @param {{price0: number, price1: number}} prices  Fallback prices.
 * @param {number} deposit  Initial deposit for the tracker, USD.
 * @param {string|null} poolAddress  Pool contract, for the pool scan.
 * @param {(events: Array) => (Function|undefined)} epochChainFor
 * @returns {Promise<{tracker: object, events: object[]}>}
 */
async function _getLifetimeSnapshot(
  provider,
  ethersLib,
  position,
  walletAddr,
  prices,
  deposit,
  poolAddress,
  epochChainFor,
) {
  const poolCacheKey = position.token0
    ? {
        contract: config.POSITION_MANAGER,
        wallet: walletAddr,
        token0: position.token0,
        token1: position.token1,
        fee: position.fee,
      }
    : null;
  const cached = poolCacheKey ? getCachedEpochs(poolCacheKey) : null;
  const tracker = createPnlTracker({ initialDeposit: deposit || 0 });
  if (cached) tracker.restore(cached);
  log.info(
    "[position details] epoch cache: key=%s cached=%d restored=%d t0=%s",
    !!poolCacheKey,
    cached?.closedEpochs?.length || 0,
    tracker.epochCount(),
    position.token0?.slice(0, 8) || "MISSING",
  );
  const events = await scanPoolHistory(provider, ethersLib, {
    walletAddress: walletAddr,
    position,
    poolAddress: poolAddress || null,
    computeFromHistoricalPrices: async (evts) => {
      if (evts.length === 0) return;
      /*-
       *  `reconstructEpochs` decides whether to rebuild. It keeps a
       *  history that covers every closed NFT, whether restored above or
       *  saved since by another request for this pool, and rebuilds one
       *  that falls short. Stopping here whenever some history is saved
       *  would keep a short one on every later visit.
       */
      const readChainEvents = epochChainFor(evts);
      await reconstructEpochs({
        pnlTracker: tracker,
        rebalanceEvents: evts,
        botState: {
          activePosition: position,
          walletAddress: walletAddr,
          positionManager: config.POSITION_MANAGER,
        },
        fallbackPrices: prices,
        readChainEvents,
      });
      if (poolCacheKey) setCachedEpochs(poolCacheKey, tracker.serialize());
    },
  });
  return { tracker, events };
}

/** Resolve entry value from disk config for phase 2 (no chain baseline fetch). */
function _resolveEntryValueCached(diskConfig, posKey) {
  const deposit = diskConfig.positions[posKey]?.initialDepositUsd || 0;
  const bl = diskConfig.positions[posKey]?.hodlBaseline || null;
  const ev = deposit > 0 ? deposit : bl?.entryValue || 0;
  return { baseline: bl, entryValue: ev };
}

/**
 * Enrich a tracker snapshot with the fields the unmanaged view shows.
 *
 * Current-panel figures only. An unmanaged position replaces the
 * Lifetime panel with a placeholder, so nothing renders a lifetime IL, a
 * lifetime compounded total or the lifetime HODL amounts — and resolving
 * the HODL costs a walk of the whole rebalance chain.
 */
async function _enrichSnap(snap, cur, curComp, curGasUsd, entry, pos) {
  /*- The caller always passes an object; this only stops a future one
   *  silently writing onto nothing. */
  if (snap === undefined || snap === null) return;
  snap.currentValue = cur.value;
  snap.currentCompoundedUsd = curComp || 0;
  snap.currentGasUsd = curGasUsd || 0;
  snap.initialDeposit = entry;
  /*- Mirror bot-pnl-updater._applyResiduals: the unmanaged path computes
   *  residuals via _walletResiduals → _currentPnl, but they were never
   *  copied to the snap.  Without these the Lifetime panel's "Wallet
   *  Residual (Pool)" row reads $0 even when wallet balances are
   *  non-zero. */
  snap.residualValueUsd = cur.residualValueUsd || 0;
  snap.residualUsd0 = cur.residualUsd0 || 0;
  snap.residualUsd1 = cur.residualUsd1 || 0;
  snap.residualAmount0 = cur.residualAmount0 || 0;
  snap.residualAmount1 = cur.residualAmount1 || 0;
  /*- Genesis residual: read from the shared liquidity-pair-details cache
   *  if a managed scan has already populated it. Unmanaged details runs
   *  don't populate the cache themselves (no historical scan path here),
   *  so this is best-effort: present when the same (chain/factory/wallet/
   *  token0/token1/fee) scope has been seen before, zero otherwise. */
  if (pos.walletAddress) {
    applyInitialResidualFromCache(snap, {
      blockchain: config.CHAIN_NAME,
      factory: config.POSITION_MANAGER,
      wallet: pos.walletAddress,
      token0: pos.token0,
      token1: pos.token1,
      fee: pos.fee,
    });
  }
}

async function computeLifetimeDetails(provider, ethersLib, body, diskConfig) {
  const position = {
    tokenId: body.tokenId,
    token0: body.token0,
    token1: body.token1,
    fee: body.fee,
    tickLower: body.tickLower,
    tickUpper: body.tickUpper,
    liquidity: body.liquidity,
  };
  /*- Populate position.token0Symbol / token1Symbol so the compound
   *  classification log (_logCompoundSummary) and any other downstream
   *  log site can render real names instead of "Token0"/"Token1".
   *  Same shared helper bot-loop-detect.js uses. */
  await resolvePositionSymbols(provider, position);
  const _ltT0 = Date.now();
  log.info(
    "[position details] Computing lifetime P&L for #%s\u2026",
    body.tokenId,
  );
  const posKey = compositeKey(
    "pulsechain",
    body.walletAddress || "",
    body.contractAddress || config.POSITION_MANAGER,
    body.tokenId,
  );
  const ps = await getPoolState(provider, ethersLib, {
    factoryAddress: config.FACTORY,
    token0: body.token0,
    token1: body.token1,
    fee: body.fee,
  });
  const prices = await fetchTokenPrices(body.token0, body.token1);
  _applyPriceOverrides(prices, body);
  const { price0, price1 } = prices;
  const { baseline, entryValue } = _resolveEntryValueCached(diskConfig, posKey);
  const value = positionValueUsd(position, ps, price0, price1);
  const feesUsd = body.feesUsd || 0;
  const residuals = await _walletResiduals(
    provider,
    ethersLib,
    position,
    ps,
    price0,
    price1,
    body.walletAddress || "",
  );
  const cur = _currentPnl(
    baseline,
    value,
    entryValue,
    feesUsd,
    price0,
    price1,
    residuals,
    /*- The saved coins, which cost nothing to read: this NFT's own
     *  compounded fees come out of the LP value before it is compared
     *  against HODL, so `cur.il` matches what the bot reports for the
     *  same position. Zero while the position has never been managed,
     *  since only the bot's lifetime scan writes those coins. */
    savedNftCompoundedUsd(diskConfig, posKey, position.tokenId, price0, price1),
  );
  // Position with the metadata the lifetime HODL needs (same as managed path)
  const _posWithMeta = {
    ...position,
    walletAddress: body.walletAddress,
    decimals0: ps.decimals0,
    decimals1: ps.decimals1,
  };
  /*-
   *  Never the chain. Epoch reconstruction exists here to fill the
   *  Per-Day P&L table, and that table is not shown for an unmanaged
   *  position — which is every position this path serves. Reconstructing
   *  would walk each NFT in the chain to produce rows nothing renders.
   *
   *  Epochs already in the pool cache are still restored, so a position
   *  that was managed before keeps whatever it built then. What is gone
   *  is this path ALSO warming that cache for a position that was never
   *  managed: the bot reconstructs for itself on the first Manage, and
   *  paying minutes up front for a table with no reader was the cost
   *  this removes.
   */
  const epochChainFor = () => undefined;
  const { tracker, events } = await _getLifetimeSnapshot(
    provider,
    ethersLib,
    position,
    body.walletAddress || "",
    { price0, price1 },
    entryValue,
    ps.poolAddress,
    epochChainFor,
  );
  /*-
   *  An object either way, never null. The Current panel's Fees
   *  Compounded and Gas travel on this snapshot — through
   *  `_syncLifetimeState` into the position's state, and out again on the
   *  next `/api/status` poll — and they are not epoch figures. A
   *  never-managed position has no epochs at all now that nothing
   *  reconstructs them here, so keying the snapshot's existence on the
   *  epoch count would withhold those two rows from exactly the
   *  positions this path serves.
   */
  const snap = tracker.epochCount() > 0 ? tracker.snapshot(ps.price) : {};
  /*-
   *  One NFT, not the chain. The Current panel's Fees Compounded and Gas
   *  are about the NFT being looked at, and reading it is a single scan
   *  bounded to that NFT's own mint block. The lifetime total across
   *  every NFT in the chain would cost the whole walk, for a figure the
   *  Lifetime panel does not display.
   */
  const { compoundUsd: curCompounded, gasUsd: curGasUsd } =
    await _detectCurrentNftValues(
      position,
      body,
      ps,
      { price0, price1 },
      events,
    );
  log.info(
    "[position details] tokenId=%s epochs=%d baseline=%s",
    body.tokenId,
    tracker.epochCount(),
    !!baseline,
  );
  log.info(
    "[position details] #%s done (%dms)",
    body.tokenId,
    Date.now() - _ltT0,
  );
  /*-
   *  No lifetime HODL and no lifetime IL. Both appear only in the
   *  Lifetime panel, which an unmanaged position replaces with a
   *  placeholder, and resolving the HODL walks the whole rebalance
   *  chain — minutes, for a figure with no reader.
   */
  await _enrichSnap(
    snap,
    cur,
    curCompounded,
    curGasUsd,
    entryValue,
    _posWithMeta,
  );
  /*- The managed bot path sets `currentFeesUsd` via
   *  bot-pnl-updater.overridePnlWithRealValues; the unmanaged details
   *  path needs the same field so _syncLifetimeState and the dashboard
   *  Lifetime panel see live unclaimed fees (not undefined). */
  if (snap) snap.currentFeesUsd = feesUsd;
  /*-
   *  Exactly what an unmanaged position displays: the Rebalance Events
   *  table, and the Current panel's Fees Compounded and Gas. Lifetime
   *  figures and Per-Day P&L rows belong to a panel and a table such a
   *  position does not show, so returning them would buy nothing and
   *  cost the chain walk that produces them.
   */
  return {
    ok: true,
    entryValue,
    currentValue: cur.value,
    rebalanceEvents: events.length > 0 ? events : null,
    pnlSnapshot: snap,
  };
}

module.exports = {
  computeQuickDetails,
  computeLifetimeDetails,
  _getLifetimeSnapshot,
  _resolveEntryValueCached,
};
