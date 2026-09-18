/**
 * @file src/bot-recorder-lifetime.js
 * @module bot-recorder-lifetime
 * @description
 * Lifetime pool scan: classify compounds + accumulate HODL across all
 * NFTs in the rebalance chain.  Extracted from bot-recorder.js for
 * line-count compliance.
 *
 * Each figure is computed once and then read from disk.  Two requests
 * override that, both carried on the bot state and both cleared only by
 * a scan that finishes:
 *
 *   - `_needsFullRescan` — set after a rebalance, and by Reload.
 *   - `_needsPriceRevalue` — set by Re-scan Prices.  Every dollar figure
 *     is rebuilt at freshly fetched prices: the compound totals, the
 *     lifetime deposit, and the HODL baseline's entry value.  Each one
 *     is overwritten only once its new value exists, so a failed scan or
 *     a silent price source leaves the saved figure intact.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const _epochCache = require("./epoch-cache");
const { fetchTokenPrices: _fetchTokenPrices } = require("./bot-pnl-updater");
const { classifyCompounds } = require("./compounder");
const { computeLifetimeHodl } = require("./lifetime-hodl");
const {
  computeAndCacheHodl,
  computeDepositUsd,
  revalueHodlBaseline,
} = require("./bot-hodl-scan");
const { withFreshPricesAllowed } = require("./price-fetcher-gate");
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
const { isIntegerInRange } = require("./pool-state-validate");

/** Add historical compound gas to the P&L tracker if available. */
async function _applyCompoundGas(totalGasWei, pnlTracker) {
  if (!totalGasWei || totalGasWei === 0n) return;
  if (!pnlTracker || pnlTracker.epochCount() === 0) return;
  const gasUsd = await _actualGasCostUsd(totalGasWei);
  const gasNative = Number(totalGasWei) / 1e18;
  if (gasUsd > 0) pnlTracker.addGas(gasUsd, gasNative);
}

/*-
 *  Run `step` with the price gate lifted when this scan is a re-value.
 *
 *  Both things the gate does would defeat the action: the idle pause
 *  makes a price read answer with nothing, and the cache answers with
 *  the number the user asked to have replaced. Outside a re-value the
 *  step runs exactly as before.
 */
function _withFreshPrices(revalue, step) {
  return revalue === true ? withFreshPricesAllowed(step) : step();
}

/*-
 *  Current prices for this scan's valuations. Every caller treats zero
 *  as "no value", so a failed read leaves the saved figures alone.
 */
function _readCurrentPrices(position, revalue) {
  const read = () => _fetchTokenPrices(position.token0, position.token1);
  return _withFreshPrices(revalue, read).catch(() => ({
    price0: 0,
    price1: 0,
  }));
}

/*-
 *  The block this NFT was minted in, taken from the read this scan
 *  already made: an NFT's first IncreaseLiquidity is its mint. Prices
 *  the mint at its own block instead of costing a lookup.
 */
function _mintBlockOf(allNftEvents, tokenId) {
  const events = allNftEvents.get(String(tokenId ?? ""));
  return events?.ilEvents?.[0]?.blockNumber;
}

/*-
 *  Refuse to classify against decimals that are not a real ERC-20
 *  answer.
 *
 *  Every figure below turns raw token units into coins by dividing by
 *  `10 ** decimals`, so a wrong exponent is a wrong money figure by
 *  orders of magnitude, written to disk and priced on screen with
 *  nothing about it that looks unusual. A default in place of the real
 *  value buys nothing here: it cannot be right except by luck, and it
 *  hides the one condition worth knowing about.
 *
 *  `_ensureTokenDecimals` runs earlier in the scan and aborts on a
 *  defect it cannot heal, so reaching this with an invalid value means
 *  that guarantee broke. Throwing puts it in `logs/error.log` through
 *  `_recordScanFailure` and leaves the Sync badge on "Syncing…", which
 *  is the same treatment every other unhealable scan defect gets.
 *
 *  The predicate is the one `getPoolState` validates against, so this
 *  and the heal step cannot disagree about what "valid" means.
 */
function _requireValidDecimals(opts) {
  const ok = (d) => isIntegerInRange(d, 0, 77);
  if (ok(opts.decimals0) && ok(opts.decimals1)) return;
  throw new Error(
    `${opts.token0Symbol || "token0"}/${opts.token1Symbol || "token1"}: ` +
      `cannot classify compounds — token decimals are invalid ` +
      `(decimals0=${opts.decimals0} decimals1=${opts.decimals1}); every ` +
      `compounded amount would be mis-scaled, so nothing is saved`,
  );
}

/*-
 *  The coins each NFT compounded, from the events just classified.
 *
 *  The Current panel shows this per-NFT figure in dollars, and
 *  `bot-pnl-current-nft.js` otherwise fills it by scanning that one NFT
 *  again. Writing the amounts here spares that scan, and leaves the
 *  pricing to whoever displays it.
 *
 *  `d0`/`d1` are guaranteed valid by `_requireValidDecimals`, so there
 *  is no fallback exponent to fall back to.
 */
function _compoundedAmountsByTokenId(history, d0, d1) {
  const byTokenId = {};
  for (const c of history) {
    const tid = String(c.tokenId);
    const held = byTokenId[tid] || { amount0: 0, amount1: 0 };
    held.amount0 += Number(c.amount0Deposited) / 10 ** d0;
    held.amount1 += Number(c.amount1Deposited) / 10 ** d1;
    byTokenId[tid] = held;
  }
  return byTokenId;
}

/** Classify compounds across all NFTs and persist results. */
async function _classifyAllCompounds(
  ids,
  allNftEvents,
  opts,
  updateState,
  pnlTracker,
) {
  _requireValidDecimals(opts);
  const allCompounds = [];
  let totalUsd = 0;
  let totalAmount0 = 0,
    totalAmount1 = 0;
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
    /*- The coins are what gets saved; the dollars above are for this
     *  scan's own log lines and for deciding there is anything to save. */
    totalAmount0 += r.feeAmount0 || 0;
    totalAmount1 += r.feeAmount1 || 0;
    totalCompoundGasWei += BigInt(r.totalGasWei || "0");
    nftGasWeiByTokenId[String(tid)] = String(r.totalNftGasWei || "0");
  }
  /*-
   *  Per-event USD — the event's own deposit value priced at current
   *  rates — comes attached by `classifyCompounds`, which prices it from
   *  the same `opts` this scan handed it. Computing it again here would
   *  be a second copy of that formula, free to drift from the one the
   *  unmanaged view sums.
   */
  const standaloneUsd = allCompounds.reduce((s, c) => s + (c.usdValue || 0), 0);
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
   *  Persist the compounded coins whenever the chain shows any, even
   *  with no standalone compound events — a position that only ever
   *  rebalanced still has fees that were re-deposited by the rebalance
   *  flow. The amounts decide, not their dollar value: a live price of
   *  zero would otherwise read as "nothing to save".
   */
  if (totalAmount0 > 0 || totalAmount1 > 0) {
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
       *  The event's own deposit value, not a share of the lifetime
       *  total: that total also carries rebalance-time fees, which
       *  belong to no compound event in this list.
       */
      usdValue: c.usdValue || 0,
      trigger: "historical",
    }));
    const nftCompoundedAmountsByTokenId = _compoundedAmountsByTokenId(
      history,
      opts.decimals0,
      opts.decimals1,
    );
    updateState({
      compoundHistory: history,
      compoundedAmount0: totalAmount0,
      compoundedAmount1: totalAmount1,
      nftGasWeiByTokenId,
      nftCompoundedAmountsByTokenId,
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
 * Resolve which lifetime figures are already saved. The lifetime HODL
 * amounts are in the pool's epoch cache. The compound and deposit totals
 * are in the position's config.
 * Extracted to keep `_scanLifetimePoolData` under the cyclomatic-complexity
 * cap.
 *
 * The lifetime scan keeps a saved total rather than recompute it:
 *
 *   1. **Compounded coins** (`hasCompoundData`).  Only
 *      `compoundedAmount0`/`compoundedAmount1` count.  This scan is the
 *      only thing that writes them: the unmanaged details path shows no
 *      Lifetime panel and so classifies nothing across the chain.
 *
 *      Requiring them is what makes the gate mean what it says.  The
 *      coins are the only thing Fees Compounded can be priced from, so
 *      a slot holding none has nothing to show and must re-classify,
 *      whatever else it holds.  `compoundHistory` in particular is not
 *      enough: it records the standalone compounds only, and a slot can
 *      carry it while carrying no coins — accept it here and that
 *      position reports zero compounded for as long as it runs.
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
 *      Re-scan Prices is the one caller that does ask for a
 *      re-classification (`_needsPriceRevalue`).  The amounts are right;
 *      what that action replaces is the historical prices the *other*
 *      lifetime figures were valued at.
 *
 *   2. **Lifetime deposit** (`hasDepositData`).  A positive
 *      `totalLifetimeDepositUsd` means an earlier scan already valued
 *      each deposit recorded in the lifetime HODL amounts.  Only a full
 *      rescan recomputes it.
 */
function _resolveDiskState(botState, epochKey) {
  const cachedHodl = epochKey
    ? _epochCache.getCachedLifetimeHodl(epochKey)
    : null;
  const get = botState._getConfig;
  /*- The coins, and only the coins. A saved dollar figure is true only
   *  at the price that computed it, so it is not what "already known"
   *  means; a config written before the coins existed has none, and
   *  re-classifies once from chain to get them.
   *
   *  `compoundHistory` does NOT count, though every bot scan writes it
   *  alongside the coins. It records the standalone compounds only, so
   *  a config carrying history but no coins is one written by the old
   *  model — exactly the case that must re-classify. Accepting it here
   *  would leave those positions with no coins to price and report
   *  every one of them as zero compounded. */
  const savedAmount0 = get ? get("compoundedAmount0") : undefined;
  const savedAmount1 = get ? get("compoundedAmount1") : undefined;
  const diskDeposit = get ? get("totalLifetimeDepositUsd") : undefined;
  const hasCompoundData = (savedAmount0 || 0) > 0 || (savedAmount1 || 0) > 0;
  const hasDepositData = (diskDeposit || 0) > 0;
  return { cachedHodl, hasCompoundData, hasDepositData };
}

/**
 * Build a logging-context bundle (symbols + tokenId + emoji) for a
 * position's scan log lines.
 *
 * @param {object} position  Live position.
 * @returns {{t0Sym: string, t1Sym: string, tokenIdStr: string,
 *   tokenEmoji: string}}
 */
function scanLogCtx(position) {
  const tokenIdStr = String(position.tokenId ?? "");
  return {
    t0Sym: position.token0Symbol || "Token0",
    t1Sym: position.token1Symbol || "Token1",
    tokenIdStr,
    tokenEmoji: emojiId(tokenIdStr),
  };
}

/**
 * Persist scan-success state on the bot and through the update channel.
 *
 * @param {object} botState   Per-position bot state.
 * @param {Function} updateState  State-update channel.
 * @param {object} ctx        Logging context from `scanLogCtx`.
 * @param {object} [served]   The requests this scan set out to answer,
 *   from `lifetimeScanPlan`. Only those are cleared: a rebalance or a
 *   Re-scan Prices that lands mid-scan is asking about a chain this scan
 *   never saw, so its request has to outlive the scan and be answered by
 *   the next one. Omitted, nothing is cleared.
 */
function _recordScanSuccess(botState, updateState, ctx, served = {}) {
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
    botState._lifetimeScanError = null;
    botState._lifetimeScanErrorAt = null;
    botState._catastrophicScanError = null;
    botState.lifetimeScanComplete = ready;
    const patch = {
      _lifetimeScanError: null,
      _lifetimeScanErrorAt: null,
      _catastrophicScanError: null,
      lifetimeScanComplete: ready,
    };
    /*- Each request is answered only if this scan carried it in. One that
     *  arrived while the scan was running describes a chain the scan did
     *  not read — clearing it would drop the work silently, and both the
     *  30-minute retry and the next poll's trigger look at these flags. */
    if (served.fullRescan === true) {
      botState._needsFullRescan = false;
      patch._needsFullRescan = false;
    }
    if (served.revalue === true) {
      botState._needsPriceRevalue = false;
      patch._needsPriceRevalue = false;
    }
    updateState(patch);
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
 * Whether every figure the lifetime scan computes is already saved.
 *
 * One read of the chain's events feeds three figures, each saved on its
 * own:
 *
 *   - lifetime HODL amounts  → `cachedHodl`
 *   - Fees Compounded        → `hasCompoundData`
 *   - Lifetime Deposit       → `hasDepositData`
 *
 * When all three are saved, the scan has nothing to compute and skips its
 * read (`lifetimeScanPlan`). When any one is missing, the scan reads every
 * NFT from its mint (`prepareLifetimeRead`) and computes the missing
 * figures from scratch.
 *
 * @param {object} state
 * @param {object|null} state.cachedHodl       Cached lifetime-HODL, if any.
 * @param {boolean} state.hasCompoundData      Disk holds a compound total.
 * @param {boolean} state.hasDepositData       Disk holds a deposit total.
 * @returns {boolean}  True when every figure is already saved.
 */
function lifetimeFiguresSaved({ cachedHodl, hasCompoundData, hasDepositData }) {
  return (
    cachedHodl !== undefined &&
    cachedHodl !== null &&
    hasCompoundData === true &&
    hasDepositData === true
  );
}

/**
 * The position's per-NFT resume buffer, created on first use.
 *
 * Same purpose as the buffer in `epoch-reconstructor.js`, for the
 * lifetime scan. The lifetime read succeeds or fails as a whole, but a
 * later step of the scan can still throw. The buffer keeps the retired
 * NFTs' histories, so the retry does not read them again. See
 * `fetchAllNftEvents` for why reuse is gated on the scan floor and on
 * the NFT being retired, and `_recordScanSuccess` for the release.
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
  /*-
   *  Tolerates a missing state object: with nowhere to carry reads, the
   *  caller gets a throwaway buffer and simply reads everything.
   */
  if (botState === undefined || botState === null) return new Map();
  /*-
   *  A full rescan means a rebalance fired, so any NFT in the chain may
   *  have emitted since the buffered read — the one it just retired
   *  certainly did. Start from nothing rather than trust a floor
   *  comparison to notice: both sides floor each NFT at the same block.
   */
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
 * Reconstruction needs each closed NFT's whole history, and
 * `prepareLifetimeRead` supplies it: every read starts from the pool's
 * creation block, lifted to the chain's first mint.
 * `test/bot-recorder-lifetime-share.test.js` pins that for every state.
 *
 * @param {object} botState  Live per-position bot state.
 * @param {object|null} epochKey  Epoch-cache key for the pool.
 * @returns {{needed: boolean, fullRescan: boolean, revalue: boolean,
 *   cachedHodl: object|null, hasCompoundData: boolean,
 *   hasDepositData: boolean}}
 */
function lifetimeScanPlan(botState, epochKey) {
  const fullRescan = botState?._needsFullRescan === true;
  const revalue = botState?._needsPriceRevalue === true;
  const disk = _resolveDiskState(botState, epochKey);
  /*-
   *  A rebalance sets `_needsFullRescan`. The scan then reads the chain
   *  even when every figure is saved, and recomputes the deposit total.
   *
   *  Re-scan Prices sets `_needsPriceRevalue`. Every dollar figure is
   *  then rebuilt at freshly fetched prices and written over the saved
   *  one. The figures stay on disk throughout: a scan that fails, or a
   *  price source that answers with nothing, leaves the old value in
   *  place rather than a gap another writer can fill.
   *
   *  The two are separate requests because they answer different
   *  questions. A rebalance says the chain changed, so amounts have to
   *  be re-derived; the prices behind the saved figures are fine.
   *  Re-scan Prices says a price was wrong, so the amounts stand and
   *  every figure built on them is re-priced. Folding either into the
   *  other would make every rebalance pay for price work, or make a bad
   *  price cost a walk of the chain.
   */
  const needed = fullRescan || revalue || !lifetimeFiguresSaved(disk);
  return { ...disk, fullRescan, revalue, needed };
}

/**
 * This position's lifetime chain read, prepared but not started.
 *
 * It always starts from the pool's creation block, lifted to the chain's
 * first mint, and reads each NFT from its own mint (`prepareChainRead`).
 * Its consumers compute from scratch, so they need each NFT's whole
 * history.
 *
 * Whether the resume buffer can be trusted is decided when the read runs,
 * so a full rescan flagged after preparation still discards the buffer.
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
      const { fullRescan } = lifetimeScanPlan(botState, epochKey);
      const fromBlock = await resolvePoolCreationBlockForPosition({
        factoryAddress: config.FACTORY,
        position,
      });
      const resumeBuffer = _lifetimeResumeBuffer(botState, fullRescan);
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
  const ctx = scanLogCtx(position);
  const plan = lifetimeScanPlan(botState, epochKey);
  const { fullRescan, revalue, cachedHodl, hasCompoundData, hasDepositData } =
    plan;
  if (!plan.needed) {
    /*-
     *  Nothing to compute, but readiness must still be recorded. Every
     *  pass starts by lowering `lifetimeScanComplete`, and only this
     *  function raises it. Skipping it here would leave a restart with
     *  every figure saved on "Syncing…" for good: the Lifetime panel
     *  blank, and the rescan timer firing every 30 minutes.
     */
    log.info(
      "[bot] %s/%s NFT #%s %s: Lifetime figures are already saved; no chain read needed",
      ctx.t0Sym,
      ctx.t1Sym,
      ctx.tokenIdStr,
      ctx.tokenEmoji,
    );
    _recordScanSuccess(botState, updateState, ctx, plan);
    return;
  }
  if (chainFound !== true) {
    /*-
     *  The chain is whatever the bot held before this pass, which on a
     *  cold start is nothing. Figures computed from it would cover the
     *  live NFT alone, and they would be saved as settled, which later
     *  passes keep. Readiness stays as the pass start lowered it, and the
     *  30-minute rescan retries the whole pass.
     */
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
    "[bot] %s/%s NFT #%s %s: Starting lifetime scan (fullRescan=%s priceRevalue=%s)",
    ctx.t0Sym,
    ctx.t1Sym,
    ctx.tokenIdStr,
    ctx.tokenEmoji,
    fullRescan,
    revalue,
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
    /*-
     *  The pass's shared read when epoch reconstruction already made it
     *  for this same chain, so the chain is read once; otherwise this
     *  scan's own.
     */
    const chainRead = chainReadFor(
      preparedRead,
      position,
      rebalanceEvents,
      () => prepareLifetimeRead(position, botState, rebalanceEvents, epochKey),
      ctx,
    );
    const allNftEvents = await chainRead.read();
    const prices = await _readCurrentPrices(position, revalue);
    const opts = {
      decimals0: position.decimals0,
      decimals1: position.decimals1,
      price0: prices.price0,
      price1: prices.price1,
      /*- Read by `computeDepositUsd`: a re-value reads past the cached
       *  historical price rather than re-reading the figure it is
       *  replacing. */
      refreshPrices: revalue,
      token0Symbol: position.token0Symbol || "Token0",
      token1Symbol: position.token1Symbol || "Token1",
      wallet: walletAddress,
      /*- NFT factory for the full-context log format (see
       *  feedback-log-full-context).  Without this, _logCompoundSummary
       *  would render the factory slot empty. */
      positionManagerAddress: config.POSITION_MANAGER,
    };
    const ids = chainRead.ids;
    if (!hasCompoundData || revalue)
      await _classifyAllCompounds(
        ids,
        allNftEvents,
        opts,
        updateState,
        pnlTracker,
      );
    /*-
     *  A rebalance mints with the wallet's whole balance of both pool
     *  tokens (`src/rebalancer.js`, steps 5 and 7), so anything that
     *  arrived in the wallet since the previous mint goes into the new
     *  NFT. That is a deposit, and only this step counts one: it scans
     *  the wallet's transfers between the two mints. Skip it after a
     *  rebalance and the swept-in money stays out of the lifetime HODL
     *  and out of Total Lifetime Deposit until a Reload, so the Lifetime
     *  panel reads it as a gain rather than as money put in.
     *
     *  The cost is one window, not the chain: `computeAndCacheHodl` hands
     *  the saved windows back to the computation, which scans only mints
     *  above the last one it already covered.
     */
    if (!cachedHodl || fullRescan) {
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
     *  A saved deposit total is kept unless a rebalance forced this scan
     *  (see `_resolveDiskState` JSDoc, item 2), or Re-scan Prices asked
     *  for the historical prices behind it to be fetched again.
     */
    if (!hasDepositData || fullRescan || revalue) {
      const priceDeposits = () =>
        computeDepositUsd(botState, updateState, position, opts, epochKey);
      await _withFreshPrices(revalue, priceDeposits);
    }
    if (revalue) {
      const mintBlock = _mintBlockOf(allNftEvents, position.tokenId);
      const priceMint = () =>
        revalueHodlBaseline(
          botState,
          updateState,
          position,
          mintBlock,
          epochKey,
        );
      await withFreshPricesAllowed(priceMint);
    }
    _recordScanSuccess(botState, updateState, ctx, plan);
  } catch (err) {
    _recordScanFailure(botState, updateState, err, ctx);
  }
}

module.exports = {
  lifetimeFiguresSaved,
  lifetimeScanPlan,
  prepareLifetimeRead,
  scanLogCtx,
  _applyCompoundGas,
  _classifyAllCompounds,
  _scanLifetimePoolData,
  _recordScanFailure, // exported for tests
  _recordScanSuccess, // exported for tests
  _mintBlockOf, // exported for tests
  _lifetimeResumeBuffer, // exported for tests
  _resolveDiskState, // exported for tests
};
