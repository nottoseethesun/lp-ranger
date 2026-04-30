/**
 * @file src/bot-loop.js
 * @module bot-loop
 * @description
 * Shared reusable bot logic for the 9mm v3 Position Manager.
 * Used by both `server.js` (unified mode) and `bot.js` (headless mode).
 *
 * Exports:
 *   - `resolvePrivateKey(opts)` — resolve a private key from env, key-file, or wallet-manager
 *   - `startBotLoop(opts)` — create provider/signer, detect position, start polling
 *   - `pollCycle(deps)` — single poll iteration
 *   - `appendLog(result)` — write rebalance result to disk log
 *   - `createProviderWithFallback(primary, fallback, ethersLib)` — RPC with fallback
 */

"use strict";
const ethers = require("ethers");
const config = require("./config");
const { getCachedEpochs, getCachedLifetimeHodl } = require("./epoch-cache");
const rangeMath = require("./range-math");
const { createThrottle } = require("./throttle");
const { emojiId } = require("./logger");
const { detectPositionType } = require("./position-detector");
const { getPoolState } = require("./rebalancer");
const { createPnlTracker } = require("./pnl-tracker");
const {
  positionValueUsd: _positionValueUsd,
  fetchTokenPrices: _fetchTokenPrices,
  overridePnlWithRealValues: _overridePnlWithRealValues,
} = require("./bot-pnl-updater");
const { initHodlBaseline } = require("./hodl-baseline");
const { appendToPoolCache } = require("./pool-scanner");
const { createResidualTracker } = require("./residual-tracker");
const { createProviderWithFallback } = require("./bot-provider");
const sendTx = require("./send-transaction");
const { createFailoverSigner } = require("./nonce-manager-wrapper");
const {
  appendLog,
  _scanAndReconstruct,
  _activePosSummary,
} = require("./bot-recorder");
const { notify: _notify } = require("./telegram");
const { checkGasBalance } = require("./gas-monitor");
const {
  pollCycle,
  resolvePrivateKey,
  _reloadFromConfig,
  _humanizeError,
} = require("./bot-cycle");

/** Initialize or restore the P&L tracker with epoch data. */
function _initPnlTracker(
  ev,
  botState,
  poolState,
  lowerPrice,
  upperPrice,
  price0,
  price1,
  position,
  walletAddress,
) {
  const tracker = createPnlTracker({ initialDeposit: ev });
  const wallet = walletAddress || botState.walletAddress;
  const _epochKey = position
    ? {
        contract: config.POSITION_MANAGER,
        wallet,
        token0: position.token0,
        token1: position.token1,
        fee: position.fee,
      }
    : null;
  const cached = _epochKey ? getCachedEpochs(_epochKey) : null;
  if (cached) {
    tracker.restore(cached);
    console.log(
      "[bot] Restored P&L epochs from cache (%d closed)",
      cached.closedEpochs?.length,
    );
  } else {
    tracker.openEpoch({
      entryValue: ev,
      entryPrice: poolState.price,
      lowerPrice,
      upperPrice,
      token0UsdPrice: price0,
      token1UsdPrice: price1,
    });
  }
  const cachedHodl = _epochKey ? getCachedLifetimeHodl(_epochKey) : null;
  if (cachedHodl) botState.lifetimeHodlAmounts = cachedHodl;
  console.log(
    `[bot] P&L tracker initialized (T0=$${price0.toFixed(6)}, T1=$${price1.toFixed(6)})`,
  );
  return { tracker, epochKey: _epochKey };
}

/**
 * Detect and select the target NFT position from on-chain data.
 * @param {object} provider   ethers provider.
 * @param {string} address    Wallet address.
 * @param {string} [targetId] Specific NFT token ID to select.
 * @returns {Promise<object>}  Selected position data.
 */
async function _detectPosition(provider, address, targetId) {
  const detection = await detectPositionType(provider, {
    walletAddress: address,
    positionManagerAddress: config.POSITION_MANAGER,
    tokenId: targetId,
    candidateAddress: config.ERC20_POSITION_ADDRESS || undefined,
  });
  if (detection.type !== "nft" || !detection.nftPositions?.length)
    throw new Error(
      "No V3 NFT position found. This tool only supports V3 positions.",
    );
  const valid = detection.nftPositions.filter((p) => p.fee && p.fee > 0);
  if (!valid.length)
    throw new Error("No positions with a valid V3 fee tier found.");
  console.log(
    "[bot] _detectPosition: targetId=%s, found %d valid NFTs: %s",
    targetId || "none",
    valid.length,
    valid
      .map((p) => `#${p.tokenId}(liq=${String(p.liquidity).slice(0, 8)})`)
      .join(", "),
  );
  if (targetId) {
    const m = valid.find((p) => String(p.tokenId) === String(targetId));
    console.log(
      "[bot] _detectPosition: targetId match=%s",
      m ? `#${m.tokenId}` : "MISS→fallback",
    );
    return m || valid[0];
  }
  const active = valid.filter((p) => BigInt(p.liquidity || 0n) > 0n);
  const picked =
    active.length > 0
      ? active.reduce((best, p) =>
          BigInt(p.liquidity || 0n) > BigInt(best.liquidity || 0n) ? p : best,
        )
      : valid.reduce((best, p) =>
          BigInt(p.tokenId) > BigInt(best.tokenId) ? p : best,
        );
  console.log(
    "[bot] _detectPosition: picked #%s (active=%d, total=%d)",
    picked.tokenId,
    active.length,
    valid.length,
  );
  return picked;
}

/** Initialize P&L tracker from token prices. Returns null if prices unavailable. */
async function _tryInitPnlTracker(
  provider,
  ethersLib,
  position,
  botState,
  updateBotState,
  walletAddress,
) {
  try {
    const { price0, price1 } = await _fetchTokenPrices(
      position.token0,
      position.token1,
    );
    if (price0 > 0 || price1 > 0) {
      const ps = await getPoolState(provider, ethersLib, {
        factoryAddress: config.FACTORY,
        token0: position.token0,
        token1: position.token1,
        fee: position.fee,
      });
      // Cache decimals on position so downstream scans don't need pool state
      position.decimals0 = ps.decimals0;
      position.decimals1 = ps.decimals1;
      const lp = rangeMath.tickToPrice(
        position.tickLower,
        ps.decimals0,
        ps.decimals1,
      );
      const up = rangeMath.tickToPrice(
        position.tickUpper,
        ps.decimals0,
        ps.decimals1,
      );
      const { tracker: t, epochKey: ek } = _initPnlTracker(
        _positionValueUsd(position, ps, price0, price1) || 1,
        botState,
        ps,
        lp,
        up,
        price0,
        price1,
        position,
        walletAddress,
      );
      updateBotState({ pnlEpochs: t.serialize() });
      t._epochKey = ek;
      return t;
    }
    console.warn("[bot] Could not fetch token prices — P&L tracking disabled");
  } catch (err) {
    console.warn("[bot] P&L tracker init error:", err.message);
  }
  return null;
}

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
  const gc = opts.getConfig || (() => undefined);
  const dryRun = opts.dryRun ?? config.DRY_RUN,
    ethersLib = opts.ethersLib || ethers;
  if (dryRun)
    console.log(
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
        active RPC flips. */
    sendTx.init(config.CHAIN.rpc, ethersLib);
    provider = await createProviderWithFallback(
      config.RPC_URL,
      config.RPC_URL_FALLBACK,
      ethersLib,
    );
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
    console.log(`[bot] DRY RUN — using random address: ${address}`);
  console.log(`[bot] Wallet: ${address}`);
  const position = await _detectPosition(
    provider,
    address,
    opts.positionId || config.POSITION_ID || undefined,
  );
  console.log(
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
    console.warn("[bot] HODL baseline background error:", err.message),
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
    timer = null;
  function _scheduleNext(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms ?? currentIntervalMs);
  }

  function _handleError(result) {
    if (!firstFailureAt) firstFailureAt = Date.now();
    const errMsg = _humanizeError(result.error);
    const isMidway = BigInt(position.liquidity || 0) === 0n;
    if (isMidway) midwayRetryCount++;
    const midwayExhausted = isMidway && midwayRetryCount >= 4;
    console.error(
      "[bot] Rebalance failed: %s (%dm of failures%s)",
      errMsg,
      Math.round((Date.now() - firstFailureAt) / 60_000),
      isMidway ? `, mid-rebalance retry ${midwayRetryCount}/4` : "",
    );
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
    console.log(
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
      console.log(
        `[bot] Next retry in ${GAS_DEFER_MS / 60_000}m (gas deferral)`,
      );
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
      !botState.rebalanceFailedMidway
    ) {
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
    console.log(
      "[bot] Retiring drained position #%s (no tx in flight)",
      position.tokenId,
    );
    _stopped = true;
    clearTimeout(timer);
    updateBotState({
      running: false,
      retired: true,
      retiredAt: new Date().toISOString(),
      drainedForMs: drainedForMs || null,
    });
    if (opts.onRetire) {
      try {
        await opts.onRetire(position.tokenId);
      } catch (err) {
        console.warn("[bot] onRetire callback error: %s", err.message);
      }
    }
  }

  const poll = async () => {
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
      });
      if (result.rebalanced || result.cancelled || result.compounded)
        specialActionCompleted = true;
      if (result.retired) retireRequest = result;
      _processPollResult(result);
    } catch (err) {
      if (!firstFailureAt) firstFailureAt = Date.now();
      console.error(
        `[bot] Poll error: ${err.message} (${Math.round((Date.now() - firstFailureAt) / 60_000)}m of failures)`,
      );
      _notify("otherError", {
        position: { tokenId: position.tokenId },
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
      console.log(
        "[bot] Honoring queued switch to #%s",
        botState.pendingSwitch,
      );
      _stopped = true;
      clearTimeout(timer);
      updateBotState({ running: false });
      return;
    }
    /* After a completed special action, poll again in ~2s so the dashboard
     * KPI numbers refresh promptly instead of waiting CHECK_INTERVAL_SEC.
     * Works for both user-triggered and auto-triggered actions. */
    _scheduleNext(specialActionCompleted ? 2000 : undefined);
  };

  await poll(); // First poll — gives the dashboard current position data
  console.log(`[bot] Polling every ${config.CHECK_INTERVAL_SEC}s`);

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
  return {
    stop() {
      if (_stopped) return Promise.resolve();
      _stopped = true;
      clearTimeout(timer);
      updateBotState({ running: false });
      console.log("[bot] Bot loop stopped");
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
  createProviderWithFallback,
  resolvePrivateKey,
  startBotLoop,
  _overridePnlWithRealValues,
  _initPnlTracker,
  _detectPosition,
  _tryInitPnlTracker,
};
