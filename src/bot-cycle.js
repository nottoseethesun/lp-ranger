/**
 * @file src/bot-cycle.js
 * @module bot-cycle
 * @description
 * Poll cycle, execution, gates, config reload, and private key resolution.
 * Extracted from bot-loop.js.
 */

"use strict";
const ethers = require("ethers");
const config = require("./config");
const rangeMath = require("./range-math");
const walletManager = require("./wallet-manager");
const { loadAndDecrypt } = require("./key-store");
const { emojiId } = require("./logger");
const {
  getPoolState,
  executeRebalance,
  enrichResultUsd,
} = require("./rebalancer");
const { getTokenSymbol } = require("./server-scan");
const {
  positionValueUsd: _positionValueUsd,
  fetchTokenPrices: _fetchTokenPrices,
  estimateGasCostUsd: _estimateGasCostUsd,
  actualGasCostUsd: _actualGasCostUsd,
  updatePnlAndStats: _updatePnlAndStats,
} = require("./bot-pnl-updater");
const {
  appendLog,
  _closePnlEpoch,
  _recordResidual,
  _applyRebalanceResult,
} = require("./bot-recorder");
const { PM_ABI } = require("./pm-abi");

/**
 * Activate exponential swap-backoff after a priceVolatile result.
 * Starts at 1 min, doubles each failure, caps at 20 min per wait.
 * After REBALANCE_RETRY_SWAP_LIMIT attempts, pauses with alert.
 */
function _activateSwapBackoff(state, emit) {
  const limit = config.REBALANCE_RETRY_SWAP_LIMIT;
  const attempts = (state.swapBackoffAttempts || 0) + 1;
  state.swapBackoffAttempts = attempts;
  state.rebalanceInProgress = false;
  if (attempts >= limit) {
    state.rebalancePaused = true;
    // prettier-ignore
    state.rebalanceError = "Price moved during rebalance " + attempts + " times in a row. Market too volatile to rebalance safely. Tokens are safe in the wallet. Use manual Rebalance when ready.";
    state.swapBackoffMs = 0;
    state.swapBackoffUntil = 0;
    console.error("[bot] Max swap retries (%d) — pausing", attempts);
    if (emit)
      emit({ rebalancePaused: true, rebalanceError: state.rebalanceError });
    return;
  }
  const prev = state.swapBackoffMs || 0;
  const next = prev ? Math.min(prev * 2, _MAX_SWAP_BACKOFF_MS) : 60_000;
  state.swapBackoffMs = next;
  state.swapBackoffUntil = Date.now() + next;
  // prettier-ignore
  console.warn("[bot] Price volatile (attempt %d/%d) — backoff %ds", attempts, limit, next / 1000);
}

async function _executeAndRecord(deps, ethersLib) {
  const { signer, position, throttle } = deps;
  // prettier-ignore
  console.log("[bot] Position out of range — rebalancing… %s NFT #%s", emojiId(position.tokenId), position.tokenId);
  const lock = deps._rebalanceLock;
  const release = lock ? await lock.acquire() : null;
  // prettier-ignore
  if (lock) console.log("[bot] Rebalance lock acquired for #%s (pending: %d)", position.tokenId, lock.pending());
  const state = deps._botState || {};
  state.rebalanceInProgress = true;
  state.forceRebalance = false;
  try {
    const crw = state.customRangeWidthPct;
    const result = await executeRebalance(signer, ethersLib, {
      position,
      factoryAddress: config.FACTORY,
      positionManagerAddress: config.POSITION_MANAGER,
      swapRouterAddress: config.SWAP_ROUTER,
      slippagePct: deps._getConfig?.("slippagePct") ?? config.SLIPPAGE_PCT,
      symbol0: getTokenSymbol(position.token0),
      symbol1: getTokenSymbol(position.token1),
      ...(crw ? { customRangeWidthPct: crw } : {}),
    });
    // Price moved too fast — tokens are removed+swapped but not minted.
    // Activate exponential backoff so the next poll cycle waits before
    // retrying.  Tokens sit safely in the wallet until the next attempt.
    if (result.priceVolatile) {
      _activateSwapBackoff(state, deps.updateBotState);
      return { rebalanced: false, priceVolatile: true };
    }
    if (result.success) {
      if (crw) delete state.customRangeWidthPct;
      // Clear swap backoff on success — market stabilised
      state.swapBackoffMs = 0;
      state.swapBackoffUntil = 0;
      state.swapBackoffAttempts = 0;
      throttle.recordRebalance();
      if (deps._recordPoolRebalance && deps._poolKey)
        deps._recordPoolRebalance(
          deps._poolKey(position.token0, position.token1, position.fee),
        );
      // prettier-ignore
      try { await enrichResultUsd(result, () => _fetchTokenPrices(position.token0, position.token1), position.token0, position.token1); } catch (_) { /* prices unavailable */ }
      _recordResidual(deps, result);
      appendLog(result);
      // prettier-ignore
      console.log("[bot] Rebalance OK — new tokenId: #%s %s", String(result.newTokenId), emojiId(String(result.newTokenId)));
      await _closePnlEpoch(deps, result);
      _applyRebalanceResult(deps, result);
    } else {
      console.error("[bot] Rebalance failed:", result.error);
      if (result.cancelled) {
        // prettier-ignore
        console.warn("[bot] TX was auto-cancelled (nonce freed). Cancel TX: %s", result.cancelTxHash || "unknown");
        // prettier-ignore
        if (deps.updateBotState) deps.updateBotState({ txCancelled: { message: result.error, cancelTxHash: result.cancelTxHash, at: new Date().toISOString() } });
        await _recordCancelGas(result, deps);
      }
    }
    state.rebalanceInProgress = false;
    // prettier-ignore
    return { rebalanced: result.success, error: result.error, cancelled: result.cancelled, newTokenId: result.newTokenId, oldTokenId: result.oldTokenId, txHashes: result.txHashes, blockNumber: result.blockNumber };
  } finally {
    if (release) {
      release();
      console.log("[bot] Rebalance lock released for #%s", position.tokenId);
    }
  }
}

/** Record cancel TX gas in the P&L tracker when a rebalance is cancelled. */
async function _recordCancelGas(result, deps) {
  if (!result.cancelGasCostWei || result.cancelGasCostWei <= 0n) return;
  if (!deps._pnlTracker) return;
  const gasUsd = await _actualGasCostUsd(result.cancelGasCostWei);
  const gasNative = Number(result.cancelGasCostWei) / 1e18;
  if (gasUsd > 0) deps._pnlTracker.addGas(gasUsd, gasNative);
}

/** Check whether the OOR timeout has expired (position continuously OOR). */
function _isTimeoutExpired(bs, gc) {
  const t = gc?.("rebalanceTimeoutMin") ?? config.REBALANCE_TIMEOUT_MIN;
  return t > 0 && bs.oorSince && Date.now() - bs.oorSince >= t * 60_000;
}

/** Check whether the price has moved beyond the OOR threshold. */
function _isBeyondThreshold(poolState, position, gc) {
  // prettier-ignore
  const threshPct = (gc?.("rebalanceOutOfRangeThresholdPercent") ?? config.REBALANCE_OOR_THRESHOLD_PCT ?? 5) / 100;
  if (threshPct <= 0) return true;
  // prettier-ignore
  const lp = rangeMath.tickToPrice(position.tickLower, poolState.decimals0, poolState.decimals1),
    up = rangeMath.tickToPrice(position.tickUpper, poolState.decimals0, poolState.decimals1);
  if (
    poolState.price < lp - (up - lp) * threshPct ||
    poolState.price > up + (up - lp) * threshPct
  )
    return true;
  console.log(`[bot] OOR but within ${threshPct * 100}% threshold`);
  return false;
}

/** Check if estimated gas cost exceeds 0.5% of position value. */
async function _isGasTooHigh(provider, position, poolState) {
  try {
    const gasCost = await _estimateGasCostUsd(provider);
    const prices = await _fetchTokenPrices(position.token0, position.token1);
    const posValue = _positionValueUsd(
      position,
      poolState,
      prices.price0,
      prices.price1,
    );
    if (posValue > 0 && gasCost > 0 && gasCost / posValue > 0.005) {
      // prettier-ignore
      console.warn("[bot] Gas too high: $%s is %s%% of position ($%s) — deferring", gasCost.toFixed(4), ((gasCost / posValue) * 100).toFixed(2), posValue.toFixed(2));
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
    poolState.tick >= position.tickLower && poolState.tick < position.tickUpper;
  if (inRange && !forced) {
    if (botSt.oorSince) {
      botSt.oorSince = null;
      emit({ oorSince: null });
    }
    return { rebalanced: false, inRange: true };
  }
  const gc = deps._getConfig;
  const beyondThreshold = forced || _isBeyondThreshold(poolState, position, gc);
  if (!beyondThreshold) {
    if (!botSt.oorSince) {
      botSt.oorSince = Date.now();
      emit({ oorSince: botSt.oorSince });
    }
    if (!_isTimeoutExpired(botSt, gc)) {
      emit({ withinThreshold: true });
      return { rebalanced: false, withinThreshold: true };
    }
    console.log("[bot] OOR timeout expired — triggering rebalance");
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
    return "Wallet has insufficient gas to send transactions. Send native tokens (e.g. PLS) to the wallet and retry.";
  return msg;
}

/**
 * Max swap-backoff wait (20 minutes).  When a rebalance fails because the
 * pool price moved between swap and mint (priceVolatile), the bot waits
 * before retrying.  Starts at 1 min, doubles each failure, caps at 20 min.
 * Cleared to zero on successful rebalance.
 */
const _MAX_SWAP_BACKOFF_MS = 20 * 60_000;

/**
 * Check if the swap-backoff timer is active (price was too volatile on
 * the last rebalance attempt).  Returns an early result if still waiting,
 * or null to proceed.
 */
function _checkSwapBackoff(deps, forced) {
  const bs = deps._botState || {};
  if (forced || !bs.swapBackoffUntil || Date.now() >= bs.swapBackoffUntil)
    return null;
  const sec = Math.ceil((bs.swapBackoffUntil - Date.now()) / 1000);
  console.log("[bot] Swap backoff active — waiting %ds before retry", sec);
  return { rebalanced: false, swapBackoff: true };
}

/** Check throttle, daily cap, dry-run, and gas before executing.  Returns early result or null. */
function _checkRebalanceGates(deps, poolState, forced) {
  const { throttle, dryRun } = deps;
  const emit = deps.updateBotState || (() => {});
  if (!forced && deps._botState?.rebalancePaused)
    return { rebalanced: false, paused: true };
  const backoff = _checkSwapBackoff(deps, forced);
  if (backoff) return backoff;
  const can = !forced && throttle.canRebalance();
  if (can && !can.allowed) {
    console.log(
      `[bot] OOR but throttled (${can.reason}), wait ${Math.ceil(can.msUntilAllowed / 1000)}s`,
    );
    emit({ throttleState: throttle.getState() });
    return { rebalanced: false };
  }
  if (!forced && deps._canRebalancePool && deps._poolKey) {
    // prettier-ignore
    const pk = deps._poolKey(deps.position.token0, deps.position.token1, deps.position.fee);
    const max =
      deps.throttle.getState().dailyMax || config.MAX_REBALANCES_PER_DAY;
    if (!deps._canRebalancePool(pk, max)) {
      console.log(
        "[bot] OOR but pool daily cap reached (%d/%d) — deferring",
        max,
        max,
      );
      return { rebalanced: false };
    }
  }
  if (dryRun) {
    // prettier-ignore
    console.log("[bot] DRY RUN — OOR, tick=%d range=[%d,%d]", poolState.tick, deps.position.tickLower, deps.position.tickUpper);
    return { rebalanced: false };
  }
  return null;
}

/**
 * Refresh position liquidity + ticks from chain.
 * Keeps the in-memory position object current after
 * rebalance mints a new NFT or external changes.
 */
async function _refreshPosition(position, ethersLib, provider) {
  try {
    const pm = new ethersLib.Contract(
      config.POSITION_MANAGER,
      PM_ABI,
      provider,
    );
    const d = await pm.positions(position.tokenId);
    position.liquidity = String(d.liquidity);
    if (d.tickLower !== undefined) position.tickLower = Number(d.tickLower);
    if (d.tickUpper !== undefined) position.tickUpper = Number(d.tickUpper);
  } catch (_) {
    /* keep cached value */
  }
}

/**
 * Check whether a compound should be triggered (manual or auto).
 * Runs after P&L update so unclaimed fees are fresh.
 * @param {object} deps  Bot deps (including _botState, _getConfig).
 * @param {object} poolState  Current pool state.
 * @param {object} ethersLib  ethers module.
 */
async function _checkCompound(deps, poolState, ethersLib) {
  const botSt = deps._botState || {};
  const _gc = (k) => (deps._getConfig ? deps._getConfig(k) : undefined);
  const forced = !!botSt.forceCompound;
  const autoEnabled = _gc("autoCompoundEnabled") || false;
  const threshold =
    _gc("autoCompoundThresholdUsd") || config.COMPOUND_DEFAULT_THRESHOLD_USD;
  const feesUsd = deps._lastUnclaimedFeesUsd || 0;

  if (!forced && !autoEnabled) return;
  if (!forced && feesUsd < threshold) return;
  if (!forced && feesUsd < config.COMPOUND_MIN_FEE_USD) return;

  // Auto-compound throttle: max(5 × checkInterval, 300s)
  const lastAt = _gc("lastCompoundAt");
  if (!forced && lastAt) {
    const interval =
      Math.max((config.CHECK_INTERVAL_SEC || 60) * 5, 300) * 1000;
    if (Date.now() - new Date(lastAt).getTime() < interval) return;
  }

  // prettier-ignore
  console.log("[bot] Compound triggered (forced=%s fees=$%s threshold=$%s)", forced, feesUsd.toFixed(2), threshold);
  await _executeCompound(
    deps,
    poolState,
    ethersLib,
    forced ? "manual" : "auto",
  );
  // Refresh position from chain — liquidity increased after compound
  await _refreshPosition(deps.position, ethersLib, deps.provider);
}

/** Record a successful compound: update history, P&L tracker gas, collected fees. */
async function _recordCompound(deps, result) {
  const emit = deps.updateBotState || (() => {});
  const _gc = (k) => (deps._getConfig ? deps._getConfig(k) : undefined);
  const gasWei = BigInt(result.gasCostWei || 0);
  const gasCostUsd = gasWei > 0n ? await _actualGasCostUsd(gasWei) : 0;
  const history = _gc("compoundHistory") || [];
  // prettier-ignore
  history.push({ timestamp: result.timestamp, txHash: result.depositTxHash, amount0Deposited: result.amount0Deposited, amount1Deposited: result.amount1Deposited, usdValue: result.usdValue, price0: result.price0, price1: result.price1, gasCostUsd, trigger: result.trigger });
  const total = (_gc("totalCompoundedUsd") || 0) + result.usdValue;
  emit({
    compoundHistory: history,
    totalCompoundedUsd: total,
    lastCompoundAt: result.timestamp,
  });
  /* Add compound gas to the P&L tracker so it shows in the Gas KPI */
  const tracker = deps._pnlTracker;
  if (tracker && tracker.epochCount() > 0) {
    const gasNative = Number(gasWei) / 1e18;
    tracker.addGas(gasCostUsd, gasNative);
    emit({ pnlEpochs: tracker.serialize() });
  }
  if (deps._addCollectedFees) deps._addCollectedFees(result.usdValue);
  // prettier-ignore
  console.log("[bot] Compound complete: $%s reinvested, gas $%s (total: $%s)", result.usdValue.toFixed(2), gasCostUsd.toFixed(4), total.toFixed(2));
}

/**
 * Execute a compound: collect fees → increaseLiquidity.
 * Acquires the rebalance lock for nonce safety.
 */
async function _executeCompound(deps, poolState, ethersLib, trigger) {
  const { signer, position } = deps;
  const emit = deps.updateBotState || (() => {});
  const botSt = deps._botState || {};
  const lock = deps._rebalanceLock;
  const release = lock ? await lock.acquire() : null;
  // prettier-ignore
  if (lock) console.log("[bot] Compound lock acquired for #%s (pending: %d)", position.tokenId, lock.pending());
  try {
    botSt.forceCompound = false;
    emit({ compoundInProgress: true });

    const { executeCompound } = require("./compounder");
    // prettier-ignore
    const result = await executeCompound(signer, ethersLib, { positionManagerAddress: config.POSITION_MANAGER, tokenId: position.tokenId, token0: position.token0, token1: position.token1, token0Symbol: position.token0Symbol || "Token0", token1Symbol: position.token1Symbol || "Token1", recipient: await signer.getAddress(), decimals0: poolState.decimals0, decimals1: poolState.decimals1, price0: deps._lastPrice0 || 0, price1: deps._lastPrice1 || 0, trigger });

    if (result.compounded) {
      await _recordCompound(deps, result);
    } else {
      console.log("[bot] Compound skipped: %s", result.reason);
    }
  } catch (err) {
    console.error("[bot] Compound failed:", err.message);
    emit({ compoundError: err.message });
  } finally {
    emit({ compoundInProgress: false });
    if (release) release();
    if (lock)
      console.log("[bot] Compound lock released for #%s", position.tokenId);
  }
}

/** Handle a manual forceCompound request (works regardless of range). */
async function _handleForceCompound(
  deps,
  poolState,
  ethersLib,
  position,
  provider,
) {
  if (!deps._botState?.forceCompound) return;
  await _executeCompound(deps, poolState, ethersLib, "manual");
  await _refreshPosition(position, ethersLib, provider);
}

/** Single poll iteration: check range, threshold, throttle, then rebalance if needed. */
async function pollCycle(deps) {
  const { provider, position, throttle } = deps;
  const ethersLib = deps._ethersLib || ethers;
  const emit = deps.updateBotState || (() => {});
  throttle.tick();
  let poolState;
  try {
    // prettier-ignore
    poolState = await getPoolState(provider, ethersLib, { factoryAddress: config.FACTORY, token0: position.token0, token1: position.token1, fee: position.fee });
  } catch (err) {
    console.error("[bot] Pool state error:", err.message);
    return { rebalanced: false, error: err.message };
  }
  await _refreshPosition(position, ethersLib, provider);
  await _updatePnlAndStats(deps, poolState, ethersLib);
  if (
    BigInt(position.liquidity || 0) === 0n &&
    !deps._botState?.forceRebalance
  ) {
    console.log(
      "[bot] Position closed (0 liquidity, force=%s) — skipping",
      !!deps._botState?.forceRebalance,
    );
    return { rebalanced: false };
  }
  await _handleForceCompound(deps, poolState, ethersLib, position, provider);
  if (deps._botState?.forceRebalance)
    console.log("[bot] Force rebalance requested");
  const rangeCheck = _checkRangeAndThreshold(deps, poolState, emit);
  if (rangeCheck) {
    await _checkCompound(deps, poolState, ethersLib);
    return rangeCheck;
  }
  const forced = !!deps._botState?.forceRebalance;
  // prettier-ignore
  if (config.VERBOSE) console.log("[bot] pollCycle: OOR on #%s, forced=%s, tick=%d range=[%d,%d]", position.tokenId, forced, poolState.tick, position.tickLower, position.tickUpper);
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
  if (config.PRIVATE_KEY && /^(0x)?[0-9a-f]{64}$/i.test(config.PRIVATE_KEY))
    return config.PRIVATE_KEY;
  // 2. Encrypted key file
  if (config.KEY_FILE) {
    const password =
      config.KEY_PASSWORD ||
      (askPassword && (await askPassword("[bot] Enter key-file password: ")));
    if (!password) return null;
    console.log(
      `[bot] Loading private key from encrypted file: ${config.KEY_FILE}`,
    );
    return loadAndDecrypt(password, config.KEY_FILE);
  }
  // 3. Wallet manager (dashboard-imported wallet) — interactive prompt only (no .env password)
  if (walletManager.hasWallet() && askPassword) {
    const password = await askPassword("[bot] Enter wallet password: ");
    if (!password) return null;
    console.log("[bot] Loading private key from imported wallet");
    return (await walletManager.revealWallet(password)).privateKey;
  }
  return null;
}

/** Reload config values from disk on each poll cycle. */
function _reloadFromConfig(gc, throttle, setIntervalMs) {
  const ci = gc("checkIntervalSec");
  if (ci) setIntervalMs(ci * 1000);
  throttle.configure({
    minIntervalMs:
      (gc("minRebalanceIntervalMin") || config.MIN_REBALANCE_INTERVAL_MIN) *
      60_000,
    dailyMax: gc("maxRebalancesPerDay") || config.MAX_REBALANCES_PER_DAY,
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
