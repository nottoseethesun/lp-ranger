/**
 * @file src/bot-cycle.js
 * @module bot-cycle
 * @description
 * Poll cycle, execution, gates, config reload, and private key resolution.
 * Extracted from bot-loop.js.
 */

'use strict';
const ethers = require('ethers');
const config = require('./config');
const rangeMath = require('./range-math');
const walletManager = require('./wallet-manager');
const { loadAndDecrypt } = require('./key-store');
const { emojiId } = require('./logger');
const {
  getPoolState,
  executeRebalance,
  enrichResultUsd,
} = require('./rebalancer');
const {
  positionValueUsd: _positionValueUsd,
  fetchTokenPrices: _fetchTokenPrices,
  estimateGasCostUsd: _estimateGasCostUsd,
  updatePnlAndStats: _updatePnlAndStats,
} = require('./bot-pnl-updater');
const {
  appendLog,
  _closePnlEpoch,
  _recordResidual,
  _applyRebalanceResult,
} = require('./bot-recorder');

async function _executeAndRecord(deps, ethersLib) {
  const { signer, position, throttle } = deps;
  console.log(
    '[bot] Position out of range — rebalancing… %s NFT #%s',
    emojiId(position.tokenId),
    position.tokenId,
  );
  const lock = deps._rebalanceLock;
  const release = lock ? await lock.acquire() : null;
  if (lock)
    console.log(
      '[bot] Rebalance lock acquired for #%s (pending: %d)',
      position.tokenId,
      lock.pending(),
    );
  const state = deps._botState || {};
  state.rebalanceInProgress = true;
  try {
    const crw = state.customRangeWidthPct;
    const result = await executeRebalance(signer, ethersLib, {
      position,
      factoryAddress: config.FACTORY,
      positionManagerAddress: config.POSITION_MANAGER,
      swapRouterAddress: config.SWAP_ROUTER,
      slippagePct:
        deps._getConfig?.('slippagePct') ?? config.SLIPPAGE_PCT,
      ...(crw ? { customRangeWidthPct: crw } : {}),
    });
    if (result.success) {
      if (crw) delete state.customRangeWidthPct;
      throttle.recordRebalance();
      if (deps._recordPoolRebalance && deps._poolKey)
        deps._recordPoolRebalance(
          deps._poolKey(
            position.token0,
            position.token1,
            position.fee,
          ),
        );
      try {
        await enrichResultUsd(
          result,
          () =>
            _fetchTokenPrices(position.token0, position.token1),
          position.token0,
          position.token1,
        );
      } catch (_) {
        /* prices unavailable */
      }
      _recordResidual(deps, result);
      appendLog(result);
      console.log(
        '[bot] Rebalance OK — new tokenId: #%s %s',
        String(result.newTokenId),
        emojiId(String(result.newTokenId)),
      );
      await _closePnlEpoch(deps, result);
      _applyRebalanceResult(deps, result);
    } else {
      console.error('[bot] Rebalance failed:', result.error);
      if (result.cancelled) {
        console.warn(
          '[bot] TX was auto-cancelled (nonce freed). Cancel TX: %s',
          result.cancelTxHash || 'unknown',
        );
        if (deps.updateBotState)
          deps.updateBotState({
            txCancelled: {
              message: result.error,
              cancelTxHash: result.cancelTxHash,
              at: new Date().toISOString(),
            },
          });
      }
    }
    state.rebalanceInProgress = false;
    return {
      rebalanced: result.success,
      error: result.error,
      cancelled: result.cancelled,
      newTokenId: result.newTokenId,
      oldTokenId: result.oldTokenId,
      txHashes: result.txHashes,
      blockNumber: result.blockNumber,
    };
  } finally {
    if (release) {
      release();
      console.log(
        '[bot] Rebalance lock released for #%s',
        position.tokenId,
      );
    }
  }
}

/** Check whether the OOR timeout has expired (position continuously OOR). */
function _isTimeoutExpired(bs, gc) {
  const t =
    gc?.('rebalanceTimeoutMin') ?? config.REBALANCE_TIMEOUT_MIN;
  return t > 0 && bs.oorSince && Date.now() - bs.oorSince >= t * 60_000;
}

/** Check whether the price has moved beyond the OOR threshold. */
function _isBeyondThreshold(poolState, position, gc) {
  const threshPct =
    (gc?.('rebalanceOutOfRangeThresholdPercent') ??
      config.REBALANCE_OOR_THRESHOLD_PCT ??
      5) / 100;
  if (threshPct <= 0) return true;
  const lp = rangeMath.tickToPrice(
      position.tickLower,
      poolState.decimals0,
      poolState.decimals1,
    ),
    up = rangeMath.tickToPrice(
      position.tickUpper,
      poolState.decimals0,
      poolState.decimals1,
    );
  if (
    poolState.price < lp - (up - lp) * threshPct ||
    poolState.price > up + (up - lp) * threshPct
  )
    return true;
  console.log(
    `[bot] OOR but within ${threshPct * 100}% threshold`,
  );
  return false;
}

/**
 * Check if estimated gas cost exceeds 0.5% of position value.
 * @param {import('ethers').JsonRpcProvider} provider
 * @param {object} position  Active V3 NFT position data.
 * @param {object} poolState Pool state from getPoolState().
 * @returns {Promise<boolean>} True if gas is too expensive and rebalance should be deferred.
 */
async function _isGasTooHigh(provider, position, poolState) {
  try {
    const gasCost = await _estimateGasCostUsd(provider);
    const prices = await _fetchTokenPrices(
      position.token0,
      position.token1,
    );
    const posValue = _positionValueUsd(
      position,
      poolState,
      prices.price0,
      prices.price1,
    );
    if (posValue > 0 && gasCost > 0 && gasCost / posValue > 0.005) {
      console.warn(
        `[bot] Gas too high: $${gasCost.toFixed(4)} is ${((gasCost / posValue) * 100).toFixed(2)}% of position ($${posValue.toFixed(2)}) — deferring`,
      );
      return true;
    }
  } catch (_) {
    /* proceed if gas check fails */
  }
  return false;
}

/** Check range, threshold, and OOR timeout.  Returns early result or null. */
function _checkRangeAndThreshold(deps, poolState, emit) {
  const { position } = deps;
  const forced = !!deps._botState?.forceRebalance;
  const botSt = deps._botState || {};
  const inRange =
    poolState.tick >= position.tickLower &&
    poolState.tick < position.tickUpper;
  if (inRange && !forced) {
    if (botSt.oorSince) {
      botSt.oorSince = null;
      emit({ oorSince: null });
    }
    return { rebalanced: false, inRange: true };
  }
  const gc = deps._getConfig;
  const beyondThreshold =
    forced || _isBeyondThreshold(poolState, position, gc);
  if (!beyondThreshold) {
    if (!botSt.oorSince) {
      botSt.oorSince = Date.now();
      emit({ oorSince: botSt.oorSince });
    }
    if (!_isTimeoutExpired(botSt, gc)) {
      emit({ withinThreshold: true });
      return { rebalanced: false, withinThreshold: true };
    }
    console.log(
      '[bot] OOR timeout expired — triggering rebalance',
    );
  } else if (!forced && !botSt.oorSince) {
    botSt.oorSince = Date.now();
    emit({ oorSince: botSt.oorSince });
  }
  emit({ withinThreshold: false });
  return null;
}

/** Rewrite low-level RPC errors into user-readable messages. */
function _humanizeError(msg) {
  if (/insufficient funds|INSUFFICIENT_FUNDS/i.test(msg))
    return 'Wallet has insufficient gas to send transactions. Send native tokens (e.g. PLS) to the wallet and retry.';
  return msg;
}

/** Check throttle, daily cap, dry-run, and gas before executing.  Returns early result or null. */
function _checkRebalanceGates(deps, poolState, forced) {
  const { throttle, dryRun } = deps;
  const emit = deps.updateBotState || (() => {});
  // Skip rebalance while paused from a prior swap abort (user must adjust slippage
  // or use the manual Rebalance button, which sets forceRebalance and clears the flag)
  if (!forced && deps._botState?.rebalancePaused)
    return { rebalanced: false, paused: true };
  const can = !forced && throttle.canRebalance();
  if (can && !can.allowed) {
    console.log(
      `[bot] OOR but throttled (${can.reason}), wait ${Math.ceil(can.msUntilAllowed / 1000)}s`,
    );
    emit({ throttleState: throttle.getState() });
    return { rebalanced: false };
  }
  if (!forced && deps._canRebalancePool && deps._poolKey) {
    const pk = deps._poolKey(
      deps.position.token0,
      deps.position.token1,
      deps.position.fee,
    );
    const max =
      deps.throttle.getState().dailyMax ||
      config.MAX_REBALANCES_PER_DAY;
    if (!deps._canRebalancePool(pk, max)) {
      console.log(
        '[bot] OOR but pool daily rebalance cap reached (%d/%d) — deferring',
        max,
        max,
      );
      return { rebalanced: false };
    }
  }
  if (dryRun) {
    console.log(
      `[bot] DRY RUN — OOR, price=${poolState.price} tick=${poolState.tick} range=[${deps.position.tickLower},${deps.position.tickUpper}]`,
    );
    return { rebalanced: false };
  }
  return null;
}

/** Single poll iteration: check range, threshold, throttle, then rebalance if needed. */
async function pollCycle(deps) {
  const { provider, position, throttle } = deps;
  const ethersLib = deps._ethersLib || ethers;
  const emit = deps.updateBotState || (() => {});
  throttle.tick();
  let poolState;
  try {
    poolState = await getPoolState(provider, ethersLib, {
      factoryAddress: config.FACTORY,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
    });
  } catch (err) {
    console.error('[bot] Pool state error:', err.message);
    return { rebalanced: false, error: err.message };
  }
  await _updatePnlAndStats(deps, poolState, ethersLib);
  if (
    BigInt(position.liquidity) === 0n &&
    !deps._botState?.forceRebalance
  ) {
    console.log(
      '[bot] Position closed (0 liquidity, force=%s) — skipping',
      !!deps._botState?.forceRebalance,
    );
    return { rebalanced: false };
  }
  const rangeCheck = _checkRangeAndThreshold(
    deps,
    poolState,
    emit,
  );
  if (rangeCheck) return rangeCheck;
  const forced = !!deps._botState?.forceRebalance;
  if (config.VERBOSE)
    console.log(
      '[bot] pollCycle: OOR on #%s, forced=%s, tick=%d range=[%d,%d]',
      position.tokenId, forced, poolState.tick,
      position.tickLower, position.tickUpper,
    );
  const gate = _checkRebalanceGates(deps, poolState, forced);
  if (gate) return gate;
  if (await _isGasTooHigh(provider, position, poolState))
    return { rebalanced: false, gasDeferred: true };
  return _executeAndRecord(deps, ethersLib);
}

/**
 * Resolve a private key from available sources, in priority order:
 *   1. config.PRIVATE_KEY (env var)
 *   2. config.KEY_FILE + password -> loadAndDecrypt()
 *   3. walletManager.hasWallet() + password -> walletManager.revealWallet()
 *   4. Returns null if none available.
 *
 * @param {object} opts
 * @param {Function|null} [opts.askPassword]  Interactive password prompt (null = non-interactive).
 * @returns {Promise<string|null>}  Hex private key, or null.
 */
async function resolvePrivateKey(opts = {}) {
  const { askPassword } = opts;
  // 1. PRIVATE_KEY env var (must be valid 32-byte hex)
  if (config.PRIVATE_KEY
    && /^(0x)?[0-9a-f]{64}$/i.test(config.PRIVATE_KEY))
    return config.PRIVATE_KEY;
  // 2. Encrypted key file
  if (config.KEY_FILE) {
    const password =
      config.KEY_PASSWORD ||
      (askPassword &&
        (await askPassword('[bot] Enter key-file password: ')));
    if (!password) return null;
    console.log(
      `[bot] Loading private key from encrypted file: ${config.KEY_FILE}`,
    );
    return loadAndDecrypt(password, config.KEY_FILE);
  }
  // 3. Wallet manager (dashboard-imported wallet) — interactive prompt only (no .env password)
  if (walletManager.hasWallet() && askPassword) {
    const password = await askPassword(
      '[bot] Enter wallet password: ',
    );
    if (!password) return null;
    console.log('[bot] Loading private key from imported wallet');
    return (await walletManager.revealWallet(password)).privateKey;
  }
  return null;
}

/** Reload config values from disk on each poll cycle. */
function _reloadFromConfig(gc, throttle, setIntervalMs) {
  const ci = gc('checkIntervalSec');
  if (ci) setIntervalMs(ci * 1000);
  throttle.configure({
    minIntervalMs:
      (gc('minRebalanceIntervalMin') ||
        config.MIN_REBALANCE_INTERVAL_MIN) * 60_000,
    dailyMax:
      gc('maxRebalancesPerDay') ||
      config.MAX_REBALANCES_PER_DAY,
  });
}

module.exports = {
  _executeAndRecord,
  _isTimeoutExpired,
  _isBeyondThreshold,
  _isGasTooHigh,
  _checkRangeAndThreshold,
  _humanizeError,
  _checkRebalanceGates,
  pollCycle,
  resolvePrivateKey,
  _reloadFromConfig,
};
