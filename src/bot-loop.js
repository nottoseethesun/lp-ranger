/**
 * @file src/bot-loop.js
 * @module bot-loop
 * @description
 * Shared reusable bot logic for the 9mm v3 Position Manager.
 * Used by both `server.js` (unified mode) and `bot.js` (headless mode).
 *
 * Exports:
 *   - `startBotLoop(opts)` — create provider/signer, detect position, start polling
 *   - `pollCycle(deps)` — single poll iteration
 *   - `appendLog(result)` — write rebalance result to disk log
 *
 * The private-key resolver lives in `./bot-private-key`; callers
 * (bot.js, tests) import it directly from there.
 *
 * RPC providers are owned by `src/send-transaction.js` — call
 * `sendTx.init` + `sendTx.ensureReachable` at boot and use
 * `sendTx.getManagedReadProvider()` for all read access.
 */

"use strict";
const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const { createThrottle } = require("./throttle");
const { emojiId } = require("./logger");
const {
  overridePnlWithRealValues: _overridePnlWithRealValues,
} = require("./bot-pnl-updater");
const { initHodlBaseline } = require("./hodl-baseline");
const { appendToPoolCache } = require("./pool-scanner");
const { createResidualTracker } = require("./residual-tracker");
const sendTx = require("./send-transaction");
const { createFailoverSigner } = require("./nonce-manager-wrapper");
const {
  appendLog,
  _scanAndReconstruct,
  _activePosSummary,
} = require("./bot-recorder");
const { notify: _notify } = require("./telegram-notifications/telegram");
const { checkGasBalance } = require("./gas-monitor");
const { pollCycle, _reloadFromConfig, _humanizeError } = require("./bot-cycle");
const { applyCurrentNftFigures } = require("./bot-pnl-current-nft");
const { wireBotStateGetConfig } = require("./bot-state-init");
const {
  _detectPosition,
  _initPnlTracker,
  _tryInitPnlTracker,
} = require("./bot-loop-detect");

/**
 * Start the bot polling loop.  Creates provider, signer, detects position,
 * and begins periodic polling.
 *
 * @param {object} opts
 * @param {string}   opts.privateKey       Hex private key.
 * @param {boolean}  [opts.dryRun]         Dry-run mode (default: config.DRY_RUN).
 * @param {Function} opts.updateBotState   Callback to update shared bot state.
 * @param {object}   opts.botState         Shared bot state object for runtime params.
 * @param {object}   [opts.ethersLib]      Injected ethers (for testing).
 * @param {string}   [opts.positionId]     NFT token ID to manage (overrides config).
 * @param {Function} [opts.onRetire]       Called with (tokenId) when the bot loop
 *   auto-retires a drained position.  Caller flips diskConfig status to
 *   'stopped' and removes the entry from the position manager.  The bot
 *   loop has already stopped its own timer + set running=false by the
 *   time this fires.
 * @returns {Promise<{ stop: Function }>}  Handle with stop() method.
 */
async function startBotLoop(opts) {
  const { privateKey, updateBotState, botState } = opts;
  const gc = wireBotStateGetConfig(botState, opts);
  const dryRun = opts.dryRun ?? config.DRY_RUN,
    ethersLib = opts.ethersLib || ethers;
  if (dryRun)
    log.info(
      "\n  ┌──────────────────────────────────────────────┐\n  │  DRY RUN MODE — no transactions will be sent │\n  └──────────────────────────────────────────────┘\n",
    );
  /*- Shared {provider, signer, address} wins when the caller passes one
   *  in.  Production callers (server-positions, bot.js) fetch the
   *  singleton from positionMgr.getSharedSigner so every managed
   *  position signs through the SAME NonceManager — drifted per-position
   *  nonce counters were the root cause of the 2026-04-24 "nonce too
   *  low" storm.  Tests that don't need shared-signer semantics fall
   *  through to the inline branch below. */
  let provider, signer, address;
  if (opts.provider && opts.signer) {
    provider = opts.provider;
    signer = opts.signer;
    address = opts.address || (await signer.getAddress());
  } else {
    /*- Bring up the send-transaction module's primary + fallback
        providers from chain config before constructing the signer.
        FailoverNonceManager consults sendTx.getCurrentRPC() lazily on
        every call, so the inner ethers.NonceManager rebinds when the
        active RPC flips.  ensureReachable() probes the primary and
        engages failoverToNextRPC() if it's already down at boot, so
        the read-side managed provider and the TX side both follow
        the same active-RPC selection. */
    sendTx.init(
      { primary: config.RPC_URL, fallback: config.RPC_URL_FALLBACK },
      ethersLib,
    );
    await sendTx.ensureReachable();
    provider = sendTx.getManagedReadProvider();
    /*- IMPORTANT: wrap the wallet in NonceManager so concurrent
     *  sendTransaction calls (e.g. Promise.all on two approve TXs) get
     *  sequential nonces from a local counter instead of racing the
     *  RPC.  Never bypass this — do not call getNonce() or
     *  getTransactionCount() to manually manage nonces. */
    const _baseWallet =
      dryRun && !privateKey
        ? ethersLib.Wallet.createRandom().connect(provider)
        : new ethersLib.Wallet(privateKey, provider);
    signer = createFailoverSigner(_baseWallet, { ethersLib });
    address = await signer.getAddress();
  }
  if (dryRun && !privateKey)
    log.info(`[bot] DRY RUN — using random address: ${address}`);
  log.info(`[bot] Wallet: ${address}`);
  /*- `provider` is the managed-read provider when we built the wallet
   *  ourselves above; for test paths it's whatever was injected.  Either
   *  way it handles its own failover, so the per-attempt callbacks
   *  are no longer needed at this call site. */
  const position = await _detectPosition(
    provider,
    address,
    opts.positionId || config.POSITION_ID || undefined,
  );
  log.info(
    `[bot] Managing NFT #${position.tokenId} ${emojiId(position.tokenId)} (${position.token0}/${position.token1} fee=${position.fee})`,
  );

  const pnlTracker = await _tryInitPnlTracker(
    provider,
    ethersLib,
    position,
    botState,
    updateBotState,
    address,
  );

  const residualTracker = createResidualTracker();
  if (botState.residuals) residualTracker.deserialize(botState.residuals);
  initHodlBaseline(
    provider,
    ethersLib,
    position,
    botState,
    updateBotState,
  ).catch((err) =>
    log.warn("[bot] HODL baseline background error:", err.message),
  );
  const throttle = createThrottle({
    minIntervalMs: config.MIN_REBALANCE_INTERVAL_MIN * 60_000,
    dailyMax: config.MAX_REBALANCES_PER_DAY,
  });
  const rebalanceEvents = [];
  updateBotState({
    running: true,
    dryRun,
    startedAt: new Date().toISOString(),
    throttleState: throttle.getState(),
    rebalanceEvents,
    walletAddress: address,
    activePosition: _activePosSummary(position),
  });

  let collectedFeesUsd = botState.collectedFeesUsd || 0,
    rebalanceCount = 0,
    firstFailureAt = null,
    midwayRetryCount = 0,
    polling = false,
    _stopped = false;
  const GAS_DEFER_MS = 3600_000;
  let currentIntervalMs = config.CHECK_INTERVAL_SEC * 1000,
    timer = null,
    /*- Set by `botState._kickPoll()` when a poll is in-flight; the
     *  in-flight poll's tail `_scheduleNext(…)` reads and clears it,
     *  so the NEXT poll fires immediately instead of waiting a full
     *  CHECK_INTERVAL_SEC.  Used by the manual Rebalance / Compound
     *  API handlers (server.js) so the user's click actually
     *  translates to on-chain action within seconds, not up to
     *  ~5 minutes of "waiting for the next scheduled poll". */
    pendingKick = false;
  function _scheduleNext(ms) {
    clearTimeout(timer);
    const delay = pendingKick ? 0 : (ms ?? currentIntervalMs);
    pendingKick = false;
    timer = setTimeout(poll, delay);
  }

  /*- Wake up the poll loop immediately.  Called by the manual
   *  Rebalance / Compound endpoints (server.js) right after they set
   *  `state.forceRebalance = true` / `state.forceCompound = true` so
   *  the flag actually gets picked up on the next tick instead of
   *  waiting for the timer-driven poll.  Two cases:
   *    - Poll idle: cancel the pending timer and fire poll(0).
   *    - Poll in-flight: leave the current run alone (its decision
   *      was already made from a stale snapshot of the flags), but
   *      set `pendingKick` so the tail `_scheduleNext(…)` fires the
   *      NEXT poll at 0 ms.  The just-set flag WILL be seen by that
   *      next poll. */
  botState._kickPoll = () => {
    if (_stopped) return;
    if (polling) {
      pendingKick = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(poll, 0);
  };

  function _handleError(result) {
    if (!firstFailureAt) firstFailureAt = Date.now();
    const errMsg = _humanizeError(result.error);
    const isMidway = BigInt(position.liquidity || 0) === 0n;
    if (isMidway) midwayRetryCount++;
    const midwayExhausted = isMidway && midwayRetryCount >= 4;
    log.error(
      "[bot] Rebalance failed: %s (%dm of failures%s)",
      errMsg,
      Math.round((Date.now() - firstFailureAt) / 60_000),
      isMidway ? `, mid-rebalance retry ${midwayRetryCount}/4` : "",
    );
    /*- Re-open-attempt path: when the rebalance started with a drained
     *  NFT (user clicked Manage on an auto-retired closed position,
     *  bot-cycle.js's `_executeAndRecord` sets the
     *  `_rebalanceStartedDrained` flag), any failure means we should
     *  IMMEDIATELY put the position back where it was — closed +
     *  auto-retired + not managed — rather than leave it stuck in a
     *  30-min drain-timer limbo while the user wonders why nothing
     *  is happening.  Signal an immediate retire on the next poll;
     *  drain.js consumes `_retireImmediately` and fires the existing
     *  retire path (onRetire → status=stopped → bot loop stops →
     *  state deleted → dashboard reflects closed/not-managed).  No
     *  midwayFail / paused — those states would block the retire
     *  path or stay sticky in the UI. */
    if (botState._rebalanceStartedDrained) {
      log.info(
        "[bot] Re-open attempt for #%s failed — retiring in %ds (dashboard-poll window for alert)",
        position.tokenId,
        Math.round(config.GUARANTEED_DASHBOARD_HAS_POLLED_MS / 1000),
      );
      /*- Set `rebalancePaused: true` so the dashboard's per-position
       *  alert modal fires (`dashboard-alerts.js` `_showErrModal`
       *  gates on `rebalancePaused`).  Without this the user never
       *  sees what failed. */
      updateBotState({
        rebalanceError: errMsg,
        rebalancePaused: true,
        rebalanceFailedMidway: false,
      });
      log.info(
        "[bot] _handleError: rebalancePaused=true set for #%s, scheduling retire in %dms",
        position.tokenId,
        config.GUARANTEED_DASHBOARD_HAS_POLLED_MS,
      );
      /*- Delay the actual retire by `config.GUARANTEED_DASHBOARD_HAS_POLLED_MS` so the
       *  dashboard (3 s poll) reliably catches the paused state and
       *  fires the alert modal across multiple polls.  Without this
       *  delay the bot's startup-scan-triggered retire can fire
       *  within 2 s of the failure, narrower than one poll cycle, and
       *  the alert is missed on the second / N-th attempt where the
       *  scan cache is warm and the bot starts faster.  Direct call
       *  to `_handleRetire` rather than waiting for drain.js's
       *  `_retireImmediately` poll path so retire fires exactly when
       *  the delay elapses, regardless of bot-poll interval.  Bails
       *  if the user took action during the wait (slippage change
       *  clears rebalancePaused; Manage click sets forceRebalance).  */
      setTimeout(() => {
        if (_stopped) {
          log.info(
            "[bot] Re-open retire timer: #%s already stopped — skip",
            position.tokenId,
          );
          return;
        }
        if (!botState.rebalancePaused) {
          log.info(
            "[bot] Re-open retire timer: #%s no longer paused (slippage cleared?) — skip",
            position.tokenId,
          );
          return;
        }
        if (botState.forceRebalance) {
          log.info(
            "[bot] Re-open retire timer: #%s forceRebalance set (user retried) — skip",
            position.tokenId,
          );
          return;
        }
        log.info(
          "[bot] Re-open retire delay elapsed (%dms) — auto-retiring #%s",
          config.GUARANTEED_DASHBOARD_HAS_POLLED_MS,
          position.tokenId,
        );
        _handleRetire(0).catch((err) =>
          log.warn("[bot] Re-open retire error: %s", err.message),
        );
      }, config.GUARANTEED_DASHBOARD_HAS_POLLED_MS);
      return;
    }
    const isSwapAbort = /swap aborted/i.test(errMsg);
    const paused = isSwapAbort || midwayExhausted;
    const displayErr = midwayExhausted
      ? "Mid-rebalance recovery failed after 4 attempts: " + errMsg
      : errMsg;
    updateBotState({
      rebalanceError: displayErr,
      rebalancePaused: paused,
      rebalanceFailedMidway: isMidway && !midwayExhausted,
    });
  }

  function _handleRecovery() {
    const oorMin = Math.round((Date.now() - firstFailureAt) / 60_000);
    log.info(
      `[bot] Price returned to range after ~${oorMin}m of failures — clearing`,
    );
    firstFailureAt = null;
    midwayRetryCount = 0;
    currentIntervalMs =
      (gc("checkIntervalSec") || config.CHECK_INTERVAL_SEC) * 1000;
    updateBotState({
      rebalanceError: null,
      rebalancePaused: false,
      rebalanceFailedMidway: false,
      oorRecoveredMin: oorMin,
    });
    setTimeout(() => updateBotState({ oorRecoveredMin: 0 }), 5000);
  }

  function _checkGas() {
    /*- alertState is intentionally omitted — gas is a wallet-level
     *  concern, so gas-monitor maintains a shared alertState keyed by
     *  address.  All managed positions polling in parallel will see the
     *  same flags and only the first will fire a notification per
     *  tier-transition. */
    checkGasBalance({
      provider,
      address,
      position,
      getPositionCount: opts.getPositionCount || (() => 1),
    }).catch(() => {});
  }

  function _handleRebalanceSuccess(result) {
    rebalanceCount++;
    firstFailureAt = null;
    midwayRetryCount = 0;
    currentIntervalMs =
      (gc("checkIntervalSec") || config.CHECK_INTERVAL_SEC) * 1000;
    appendToPoolCache(position, address, result).catch(() => {});
    updateBotState({
      rebalanceError: null,
      rebalancePaused: false,
      rebalanceFailedMidway: false,
      activePosition: _activePosSummary(position),
      throttleState: throttle.getState(),
    });
    if (botState.rangeRounded)
      setTimeout(() => updateBotState({ rangeRounded: null }), 5000);
    /*- Same 5s clear for residualWarning: the dashboard dedupes by
     *  the `at` timestamp, so showing it once then clearing server-side
     *  prevents stale warnings from re-triggering on future `/api/status`
     *  polls after the user has already dismissed the modal. */
    if (botState.residualWarning)
      setTimeout(() => updateBotState({ residualWarning: null }), 5000);
  }

  /* Dispatch pollCycle result to the appropriate branch handler. */
  function _processPollResult(result) {
    if (result.rebalanced) {
      _handleRebalanceSuccess(result);
    } else if (result.gasDeferred) {
      currentIntervalMs = GAS_DEFER_MS;
      log.info(`[bot] Next retry in ${GAS_DEFER_MS / 60_000}m (gas deferral)`);
    } else if (result.error) {
      _handleError(result);
    } else if (result.pollError) {
      /*- Pool-state RPC hiccup — already logged by pollCycle.  Do NOT
       *  set firstFailureAt or touch recovery state: a transient RPC
       *  timeout is not a rebalance attempt, so treating it as one
       *  would fire a spurious "Position Recovered" modal on the next
       *  successful poll (most visible on full-range positions that
       *  can never actually go OOR). */
    } else if (
      firstFailureAt &&
      !result.paused &&
      !result.retired &&
      !botState.rebalanceFailedMidway &&
      !botState.rebalancePaused
    ) {
      /*- `!result.retired` guard: when the retire path fires, the
       *  result has `retired: true` but no error / rebalanced fields,
       *  which would otherwise fall through here and log a misleading
       *  "Price returned to range" message right before the retire.
       *
       *  `!botState.rebalancePaused` guard: pollCycle's
       *  `_isAbortedDrained` short-circuit returns `{rebalanced:
       *  false}` with no `paused` flag on the result (the gate-based
       *  paused flag is only set when `_checkRebalanceGates` returns
       *  early — bypassed here).  Without this check, the recovery
       *  branch fires for a paused-and-aborted position on the very
       *  next poll, clearing the `rebalancePaused` flag — which then
       *  defeats `setTimeout`'s `if (!botState.rebalancePaused)
       *  return` guard, skipping the scheduled retire and leaving the
       *  position stuck "running" with no retire and no progress. */
      _handleRecovery();
    }
  }

  /*- Stop the loop, fire the optional server-side retirement callback,
   *  and mark the bot state accordingly. Called from `poll` when
   *  pollCycle reports that a drained position has exceeded the
   *  retirement window.  The NFT is not burned — this is a pure
   *  software state flip; the user can re-manage it from the
   *  dashboard at any time. */
  async function _handleRetire(drainedForMs) {
    log.info(
      "[bot] Retiring drained position #%s (no tx in flight)",
      position.tokenId,
    );
    _stopped = true;
    clearTimeout(timer);
    /*- `lastRetiredAt` is a numeric epoch (ms) consumed by the
     *  dashboard's Manage-button compute (`public/dashboard-manage-ui.js`)
     *  for its post-retire debounce window — the button stays disabled
     *  for ~7.5s after retire so the alert modal has time to render before
     *  the button re-enables.  Separate from the human-readable
     *  `retiredAt` ISO string because the dashboard's compute is pure
     *  Date.now() arithmetic and `new Date(iso).getTime()` adds parse
     *  cost on every poll/render.  Transient signal: NOT persisted to
     *  disk (drops to undefined on server restart, which is harmless —
     *  the dashboard simply skips the debounce branch). */
    updateBotState({
      running: false,
      retired: true,
      retiredAt: new Date().toISOString(),
      lastRetiredAt: Date.now(),
      drainedForMs: drainedForMs || null,
    });
    if (opts.onRetire) {
      try {
        await opts.onRetire(position.tokenId);
      } catch (err) {
        log.warn("[bot] onRetire callback error: %s", err.message);
      }
    }
  }

  const poll = async () => {
    /*- Defensive halt check: if stop() ran while a previously scheduled
     *  poll was queued (or after a tail-call _scheduleNext lost the race
     *  against stop's clearTimeout), drop this invocation.  Without this,
     *  a position removed from the LP Browser could still fire one more
     *  poll — including the 60-min gas-defer retry. */
    if (_stopped) return;
    if (polling) return;
    polling = true;
    _reloadFromConfig(gc, throttle, (ms) => {
      currentIntervalMs = ms;
    });
    /* Set when a special action (rebalance/compound/nonce-cancel) completed
     * this cycle — triggers a fast follow-up poll so the dashboard KPIs
     * refresh immediately instead of waiting CHECK_INTERVAL_SEC. */
    let specialActionCompleted = false;
    let retireRequest = null;
    try {
      const result = await pollCycle({
        signer,
        provider,
        address,
        position,
        throttle,
        dryRun,
        updateBotState,
        _rebalanceCount: rebalanceCount,
        _botState: botState,
        _pnlTracker: pnlTracker,
        _rebalanceEvents: rebalanceEvents,
        _collectedFeesUsd: collectedFeesUsd,
        _addCollectedFees: (usd) => {
          collectedFeesUsd += usd;
          updateBotState({ collectedFeesUsd });
        },
        _residualTracker: residualTracker,
        _getTokenPositionAmounts: botState._getTokenPositionAmounts || null,
        _getConfig: gc,
        _poolKey: botState._poolKey || null,
        _recordPoolRebalance: botState._recordPoolRebalance || null,
        _canRebalancePool: botState._canRebalancePool || null,
        _applyCurrentNftFigures: applyCurrentNftFigures,
      });
      if (result.rebalanced || result.cancelled || result.compounded)
        specialActionCompleted = true;
      if (result.retired) retireRequest = result;
      _processPollResult(result);
    } catch (err) {
      if (!firstFailureAt) firstFailureAt = Date.now();
      log.error(
        `[bot] Poll error: ${err.message} (${Math.round((Date.now() - firstFailureAt) / 60_000)}m of failures)`,
      );
      _notify("otherError", {
        position: {
          tokenId: position.tokenId,
          fee: position.fee,
          token0: position.token0,
          token1: position.token1,
        },
        error: err.message,
      });
    } finally {
      polling = false;
    }
    if (retireRequest) {
      await _handleRetire(retireRequest.drainedForMs);
      return;
    }
    _checkGas();
    // Honor queued position switch (requested while rebalance was in progress)
    if (botState.pendingSwitch) {
      log.info("[bot] Honoring queued switch to #%s", botState.pendingSwitch);
      _stopped = true;
      clearTimeout(timer);
      updateBotState({ running: false });
      return;
    }
    /*- If stop() ran while this poll was in flight, do not reschedule.
     *  Otherwise the tail _scheduleNext call below would overwrite the
     *  clearTimeout that stop() performed, and the loop would resurrect
     *  itself for one more cycle (most visibly: another 60-min gas-defer
     *  retry after the user clicked Remove). */
    if (_stopped) return;
    /* After a completed special action, poll again in ~2s so the dashboard
     * KPI numbers refresh promptly instead of waiting CHECK_INTERVAL_SEC.
     * Works for both user-triggered and auto-triggered actions. */
    _scheduleNext(specialActionCompleted ? 2000 : undefined);
  };

  await poll(); // First poll — gives the dashboard current position data
  log.info(`[bot] Polling every ${config.CHECK_INTERVAL_SEC}s`);

  // Lazy scan: expose _triggerScan for on-demand invocation
  botState._triggerScan = async () => {
    if (botState._scanRunning) return;
    botState._scanRunning = true;
    try {
      clearTimeout(timer);
      await _scanAndReconstruct(
        provider,
        ethersLib,
        address,
        position,
        null,
        rebalanceEvents,
        updateBotState,
        throttle,
        pnlTracker,
        botState,
        pnlTracker?._epochKey,
      );
      await poll();
    } finally {
      botState._scanRunning = false;
    }
  };

  if (opts.eagerScan !== false) {
    await botState._triggerScan();
  } else {
    /*- Always fire a background event scan on startup so newly-started
     *  positions pick up on-chain rebalance events that aren't yet in
     *  the local cache (e.g. a rebalance that happened on a different
     *  machine). _scanHistory sets rebalanceScanComplete=false at start
     *  and _scanAndReconstruct flips it to true on completion, so the
     *  Sync badge shows "Syncing…" during the scan and "Synced" after. */
    botState._triggerScan();
    _scheduleNext();
  }
  /*- Lifetime-deposit recovery loop: every 30 min, re-trigger the scan
   *  if recovery is needed.  Three independent conditions, ANY of which
   *  warrants a rescan:
   *
   *    1. `totalLifetimeDepositUsd <= 0` — the scan-total is missing
   *       entirely (e.g. because the startup scan failed silently while
   *       Moralis quota was exhausted, or no scan has ever succeeded).
   *
   *    2. `_needsFullRescan === true` — a rebalance fired and set the
   *       "re-classify the chain" flag, but the follow-up `_triggerScan`
   *       (bot-cycle.js:160) ran into a silent failure in
   *       `_scanLifetimePoolData` and the flag is still set.  Without
   *       this gate condition the loop would early-return because the
   *       PRIOR scan's `totalLifetimeDepositUsd` is still positive
   *       (PR #134 changed the rebalance path to preserve in-memory
   *       totals instead of zeroing them — the previous auto-rescan
   *       gate that only checked `total > 0` no longer matches).
   *
   *    3. `lifetimeScanComplete === false` — covers the same window as
   *       (2) but from the dashboard-readiness flag's perspective.
   *       Belt-and-suspenders against any future failure path that
   *       lowers the readiness flag without setting `_needsFullRescan`.
   *
   *  The `_scanRunning` guard inside `_triggerScan` prevents overlap
   *  with any scan already in flight.  See bot-recorder-lifetime.js for
   *  the `_lifetimeScanError` flag and bot-recorder.js for the
   *  `_needsFullRescan` setter this complements. */
  const LIFETIME_RESCAN_CHECK_MS = 30 * 60 * 1000;
  const lifetimeRescanTimer = setInterval(() => {
    if (_stopped) return;
    if (botState._scanRunning) return;
    const total = botState.totalLifetimeDepositUsd || 0;
    const needsRescan =
      botState._needsFullRescan === true ||
      botState.lifetimeScanComplete === false;
    if (total > 0 && !needsRescan) return;
    const tokenIdStr = String(position.tokenId || "");
    const reason = needsRescan
      ? "needsFullRescan=" +
        !!botState._needsFullRescan +
        " lifetimeScanComplete=" +
        !!botState.lifetimeScanComplete
      : "deposit-total=$0";
    log.info(
      "[bot] %s/%s NFT #%s %s: Auto-rescanning lifetime (%s, lastError=%s)",
      position.token0Symbol || "Token0",
      position.token1Symbol || "Token1",
      tokenIdStr,
      emojiId(tokenIdStr),
      reason,
      botState._lifetimeScanError || "none",
    );
    botState._triggerScan?.();
  }, LIFETIME_RESCAN_CHECK_MS);
  return {
    stop() {
      if (_stopped) return Promise.resolve();
      _stopped = true;
      clearTimeout(timer);
      clearInterval(lifetimeRescanTimer);
      updateBotState({ running: false });
      log.info("[bot] Bot loop stopped");
      if (!polling) return Promise.resolve();
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (!polling) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });
    },
  };
}

module.exports = {
  pollCycle,
  appendLog,
  startBotLoop,
  _overridePnlWithRealValues,
  _initPnlTracker,
  _detectPosition,
  _tryInitPnlTracker,
};
