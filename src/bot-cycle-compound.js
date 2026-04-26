/**
 * @file bot-cycle-compound.js
 * @description Compound execution, recording, and throttle logic for the
 *   bot poll cycle. Split from bot-cycle.js for line-count compliance.
 */

"use strict";

const config = require("./config");
const { actualGasCostUsd: _actualGasCostUsd } = require("./bot-pnl-updater");
const { notify } = require("./telegram");
const { getTokenSymbol } = require("./server-scan");
const { executeCompound: runCompound } = require("./compounder");

/**
 * Check if compound conditions are met and execute if so.
 * @returns {Promise<boolean>} true if executeCompound was attempted this cycle.
 */
async function checkCompound(deps, poolState, ethersLib, refreshPosition) {
  const botSt = deps._botState || {};
  const _gc = (k) => (deps._getConfig ? deps._getConfig(k) : undefined);
  const forced = !!botSt.forceCompound;
  const autoEnabled = _gc("autoCompoundEnabled") || false;
  const threshold =
    _gc("autoCompoundThresholdUsd") || config.COMPOUND_DEFAULT_THRESHOLD_USD;
  const feesUsd = deps._lastUnclaimedFeesUsd || 0;

  if (!forced && !autoEnabled) return false;
  if (!forced && feesUsd < threshold) return false;
  if (!forced && feesUsd < config.COMPOUND_MIN_FEE_USD) return false;

  // Auto-compound throttle: max(5 × checkInterval, 300s)
  const lastAt = _gc("lastCompoundAt");
  if (!forced && lastAt) {
    const interval =
      Math.max((config.CHECK_INTERVAL_SEC || 60) * 5, 300) * 1000;
    if (Date.now() - new Date(lastAt).getTime() < interval) return false;
  }

  console.log(
    "[bot] Compound triggered (forced=%s fees=$%s threshold=$%s)",
    forced,
    feesUsd.toFixed(2),
    threshold,
  );
  await executeCompound(deps, poolState, ethersLib, forced ? "manual" : "auto");
  // Refresh position from chain — liquidity increased after compound
  await refreshPosition(deps.position, ethersLib, deps.provider);
  return true;
}

/** Record a successful compound: update history, P&L tracker gas, collected fees. */
async function recordCompound(deps, result) {
  const emit = deps.updateBotState || (() => {});
  const _gc = (k) => (deps._getConfig ? deps._getConfig(k) : undefined);
  const gasWei = BigInt(result.gasCostWei || 0);
  const gasCostUsd = gasWei > 0n ? await _actualGasCostUsd(gasWei) : 0;
  const history = _gc("compoundHistory") || [];
  history.push({
    timestamp: result.timestamp,
    txHash: result.depositTxHash,
    amount0Deposited: result.amount0Deposited,
    amount1Deposited: result.amount1Deposited,
    usdValue: result.usdValue,
    price0: result.price0,
    price1: result.price1,
    gasCostUsd,
    trigger: result.trigger,
  });
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
  console.log(
    "[bot] Compound complete: $%s reinvested, gas $%s (total: $%s)",
    result.usdValue.toFixed(2),
    gasCostUsd.toFixed(4),
    total.toFixed(2),
  );
}

/**
 * Execute a compound: collect fees → increaseLiquidity.
 * Acquires the rebalance lock for nonce safety.
 */
async function executeCompound(deps, poolState, ethersLib, trigger) {
  const { signer, position } = deps;
  const emit = deps.updateBotState || (() => {});
  const botSt = deps._botState || {};
  const lock = deps._rebalanceLock;
  const release = lock ? await lock.acquire() : null;
  if (lock)
    console.log(
      "[bot] Compound lock acquired for #%s (pending: %d)",
      position.tokenId,
      lock.pending(),
    );
  try {
    botSt.forceCompound = false;
    emit({ compoundInProgress: true });

    const result = await runCompound(signer, ethersLib, {
      positionManagerAddress: config.POSITION_MANAGER,
      tokenId: position.tokenId,
      token0: position.token0,
      token1: position.token1,
      token0Symbol: position.token0Symbol || "Token0",
      token1Symbol: position.token1Symbol || "Token1",
      recipient: await signer.getAddress(),
      decimals0: poolState.decimals0,
      decimals1: poolState.decimals1,
      price0: deps._lastPrice0 || 0,
      price1: deps._lastPrice1 || 0,
      trigger,
      approvalMultiple: deps._getConfig?.("approvalMultiple") ?? 20,
    });

    if (result.compounded) {
      await recordCompound(deps, result);
      /*- Clear any prior compoundError on success so the dashboard's
       *  compound-error modal stops re-surfacing. */
      emit({ compoundError: null });
      notify("compoundSuccess", {
        position: {
          tokenId: position.tokenId,
          token0Symbol: getTokenSymbol(position.token0),
          token1Symbol: getTokenSymbol(position.token1),
        },
        message: `Compounded $${(result.usdValue || 0).toFixed(2)} in fees`,
      });
    } else {
      console.log("[bot] Compound skipped: %s", result.reason);
    }
  } catch (err) {
    console.error("[bot] Compound failed:", err.message);
    emit({ compoundError: err.message });
    notify("compoundFail", {
      position: {
        tokenId: position.tokenId,
        token0Symbol: getTokenSymbol(position.token0),
        token1Symbol: getTokenSymbol(position.token1),
      },
      error: err.message,
      message:
        "Note: It is unlikely but possible that the Compound failed because " +
        "the position went out of range during the Compound operation. If " +
        "that is the case, either the next rebalance or the next " +
        "check-interval will compound the fees \u2014 no need to worry.",
    });
  } finally {
    emit({ compoundInProgress: false });
    if (release) release();
    if (lock)
      console.log("[bot] Compound lock released for #%s", position.tokenId);
  }
}

/**
 * Handle a manual forceCompound request (works regardless of range).
 * @returns {Promise<boolean>} true if executeCompound ran this cycle.
 */
async function handleForceCompound(
  deps,
  poolState,
  ethersLib,
  position,
  provider,
  refreshPosition,
) {
  if (!deps._botState?.forceCompound) return false;
  await executeCompound(deps, poolState, ethersLib, "manual");
  await refreshPosition(position, ethersLib, provider);
  return true;
}

module.exports = {
  checkCompound,
  recordCompound,
  executeCompound,
  handleForceCompound,
};
