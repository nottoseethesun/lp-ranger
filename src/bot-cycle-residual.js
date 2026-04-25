/**
 * @file src/bot-cycle-residual.js
 * @module bot-cycle-residual
 * @description
 * Automatic residual-cleanup rebalance detection.
 *
 * After every successful normal (OOR) or manual rebalance the bot sets
 * `state.lastRebalanceAt` and clears `state.residualCleanupUsed`.  On
 * subsequent poll cycles, once `delayMs` has elapsed, this module checks
 * whether the wallet still holds a meaningful residual share of the pool
 * batch — `residual / (LP + residual) > thresholdPct` — and if so arms
 * `forceRebalance` + `residualCleanupInProgress` so the normal rebalance
 * path executes with the cleanup label.
 *
 * Back-to-back cleanups are prevented by `residualCleanupUsed`, which is
 * set after a cleanup fires and only cleared when the next *normal*
 * rebalance succeeds.  A cleanup's own success does NOT refresh
 * `lastRebalanceAt`, so the flag stays true and no second cleanup can
 * arm against the same baseline.
 *
 * All standard rebalance gates (throttle, daily cap, doubling, swap
 * backoff, paused state, dry-run) still apply — this module only decides
 * *whether to ask for a rebalance*; it never bypasses downstream gates.
 */

"use strict";

const { ERC20_ABI } = require("./rebalancer-pools");
const { readBotConfigDefaults } = require("./bot-config-defaults");

/** Last-resort defaults exported for tests; the live values come from the
 *  `residualCleanup` group in bot-config-defaults.json. */
const _DEFAULT_DELAY_MS = 10 * 60_000;
const _DEFAULT_THRESHOLD_PCT = 5;

/*- Load the residualCleanup group at module init.  Per-key fallback to
 *  the shipped defaults is performed inside readBotConfigDefaults so a
 *  partially-edited JSON still yields a fully-populated TUNABLES object. */
const TUNABLES = readBotConfigDefaults().residualCleanup;

/**
 * Evaluate every state gate and return a classified reason.  Callers
 * log the reason only on transitions to avoid per-poll spam.
 * @returns {{allowed:boolean, reason:string, detail?:string}}
 */
function _evaluateArmingGates(state) {
  if (!state) return { allowed: false, reason: "no-state" };
  if (state.rebalanceInProgress)
    return { allowed: false, reason: "rebalance-in-progress" };
  if (state.residualCleanupUsed)
    return { allowed: false, reason: "cleanup-used-awaiting-normal-rebalance" };
  if (state.rebalancePaused)
    return { allowed: false, reason: "rebalance-paused" };
  if (state.forceRebalance)
    return { allowed: false, reason: "manual-rebalance-pending" };
  if (state.residualCleanupInProgress)
    return { allowed: false, reason: "cleanup-already-in-progress" };
  const lastAt = state.lastRebalanceAt;
  if (!lastAt) return { allowed: false, reason: "no-last-rebalance-timestamp" };
  const elapsed = Date.now() - lastAt;
  if (elapsed < TUNABLES.delayMs) {
    const minsRemaining = Math.ceil((TUNABLES.delayMs - elapsed) / 60_000);
    return {
      allowed: false,
      reason: "cooldown",
      detail: `${minsRemaining} min remaining`,
    };
  }
  return { allowed: true, reason: "ok" };
}

/*- WeakMap so each position's state object tracks its own last-logged
 *  gate reason independently.  Prevents cross-position log bleed and
 *  lets a restart start fresh without any persistence. */
const _lastLoggedReason = new WeakMap();

/**
 * Log the current gate reason only when it changes from the last
 * logged value for this state object.  Keeps the 60s poll loop quiet
 * during long cooldowns while still surfacing every transition.
 */
function _logGateTransition(state, decision, sharePct) {
  const share =
    sharePct === null || sharePct === undefined
      ? "n/a"
      : `${sharePct.toFixed(2)}%`;
  const key = decision.reason + (decision.detail ? `:${decision.detail}` : "");
  if (_lastLoggedReason.get(state) === key) return;
  _lastLoggedReason.set(state, key);
  if (decision.allowed) {
    console.log(
      "[residual-cleanup] gates open; residual share=%s (threshold=%s%%)",
      share,
      TUNABLES.thresholdPct,
    );
  } else {
    console.log(
      "[residual-cleanup] not arming: %s%s (residual share=%s, threshold=%s%%)",
      decision.reason,
      decision.detail ? ` (${decision.detail})` : "",
      share,
      TUNABLES.thresholdPct,
    );
  }
}

/**
 * Compute residual share of the total batch. Returns 0 when inputs
 * are missing/zero, so callers can compare against the threshold
 * without extra guards.
 * @returns {{lpValue:number, residual:number, sharePct:number}}
 */
function _residualShare(snap) {
  const lpValue = Number(snap?.currentValue) || 0;
  const residual = Number(snap?.residualValueUsd) || 0;
  if (lpValue <= 0 || residual <= 0) return { lpValue, residual, sharePct: 0 };
  const batch = lpValue + residual;
  return { lpValue, residual, sharePct: (residual / batch) * 100 };
}

/** Mutate state + emit UI signal so downstream code picks up cleanup mode. */
function _armCleanup(deps, sharePct, residual, lpValue) {
  const state = deps._botState;
  const batch = lpValue + residual;
  console.log(
    "[residual-cleanup] arming cleanup: residual=$%s (%s%% of $%s batch), minutes since last rebalance=%d, threshold=%s%%",
    residual.toFixed(2),
    sharePct.toFixed(2),
    batch.toFixed(2),
    Math.round((Date.now() - state.lastRebalanceAt) / 60_000),
    TUNABLES.thresholdPct,
  );
  state.forceRebalance = true;
  state.residualCleanupInProgress = true;
  if (deps.updateBotState)
    deps.updateBotState({ residualCleanupInProgress: true });
}

/**
 * Decide whether this poll cycle should fire an automatic residual
 * cleanup.  When true is returned, the caller's bot state has already
 * been mutated to set `forceRebalance = true` and
 * `residualCleanupInProgress = true`; downstream gates (throttle,
 * pause, daily cap, dry-run) are still responsible for actually
 * executing or deferring.
 *
 * All of the following must hold for the function to arm:
 *   - `state.lastRebalanceAt` is set and at least `delayMs` old
 *   - No state flag blocks arming (see `_stateAllowsArming`)
 *   - `snap.residualValueUsd > 0` and `snap.currentValue > 0`
 *   - `residual / (LP + residual) * 100 > thresholdPct`
 *   - `throttle.canRebalance().allowed` (non-consuming check)
 *
 * @param {object} deps      Poll-cycle deps (uses `_botState`, `throttle`).
 * @param {object|null} snap P&L snapshot from `updatePnlAndStats` (may be null).
 * @returns {boolean} true iff cleanup was armed.
 */
function checkResidualCleanup(deps, snap) {
  if (!snap) return false;
  const state = deps._botState;
  const gate = _evaluateArmingGates(state);
  const { lpValue, residual, sharePct } = _residualShare(snap);
  if (!gate.allowed) {
    _logGateTransition(state, gate, sharePct);
    return false;
  }
  if (sharePct <= TUNABLES.thresholdPct) {
    _logGateTransition(
      state,
      { allowed: false, reason: "below-threshold" },
      sharePct,
    );
    return false;
  }
  const can = deps.throttle?.canRebalance?.();
  if (can && !can.allowed) {
    _logGateTransition(
      state,
      { allowed: false, reason: "throttled", detail: can.reason },
      sharePct,
    );
    return false;
  }
  /*- Clear transition memory on success so the next blocking reason
   *  after this cleanup fires logs fresh (e.g. cleanup-used). */
  _lastLoggedReason.delete(state);
  _armCleanup(deps, sharePct, residual, lpValue);
  return true;
}

/**
 * Classify the trigger behind the current rebalance based on the bot
 * state at rebalance-prepare time.
 *   residual-cleanup → automatic cleanup armed by `checkResidualCleanup`
 *   manual           → user clicked Rebalance Now (forceRebalance only)
 *   out-of-range     → default cause (OOR or OOR-timeout)
 *
 * @param {object|null} botState
 * @returns {"residual-cleanup"|"manual"|"out-of-range"}
 */
function classifyTrigger(botState) {
  if (botState?.residualCleanupInProgress) return "residual-cleanup";
  if (botState?.forceRebalance) return "manual";
  return "out-of-range";
}

/** Human-readable log reason for a classified trigger. */
function triggerReason(trigger) {
  if (trigger === "residual-cleanup")
    return "Residual cleanup rebalance (automatic)";
  if (trigger === "manual") return "Manual rebalance requested";
  return "Position out of range";
}

/**
 * Update residual-cleanup state after a successful rebalance.
 * Cleanup successes set `residualCleanupUsed` (prevents back-to-back
 * cleanup re-arming against the same baseline) but do NOT refresh
 * `lastRebalanceAt`.  Normal/manual successes clear the used flag and
 * stamp `lastRebalanceAt` so the next cleanup window starts.
 *
 * @param {object} state   Bot state object.
 * @param {string} trigger One of the values returned by `classifyTrigger`.
 * @param {Function|null} emit  Optional updateBotState callback.
 */
function updateCleanupState(state, trigger, emit) {
  if (trigger === "residual-cleanup") {
    state.residualCleanupUsed = true;
  } else {
    state.residualCleanupUsed = false;
    state.lastRebalanceAt = Date.now();
  }
  if (state.residualCleanupInProgress) {
    state.residualCleanupInProgress = false;
    if (emit) emit({ residualCleanupInProgress: false });
  }
}

/**
 * Compute the current total wallet-residual USD for this pool — the same
 * number the Lifetime panel shows.  Reads wallet balances on-chain and
 * caps the tracker's running residual to them (per residual-tracker's
 * contract — if the user withdrew tokens, only the wallet balance counts).
 * Returns 0 on any failure so callers can safely attach the result to
 * user-facing payloads without guarding.
 *
 * Used to enrich the post-rebalance `residualWarning` payload so the
 * "Residual Above Threshold" dialog shows the same total wallet residual
 * the Lifetime panel shows, rather than the corrective-swap loop's
 * last-iteration uncorrected imbalance (a smaller, more technical number).
 *
 * @param {object} deps     Bot-cycle deps (uses `_residualTracker`,
 *                          `provider`, `signer`, `_ethersLib`).
 * @param {object} result   Rebalance result (uses `poolAddress`,
 *                          `token0UsdPrice`, `token1UsdPrice`,
 *                          `decimals0`, `decimals1`).
 * @param {string} token0   token0 address
 * @param {string} token1   token1 address
 * @returns {Promise<number>}
 */
async function computeWalletResidualUsd(deps, result, token0, token1) {
  try {
    const tracker = deps._residualTracker;
    if (!tracker || !result?.poolAddress) return 0;
    const ethersLib = deps._ethersLib || require("ethers");
    const signerAddr = await deps.signer.getAddress();
    const t0 = new ethersLib.Contract(token0, ERC20_ABI, deps.provider);
    const t1 = new ethersLib.Contract(token1, ERC20_ABI, deps.provider);
    const [bal0, bal1] = await Promise.all([
      t0.balanceOf(signerAddr),
      t1.balanceOf(signerAddr),
    ]);
    return tracker.cappedValueUsd(
      result.poolAddress,
      bal0,
      bal1,
      result.token0UsdPrice || 0,
      result.token1UsdPrice || 0,
      result.decimals0 ?? 18,
      result.decimals1 ?? 18,
    );
  } catch (err) {
    console.warn(
      "[residual-warning] Could not compute wallet residual USD: %s",
      err.message ?? err,
    );
    return 0;
  }
}

module.exports = {
  checkResidualCleanup,
  classifyTrigger,
  triggerReason,
  updateCleanupState,
  computeWalletResidualUsd,
  TUNABLES,
  _DEFAULT_DELAY_MS,
  _DEFAULT_THRESHOLD_PCT,
};
