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

'use strict';
const ethers = require('ethers');
const config = require('./config');
const { getCachedEpochs } = require('./epoch-cache');
const rangeMath = require('./range-math');
const { createThrottle } = require('./throttle');
const { emojiId } = require('./logger');
const { detectPositionType } = require('./position-detector');
const { getPoolState } = require('./rebalancer');
const { createPnlTracker } = require('./pnl-tracker');
const {
  positionValueUsd: _positionValueUsd,
  fetchTokenPrices: _fetchTokenPrices,
  overridePnlWithRealValues: _overridePnlWithRealValues,
} = require('./bot-pnl-updater');
const { initHodlBaseline } = require('./hodl-baseline');
const { appendToPoolCache } = require('./pool-scanner');
const { createResidualTracker } = require('./residual-tracker');
const {
  createProviderWithFallback,
} = require('./bot-provider');
const {
  appendLog,
  _scanAndReconstruct,
  _activePosSummary,
} = require('./bot-recorder');
const {
  pollCycle,
  resolvePrivateKey,
  _reloadFromConfig,
  _humanizeError,
} = require('./bot-cycle');

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
  const _epochKey = position ? {
    contract: config.POSITION_MANAGER,
    wallet,
    token0: position.token0,
    token1: position.token1, fee: position.fee,
  } : null;
  const cached = _epochKey ? getCachedEpochs(_epochKey) : null;
  if (cached) {
    tracker.restore(cached);
    console.log('[bot] Restored P&L epochs from cache (%d closed)', cached.closedEpochs?.length);
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
  console.log(
    `[bot] P&L tracker initialized (T0=$${price0.toFixed(6)}, T1=$${price1.toFixed(6)})`,
  );
  return tracker;
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
    candidateAddress:
      config.ERC20_POSITION_ADDRESS || undefined,
  });
  if (detection.type !== 'nft' || !detection.nftPositions?.length)
    throw new Error(
      'No V3 NFT position found. This tool only supports V3 positions.',
    );
  const valid = detection.nftPositions.filter(
    (p) => p.fee && p.fee > 0,
  );
  if (!valid.length)
    throw new Error(
      'No positions with a valid V3 fee tier found.',
    );
  console.log(
    '[bot] _detectPosition: targetId=%s, found %d valid NFTs: %s',
    targetId || 'none',
    valid.length,
    valid
      .map(
        (p) =>
          `#${p.tokenId}(liq=${String(p.liquidity).slice(0, 8)})`,
      )
      .join(', '),
  );
  if (targetId) {
    const m = valid.find(
      (p) => String(p.tokenId) === String(targetId),
    );
    console.log(
      '[bot] _detectPosition: targetId match=%s',
      m ? `#${m.tokenId}` : 'MISS→fallback',
    );
    return m || valid[0];
  }
  const active = valid.filter(
    (p) => BigInt(p.liquidity || 0n) > 0n,
  );
  const picked =
    active.length > 0
      ? active.reduce((best, p) =>
          BigInt(p.liquidity || 0n) > BigInt(best.liquidity || 0n)
            ? p
            : best,
        )
      : valid.reduce((best, p) =>
          BigInt(p.tokenId) > BigInt(best.tokenId) ? p : best,
        );
  console.log(
    '[bot] _detectPosition: picked #%s (active=%d, total=%d)',
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
      const t = _initPnlTracker(
        _positionValueUsd(position, ps, price0, price1) || 1,
        botState, ps, lp, up, price0, price1,
        position, walletAddress,
      );
      updateBotState({ pnlEpochs: t.serialize() });
      return t;
    }
    console.warn(
      '[bot] Could not fetch token prices — P&L tracking disabled',
    );
  } catch (err) {
    console.warn('[bot] P&L tracker init error:', err.message);
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
 * @returns {Promise<{ stop: Function }>}  Handle with stop() method.
 */
async function startBotLoop(opts) {
  const { privateKey, updateBotState, botState } = opts;
  const gc = opts.getConfig || (() => undefined);
  const dryRun = opts.dryRun ?? config.DRY_RUN,
    ethersLib = opts.ethersLib || ethers;
  if (dryRun)
    console.log(
      '\n  ┌──────────────────────────────────────────────┐\n  │  DRY RUN MODE — no transactions will be sent │\n  └──────────────────────────────────────────────┘\n',
    );
  const provider = await createProviderWithFallback(
    config.RPC_URL,
    config.RPC_URL_FALLBACK,
    ethersLib,
  );
  const signer =
    dryRun && !privateKey
      ? ethersLib.Wallet.createRandom().connect(provider)
      : new ethersLib.Wallet(privateKey, provider);
  const address = await signer.getAddress();
  if (dryRun && !privateKey)
    console.log(
      `[bot] DRY RUN — using random address: ${address}`,
    );
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
  if (botState.residuals)
    residualTracker.deserialize(botState.residuals);
  initHodlBaseline(
    provider,
    ethersLib,
    position,
    botState,
    updateBotState,
  ).catch((err) =>
    console.warn(
      '[bot] HODL baseline background error:',
      err.message,
    ),
  );
  const throttle = createThrottle({
    minIntervalMs:
      config.MIN_REBALANCE_INTERVAL_MIN * 60_000,
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
    polling = false,
    _stopped = false;
  const GAS_DEFER_MS = 3600_000;
  let currentIntervalMs = config.CHECK_INTERVAL_SEC * 1000,
    timer = null;
  function _scheduleNext(ms) {
    clearTimeout(timer);
    timer = setTimeout(poll, ms ?? currentIntervalMs);
  }

  const poll = async () => {
    if (polling) return;
    polling = true;
    _reloadFromConfig(gc, throttle, (ms) => {
      currentIntervalMs = ms;
    });
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
        _getConfig: gc,
      });
      if (result.rebalanced) {
        rebalanceCount++;
        firstFailureAt = null;
        currentIntervalMs =
          (gc('checkIntervalSec') ||
            config.CHECK_INTERVAL_SEC) * 1000;
        appendToPoolCache(position, address, result).catch(() => {});
        updateBotState({
          rebalanceError: null,
          rebalancePaused: false,
          forceRebalance: false,
        });
        if (botState.rangeRounded)
          setTimeout(
            () => updateBotState({ rangeRounded: null }),
            5000,
          );
      } else if (result.gasDeferred) {
        currentIntervalMs = GAS_DEFER_MS;
        console.log(
          `[bot] Next retry in ${GAS_DEFER_MS / 60_000}m (gas deferral)`,
        );
      } else if (result.error) {
        if (!firstFailureAt) firstFailureAt = Date.now();
        const errMsg = _humanizeError(result.error);
        console.error(
          `[bot] Rebalance failed: ${errMsg} (${Math.round((Date.now() - firstFailureAt) / 60_000)}m of failures)`,
        );
        // Only pause for swap aborts (user must adjust slippage).
        // TX stuck/cancelled errors are transient — retry next cycle.
        const isSwapAbort = /swap aborted/i.test(errMsg);
        updateBotState({
          rebalanceError: errMsg,
          rebalancePaused: isSwapAbort,
        });
      } else if (firstFailureAt && !result.paused) {
        const oorMin = Math.round(
          (Date.now() - firstFailureAt) / 60_000,
        );
        console.log(
          `[bot] Price returned to range after ~${oorMin}m of failures — clearing`,
        );
        firstFailureAt = null;
        currentIntervalMs =
          (gc('checkIntervalSec') ||
            config.CHECK_INTERVAL_SEC) * 1000;
        updateBotState({
          rebalanceError: null,
          rebalancePaused: false,
          oorRecoveredMin: oorMin,
        });
        // Clear after one poll so the dashboard doesn't re-show on refresh
        setTimeout(
          () => updateBotState({ oorRecoveredMin: 0 }),
          5000,
        );
      }
    } catch (err) {
      if (!firstFailureAt) firstFailureAt = Date.now();
      console.error(
        `[bot] Poll error: ${err.message} (${Math.round((Date.now() - firstFailureAt) / 60_000)}m of failures)`,
      );
    } finally {
      polling = false;
    }
    // Honor queued position switch (requested while rebalance was in progress)
    if (botState.pendingSwitch) {
      console.log(
        '[bot] Honoring queued switch to #%s',
        botState.pendingSwitch,
      );
      _stopped = true;
      clearTimeout(timer);
      updateBotState({ running: false });
      return;
    }
    _scheduleNext();
  };

  await poll(); // First poll — gives the dashboard current position data
  console.log(
    `[bot] Polling every ${config.CHECK_INTERVAL_SEC}s`,
  );

  // Lazy scan: expose _triggerScan for on-demand invocation
  botState._triggerScan = async () => {
    if (botState._scanRunning) return;
    botState._scanRunning = true;
    try {
      clearTimeout(timer);
      await _scanAndReconstruct(
        provider, ethersLib, address, position,
        null, rebalanceEvents, updateBotState,
        throttle, pnlTracker, botState,
      );
      await poll();
    } finally {
      botState._scanRunning = false;
    }
  };

  if (opts.eagerScan !== false) {
    await botState._triggerScan();
  } else {
    // If epochs were already restored from config (e.g. scanned
    // while unmanaged), show cached data immediately but trigger
    // a background freshness check for new events since lastBlock.
    const hasEpochs = pnlTracker.epochCount() > 0;
    updateBotState({
      rebalanceScanComplete: hasEpochs,
    });
    if (hasEpochs) botState._triggerScan();
    _scheduleNext();
  }
  return {
    stop() {
      if (_stopped) return Promise.resolve();
      _stopped = true;
      clearTimeout(timer);
      updateBotState({ running: false });
      console.log('[bot] Bot loop stopped');
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
};
