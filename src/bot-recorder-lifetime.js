/**
 * @file src/bot-recorder-lifetime.js
 * @module bot-recorder-lifetime
 * @description
 * Lifetime pool scan: classify compounds + accumulate HODL across all
 * NFTs in the rebalance chain.  Extracted from bot-recorder.js for
 * line-count compliance.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const _epochCache = require("./epoch-cache");
const { fetchTokenPrices: _fetchTokenPrices } = require("./bot-pnl-updater");
const { classifyCompounds } = require("./compounder");
const { computeLifetimeHodl } = require("./lifetime-hodl");
const { computeAndCacheHodl, computeDepositUsd } = require("./bot-hodl-scan");
const { emojiId } = require("./logger");
const { writeErrorLog, getErrorLogPath } = require("./error-log");
const {
  resolvePoolCreationBlockForPosition,
} = require("./pool-creation-block");
const {
  prepareChainRead,
  chainReadFor,
} = require("./bot-recorder-lifetime-read");
const {
  _ensureTokenDecimals,
  _handleHealResult,
  _readDecimalsOverride,
} = require("./bot-recorder-decimals-heal");
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
  log.info(
    "[bot] Lifetime compound scan: %d NFTs across rebalance chain",
    ids.size,
  );
  log.info(
    "[bot]   standalone (auto/manual): %d events totaling $%s",
    allCompounds.length,
    standaloneUsd.toFixed(2),
  );
  log.info(
    "[bot]   rebalance-driven re-deposits: $%s",
    rebalanceUsd.toFixed(2),
  );
  log.info("[bot]   combined lifetime compounded: $%s", totalUsd.toFixed(2));
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
 *      `totalCompoundedUsd`.  Without this guard, `Manage Position` on
 *      a position the unmanaged view has already scanned re-runs
 *      `_classifyAllCompounds` from a stale `lastNftScanBlock`, gets a
 *      partial sum, and stomps the correct disk value.
 *
 *      No rescan is ever needed to keep this total current, because both
 *      ways fees get recycled already maintain it as they happen:
 *
 *        - standalone compounds (auto / "Compound Now") add their amount
 *          in `bot-cycle-compound.js` on success;
 *        - fees collected during a rebalance and re-deposited into the
 *          new NFT are added by `_bumpRebalanceFees` in `bot-recorder.js`,
 *          called from `_closePnlEpoch`.
 *
 *      That is why this guard has no `|| fullRescan` escape while the
 *      deposit guard below does — the asymmetry is deliberate, not an
 *      oversight.  `_needsFullRescan` is set after every rebalance, but
 *      by then `_bumpRebalanceFees` has already credited that rebalance's
 *      fees, so re-classifying the whole chain would only recompute a
 *      number that is already right.
 *
 *      (An earlier version of this note credited a `_recordCompound`
 *      function.  No such function exists anywhere in `src/`; the two
 *      named above are the real writers.  The dangling name cost a full
 *      investigation on 2026-09-01 because the claim could not be
 *      checked without tracing every writer of `totalCompoundedUsd`.)
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
  /*- Readiness gate (per the lifetimeScanComplete invariant): only
   *  flip the flag to true when the scan produced a positive total.
   *  A successful scan that yields totalLifetimeDepositUsd <= 0
   *  (price-fetch failures masked as success, etc.) is not a useful
   *  completion — leave the flag false so the Syncing badge stays
   *  engaged and the 30-min auto-rescan keeps retrying. */
  const total = botState?.totalLifetimeDepositUsd || 0;
  const ready = total > 0;
  if (botState) {
    /*- Released on success: the buffer exists to carry one scan across
     *  a failure, not to answer the next one. The chain head advances
     *  between scans, so holding it would hand a later run reads that
     *  stop short of the head. */
    botState._lifetimeResumeBuffer = null;
    botState._needsFullRescan = false;
    botState._lifetimeScanError = null;
    botState._lifetimeScanErrorAt = null;
    botState._catastrophicScanError = null;
    botState.lifetimeScanComplete = ready;
    updateState({
      _needsFullRescan: false,
      _lifetimeScanError: null,
      _lifetimeScanErrorAt: null,
      _catastrophicScanError: null,
      lifetimeScanComplete: ready,
    });
  }
  log.info(
    "[bot] %s/%s NFT #%s %s: Lifetime scan complete (ready=%s, total=$%s)",
    ctx.t0Sym,
    ctx.t1Sym,
    ctx.tokenIdStr,
    ctx.tokenEmoji,
    ready,
    total.toFixed(2),
  );
}

/**
 * Whether `lastNftScanBlock` can be trusted as a starting point for THIS
 * scan.
 *
 * That cursor means "every block before this one has already been
 * accounted for".  Skipping ahead to it is only safe if the results of
 * that earlier scanning were KEPT — and one pass over the chain's events
 * feeds three separate results, each with its own disk flag:
 *
 *   - lifetime HODL amounts  → `cachedHodl`
 *   - Fees Compounded        → `hasCompoundData`
 *   - Lifetime Deposit       → `hasDepositData`
 *
 * So all three must be satisfied.  Any one of them missing means a
 * consumer downstream is about to compute from scratch, and handing that
 * consumer a slice of the chain instead of the whole of it produces a
 * silently wrong total rather than an error.
 *
 * This is not hypothetical.  On 2026-09-01, position #164418 had a
 * cached HODL but no `totalCompoundedUsd` on disk (the unmanaged detail
 * scan in `position-details-lifetime-scan.js` caches the HODL and only
 * the HODL).  The old condition looked at `cachedHodl` alone, resumed
 * from a recent block, and `_classifyAllCompounds` summed a 2-NFT slice
 * of a 133-NFT chain: it wrote $12.05 where the full chain totals
 * ~$1,184.  Nothing threw — the 131 absent tokenIds each contributed
 * zero, and the summary line reports `ids.size`, so the output looked
 * complete.
 *
 * @param {object} state
 * @param {object|null} state.cachedHodl       Cached lifetime-HODL, if any.
 * @param {boolean} state.hasCompoundData      Disk holds a compound total.
 * @param {boolean} state.hasDepositData       Disk holds a deposit total.
 * @returns {boolean}  True when every consumer already has its own result.
 */
function canResumeIncrementally({
  cachedHodl,
  hasCompoundData,
  hasDepositData,
}) {
  return !!cachedHodl && !!hasCompoundData && !!hasDepositData;
}

/** Resolve the starting block for the event scan, honoring the rescan flag. */
async function _resolveScanFromBlock(
  epochKey,
  fullRescan,
  position,
  canResume,
) {
  /*- `canResume` is the whole precondition (see `canResumeIncrementally`):
   *  every lifetime aggregate this scan can produce already has an
   *  authoritative value on disk, so there is nothing left that needs the
   *  older events.  Otherwise start from the pool creation block. */
  const useCached = !!epochKey && !fullRescan && canResume;
  const cachedFromBlock = useCached
    ? _epochCache.getLastNftScanBlock(epochKey)
    : 0;
  if (cachedFromBlock > 0) return cachedFromBlock;
  return resolvePoolCreationBlockForPosition({
    factoryAddress: config.FACTORY,
    position,
  });
}

/**
 * The position's per-NFT resume buffer, created on first use.
 *
 * Same purpose as the buffer in `epoch-reconstructor.js`, for the other
 * long per-NFT pass. The lifetime loop walks the whole rebalance chain
 * three queries at a time; without somewhere to keep the NFTs already
 * read, a throw anywhere in it costs every one of them and the next
 * attempt starts from the first again. See `fetchAllNftEvents` for why
 * reuse is gated on the scan floor and on the NFT being retired, and
 * `_recordScanSuccess` for the release.
 *
 * Extracted from `_scanLifetimePoolData` so the lazy-create branch does
 * not push that function past the complexity cap.
 *
 * @param {object} [botState]  Live per-position bot state.  Without one
 *   there is nowhere to carry reads to, so a throwaway Map is returned
 *   and the scan simply does not resume — the caller stays working.
 * @param {boolean} [fullRescan]  True when a rebalance forced this scan.
 * @returns {Map<string, {from: number, ev: object}>}
 */
function _lifetimeResumeBuffer(botState, fullRescan) {
  /*- Tolerates a missing state object.  This is the first thing in the
   *  scan to reach into `botState`, and a scan is worth running with no
   *  resume at all — so an absent one costs the buffer, not the scan. */
  if (botState === undefined || botState === null) return new Map();
  /*- A full rescan means a rebalance fired, so any NFT in the chain may
   *  have emitted since the buffered read — the one it just retired
   *  certainly did. Start from nothing rather than trust a floor
   *  comparison to notice, since the floor is the pool creation block
   *  on both sides when no scan has completed yet. */
  if (fullRescan === true) botState._lifetimeResumeBuffer = null;
  if (!(botState._lifetimeResumeBuffer instanceof Map))
    botState._lifetimeResumeBuffer = new Map();
  return botState._lifetimeResumeBuffer;
}

/**
 * What this position's lifetime scan will do, decided from state alone.
 *
 * The one place the decision is made. `_scanLifetimePoolData` returns early
 * on it, and `_scanAndReconstruct` (`src/bot-recorder.js`) asks it before
 * epoch reconstruction, to learn whether the lifetime scan will read the
 * chain this pass — in which case reconstruction takes its events from that
 * read instead of making its own.
 *
 * Reconstruction needs each closed NFT's whole history, so that sharing
 * depends on a needed read never resuming from `lastNftScanBlock`. The
 * early return guarantees it: a scan that could resume has every result it
 * would compute already saved, so it does not run at all.
 * `test/bot-recorder-lifetime-share.test.js` pins that for every state.
 *
 * @param {object} botState  Live per-position bot state.
 * @param {object|null} epochKey  Epoch-cache key for the pool.
 * @returns {{needed: boolean, fullRescan: boolean, cachedHodl: object|null,
 *   hasCompoundData: boolean, hasDepositData: boolean}}
 */
function lifetimeScanPlan(botState, epochKey) {
  const fullRescan = !!botState?._needsFullRescan;
  const disk = _resolveDiskState(botState, epochKey);
  /*- The rebalance path sets `_needsFullRescan` to force re-classification
   *  of every IncreaseLiquidity event in the (now-extended) chain, so it
   *  overrides saved totals. */
  const needed = fullRescan || !canResumeIncrementally(disk);
  return { ...disk, fullRescan, needed };
}

/**
 * This position's lifetime chain read, prepared but not started.
 *
 * Where it starts and which resume buffer it draws on are decided when it
 * runs, by the rules the scan has always used: from the pool's creation
 * block, lifted to the chain's first mint, and a full rescan treats the
 * buffer as untrusted.
 *
 * @param {object} position  Live position.
 * @param {object} botState  Live per-position bot state.
 * @param {Array} rebalanceEvents  The chain to read.
 * @param {object|null} epochKey  Epoch-cache key for the pool.
 * @returns {object}  See `prepareChainRead`.
 */
function prepareLifetimeRead(position, botState, rebalanceEvents, epochKey) {
  return prepareChainRead({
    position,
    rebalanceEvents,
    start: async () => {
      const plan = lifetimeScanPlan(botState, epochKey);
      const fromBlock = await _resolveScanFromBlock(
        epochKey,
        plan.fullRescan,
        position,
        canResumeIncrementally(plan),
      );
      const resumeBuffer = _lifetimeResumeBuffer(botState, plan.fullRescan);
      return { fromBlock, resumeBuffer };
    },
  });
}

/*- Persist scan-failure state so the 30-min auto-rescan can see the gap.
 *  Also keeps `lifetimeScanComplete` at false so the Syncing badge stays
 *  engaged until a future scan succeeds.
 *
 *  Catastrophic-failure record.  A lifetime scan that aborts here
 *  leaves the position's totals frozen at whatever the partial scan
 *  reached — a plausible-looking number, with no indication it is
 *  short — so the abort has to announce itself.  Every entry to this
 *  function:
 *    (a) appends a stacktrace record to logs/error.log via
 *        writeErrorLog(), so a fresh install two weeks later can still
 *        show the operator exactly what went wrong; and
 *    (b) stamps `_catastrophicScanError` on the bot state so the
 *        dashboard can paint a red alert directing the user to
 *        Settings -> Reload Current Position.
 *  Reserved for THIS surface — do not add writeErrorLog() calls to
 *  routine catches. */
function _recordScanFailure(botState, updateState, err, ctx) {
  const errAt = Date.now();
  /*- Defensive `.message` read: the catch upstream is a bare
   *  `catch (err)` (no type filter), so `err` could technically be a
   *  primitive or a plain object without `.message`.  Fall back to
   *  `String(err)` before the value ships to the dashboard as
   *  user-facing text — an "undefined" render is worse than the raw
   *  string form of whatever was thrown. */
  const errMsg =
    err && typeof err.message === "string" && err.message
      ? err.message
      : String(err || "unknown error");
  const contextLine =
    "[bot-recorder-lifetime] Lifetime pool scan failed: " +
    (ctx.t0Sym || "?") +
    "/" +
    (ctx.t1Sym || "?") +
    " NFT #" +
    (ctx.tokenIdStr || "?");
  writeErrorLog(err, contextLine);
  if (botState) {
    botState._lifetimeScanError = errMsg;
    botState._lifetimeScanErrorAt = errAt;
    /*- Defensive: if a prior scan flipped the flag to true and a
     *  subsequent re-scan (post-rebalance) just failed, push it back
     *  to false so the Syncing badge re-engages.  No-op if already
     *  false from the initial state. */
    botState.lifetimeScanComplete = false;
    botState._catastrophicScanError = {
      message: errMsg,
      at: errAt,
      tokenId: ctx.tokenIdStr || null,
      logPath: getErrorLogPath(),
    };
    updateState({
      _lifetimeScanError: errMsg,
      _lifetimeScanErrorAt: errAt,
      lifetimeScanComplete: false,
      _catastrophicScanError: botState._catastrophicScanError,
    });
  }
  log.warn(
    "[bot] %s/%s NFT #%s %s: Lifetime pool scan failed: %s",
    ctx.t0Sym,
    ctx.t1Sym,
    ctx.tokenIdStr,
    ctx.tokenEmoji,
    errMsg,
  );
  log.warn("[bot] Catastrophic scan failure recorded to %s", getErrorLogPath());
}

/**
 * Unified lifetime pool scan: read the chain's NFT events once, then run
 * compound classification, lifetime HODL accumulation and the deposit
 * total over them.
 *
 * @param {object} position  Live position.
 * @param {object} botState  Live per-position bot state.
 * @param {Function} updateState  State update callback.
 * @param {Array} rebalanceEvents  The chain.
 * @param {string} walletAddress
 * @param {object|null} pnlTracker
 * @param {object|null} epochKey  Epoch-cache key for the pool.
 * @param {object|null} [preparedRead]  The chain read this pass prepared
 *   for epoch reconstruction to share (`prepareLifetimeRead`). Used while
 *   it still describes the chain this scan sees; otherwise the scan
 *   prepares its own.
 * @param {boolean} [chainFound=true]  False when this pass's event scan
 *   failed, so `rebalanceEvents` may fall short of the chain.
 * @returns {Promise<void>}
 */
async function _scanLifetimePoolData(
  position,
  botState,
  updateState,
  rebalanceEvents,
  walletAddress,
  pnlTracker,
  epochKey,
  preparedRead,
  chainFound = true,
) {
  const ctx = _scanLogCtx(position);
  const plan = lifetimeScanPlan(botState, epochKey);
  const { fullRescan, cachedHodl, hasCompoundData, hasDepositData } = plan;
  if (!plan.needed) {
    /*- Nothing to compute, but readiness must still be recorded. Every
     *  pass starts by lowering `lifetimeScanComplete`, and only this
     *  function raises it; skipping it here left a restart with every
     *  figure saved showing "Syncing…" for good, its Lifetime panel
     *  blank and the rescan timer firing every 30 minutes. */
    log.info(
      "[bot] %s/%s NFT #%s %s: Lifetime figures are already saved; no chain read needed",
      ctx.t0Sym,
      ctx.t1Sym,
      ctx.tokenIdStr,
      ctx.tokenEmoji,
    );
    _recordScanSuccess(botState, updateState, ctx);
    return;
  }
  if (!chainFound) {
    /*- The chain is whatever the bot held before this pass, which on a
     *  cold start is nothing. Figures computed from it would cover the
     *  live NFT alone, and they would be saved as settled, which later
     *  passes keep. Readiness stays as the pass start lowered it, and the
     *  30-minute rescan retries the whole pass. */
    log.warn(
      "[bot] %s/%s NFT #%s %s: The rebalance history could not be read, so the lifetime figures wait for the next scan",
      ctx.t0Sym,
      ctx.t1Sym,
      ctx.tokenIdStr,
      ctx.tokenEmoji,
    );
    return;
  }
  log.info(
    "[bot] %s/%s NFT #%s %s: Starting lifetime scan (fullRescan=%s)",
    ctx.t0Sym,
    ctx.t1Sym,
    ctx.tokenIdStr,
    ctx.tokenEmoji,
    fullRescan,
  );
  try {
    /*- Heal step: ensure valid on-chain token decimals (honoring any manual
     *  override / force from config) before any valuation. `_handleHealResult`
     *  stamps `_retireReason` + writes error.log on an unhealable defect,
     *  logs+skips on a transient error, and self-clears error.log on a
     *  successful resolve; it returns true when the scan must abort. */
    const heal = await _ensureTokenDecimals(
      position,
      fullRescan,
      _readDecimalsOverride(botState),
    );
    if (_handleHealResult(heal, botState, position, ctx)) return;
    /*- The pass's shared read when epoch reconstruction already made it
     *  for this same chain, so the chain is read once; otherwise this
     *  scan's own. `fromBlock` is the unlifted start block: the checkpoint
     *  comparison below uses it, so a run that finds no events but did
     *  lift its floor to the chain's first mint still records that higher
     *  floor as the resume point. */
    const chainRead = chainReadFor(
      preparedRead,
      position,
      rebalanceEvents,
      () => prepareLifetimeRead(position, botState, rebalanceEvents, epochKey),
      ctx,
    );
    const { allNftEvents, maxBlock, fromBlock } = await chainRead.read();
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
      /*- NFT factory for the full-context log format (see
       *  feedback-log-full-context).  Without this, _logCompoundSummary
       *  would render the factory slot empty. */
      positionManagerAddress: config.POSITION_MANAGER,
    };
    const ids = chainRead.ids;
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
  canResumeIncrementally,
  lifetimeScanPlan,
  prepareLifetimeRead,
  _applyCompoundGas,
  _classifyAllCompounds,
  _scanLifetimePoolData,
  _recordScanFailure, // exported for tests
  _recordScanSuccess, // exported for tests
  _lifetimeResumeBuffer, // exported for tests
  _resolveDiskState, // exported for tests
};
