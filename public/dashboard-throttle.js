/**
 * @file dashboard-throttle.js
 * @description Trigger configuration, throttle state / UI, and the
 * Apply All function for the 9mm v3 Position Manager dashboard.
 *
 * Throttle state tracks daily rebalance counts and an optional
 * doubling-mode wait that activates when too many rebalances fire in
 * quick succession.  The UI badge and countdown are refreshed
 * every second by {@link updateThrottleUI}.
 *
 * Depends on: dashboard-helpers.js, dashboard-positions.js (posStore).
 */

import {
  g,
  act,
  ACT_ICONS,
  fmtCountdown,
  nextMidnight,
  botConfig,
  savePositionOorThreshold,
  compositeKey,
  fetchWithCsrf,
} from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";
import { _posLabel, markInputDirty } from "./dashboard-data.js";
import { isViewingClosedPos } from "./dashboard-closed-pos.js";
import { formatSettingChange } from "./dashboard-setting-labels.js";

// Late-bound import to avoid circular dep issues at evaluation time.
// Populated by dashboard-init.js after all modules load.
let _positionRangeVisual = null;

/**
 * Inject data references after all modules are loaded.
 * Called once from dashboard-init.js.
 * @param {object} deps  { positionRangeVisual }
 */
export function injectThrottleDeps(deps) {
  _positionRangeVisual = deps.positionRangeVisual;
}

// ── Trigger type ────────────────────────────────────────────────────────────

/** Trigger type: out of range (only supported type). */
export const TRIGGER_OOR = "oor";

/** Active trigger configuration. */
export const trigger = { type: TRIGGER_OOR };

// ── Throttle state ──────────────────────────────────────────────────────────

/** Mutable throttle state. */
export const throttle = {
  minIntervalMs: 10 * 60 * 1000,
  rebTimestamps: [],
  doublingActive: false,
  doublingCount: 0,
  currentWaitMs: 10 * 60 * 1000,
  lastRebTime: 0,
  dailyCount: 0,
  dailyMax: 0,
  dailyResetAt: nextMidnight(),
};

/**
 * Check whether a rebalance is currently allowed.
 * @returns {{allowed:boolean, msUntilAllowed:number, reason:string}}
 */
export function canRebalance() {
  const now = Date.now();
  if (throttle.dailyCount >= throttle.dailyMax) {
    return {
      allowed: false,
      msUntilAllowed: throttle.dailyResetAt - now,
      reason: "daily_limit",
    };
  }
  const wait = throttle.doublingActive
    ? throttle.currentWaitMs
    : throttle.minIntervalMs;
  const since = now - throttle.lastRebTime;
  if (throttle.lastRebTime > 0 && since < wait) {
    return {
      allowed: false,
      msUntilAllowed: wait - since,
      reason: throttle.doublingActive ? "doubling" : "min_interval",
    };
  }
  return { allowed: true, msUntilAllowed: 0, reason: "ok" };
}

/**
 * Re-read UI inputs and update throttle parameters.
 *
 * Deliberately does NOT read `#inMinInterval`: `throttle.minIntervalMs`
 * feeds derived displays (the Doubling Trigger Window label, the
 * countdown KPI), which must reflect the SAVED value — not unsaved
 * typing.  It is written only by `saveMinInterval()` (Save click) and
 * by the `/api/status` poll sync in dashboard-data-status.js (server's
 * saved value).  Before this gate, each keystroke moved the label and
 * the next poll snapped it back — a flicker the user read as the
 * setting having changed without a Save.
 */
export function onParamChange() {
  const maxEl = g("inMaxReb");
  throttle.dailyMax = parseInt(maxEl?.value) || throttle.dailyMax;
  updateThrottleUI();
}

/*-
 * Rebalance-control status (badge, countdowns, daily X/Y) is only
 * meaningful for Managed positions — Unmanaged positions have no bot
 * loop, no throttle counter, no scheduling. We surface that with an
 * "N/A" render plus a machine tooltip ("Only for Managed Positions"),
 * rather than letting client-side defaults paint a misleading state
 * (e.g. dailyMax=0 paints a false CAPPED).
 */
const _NA_TOOLTIP = "Only for Managed Positions";

/** Active position exists and is Unmanaged. */
function _isUnmanagedActive() {
  const a = posStore.getActive();
  return !!(a && !isPositionManaged(a.tokenId));
}

/** Render an "N/A" placeholder with the standard tooltip. */
function _renderNa(el, className) {
  if (!el) return;
  el.textContent = "N/A";
  if (className !== undefined) el.className = className;
  el.title = _NA_TOOLTIP;
}

/** Clear the N/A tooltip (used when re-rendering live values). */
function _clearNa(el) {
  if (el) el.title = "";
}

/**
 * Render the throttle badge (OK / NEAR LIMIT / LIMIT HIT / DOUBLING).
 * Unmanaged positions render "N/A" — see `_isUnmanagedActive`.
 * @param {number} pct  Daily usage percentage.
 */
function _renderThrottleBadge(pct) {
  const badge = g("throttleBadge");
  if (!badge) return;
  if (_isUnmanagedActive()) {
    _renderNa(badge, "live-badge");
    return;
  }
  _clearNa(badge);
  const check = canRebalance();
  if (throttle.dailyCount >= throttle.dailyMax) {
    badge.textContent = "CAPPED";
    badge.className = "warn-badge";
  } else if (throttle.doublingActive) {
    badge.textContent = "DOUBLING \u00D7" + (throttle.doublingCount + 1);
    badge.className = "dbl-badge";
  } else if (!check.allowed && check.reason === "min_interval") {
    badge.textContent = "THROTTLED";
    badge.className = "warn-badge";
  } else if (pct >= 80) {
    badge.textContent = "NEAR LIMIT";
    badge.className = "warn-badge";
  } else {
    badge.textContent = "OK";
    badge.className = "live-badge";
  }
}

/**
 * Check banner visibility and handle closed-position display.
 * @param {HTMLElement} banner  The range banner element.
 * @returns {boolean}  true if the caller should continue rendering OOR state.
 */
function _checkBannerVisibility(banner) {
  if (isViewingClosedPos()) {
    if (!botConfig.price || !botConfig.lower || !botConfig.upper) {
      banner.style.display = "none";
      return false;
    }
    banner.style.display = "";
    return true;
  }
  const active = posStore.getActive();
  const liq = active ? active.liquidity : undefined;
  if (
    !botConfig.price ||
    !botConfig.lower ||
    !botConfig.upper ||
    liq === undefined ||
    liq === null
  ) {
    banner.style.display = "none";
    return false;
  }
  banner.style.display = "";
  if (String(liq) === "0") {
    banner.className = "range-status-banner wait";
    g("rangeIcon").textContent = "\u2014";
    g("rangeLabel").textContent = "POSITION CLOSED";
    return false;
  }
  return true;
}

/** Render OOR sub-state for a managed position (threshold, doubling, triggered). */
function _renderManagedOor(banner, can) {
  if (botConfig.withinThreshold) {
    banner.className = "range-status-banner wait";
    g("rangeIcon").textContent = "\u26A0";
    let threshLabel = "OUT OF RANGE \u2014 WITHIN THRESHOLD";
    const timeoutMin = parseInt(g("inOorTimeout")?.value, 10) || 0;
    if (timeoutMin > 0 && botConfig.oorSince) {
      const remaining = botConfig.oorSince + timeoutMin * 60000 - Date.now();
      threshLabel += " \u00B7 Timeout: " + fmtCountdown(remaining);
    }
    g("rangeLabel").textContent = threshLabel;
  } else if (!can.allowed) {
    const icon = throttle.doublingActive ? "\u26A1" : "\u23F3";
    const cls = throttle.doublingActive ? "dbl" : "wait";
    const label = throttle.doublingActive ? "DOUBLING WAIT" : "WAITING";
    banner.className = "range-status-banner " + cls;
    g("rangeIcon").textContent = icon;
    g("rangeLabel").textContent =
      "OUT OF RANGE \u2014 " + label + ": " + fmtCountdown(can.msUntilAllowed);
  } else {
    banner.className = "range-status-banner out";
    g("rangeIcon").textContent = "\u2717";
    g("rangeLabel").textContent = "OUT OF RANGE \u2014 REBALANCE TRIGGERED";
  }
}

/**
 * Render the range status banner based on price position and throttle state.
 * @param {{allowed:boolean, msUntilAllowed:number, reason:string}} can
 */
function _renderRangeBanner(can) {
  const banner = g("rangeBanner");
  if (!banner || !_checkBannerVisibility(banner)) return;
  /*- Residual-cleanup rebalance in flight overrides both in-range and
   *  OOR messaging. Yellow flashing bar mirrors the red OOR bar's
   *  attention level without conflating the two states. */
  if (botConfig.residualCleanupInProgress) {
    banner.className = "range-status-banner residual";
    g("rangeIcon").textContent = "\u26A1";
    g("rangeLabel").textContent =
      "Rebalancing to Reduce Residual Wallet Coin Amount";
    return;
  }
  const inR =
    botConfig.price >= botConfig.lower && botConfig.price <= botConfig.upper;
  if (inR) {
    banner.className = "range-status-banner in";
    g("rangeIcon").textContent = "\u2713";
    g("rangeLabel").textContent = "PRICE IN RANGE \u2014 EARNING FEES";
    return;
  }
  const active = posStore.getActive();
  if (active && isPositionManaged(active.tokenId)) {
    _renderManagedOor(banner, can);
    return;
  }
  banner.className = "range-status-banner out";
  g("rangeIcon").textContent = "\u2717";
  g("rangeLabel").textContent = "OUT OF RANGE";
}

/** Update the rebalance interval KPI. */
function _renderCountdownKpi(can) {
  const cd = g("kpiCountdown");
  if (_isUnmanagedActive()) {
    _renderNa(cd, "kpi-value neu");
    return;
  }
  _clearNa(cd);
  const minIntervalEl = g("inMinInterval");
  const minIntervalMin = minIntervalEl
    ? parseInt(minIntervalEl.value, 10) || 10
    : 10;
  if (can.allowed) {
    if (cd) {
      cd.textContent = minIntervalMin + " min";
      cd.className = "kpi-value neu";
    }
  } else {
    const reason =
      can.reason === "daily_limit"
        ? "Daily Limit"
        : throttle.doublingActive
          ? "Doubling"
          : "";
    if (cd) {
      cd.textContent =
        fmtCountdown(can.msUntilAllowed) + (reason ? " \u2014 " + reason : "");
      cd.className = "kpi-value " + (throttle.doublingActive ? "dbl" : "wrn");
    }
  }
}

/*- Render the "Doubling Trigger Window" label to `4 × minIntervalMs`.
 *  Kept in sync with `src/throttle.js`'s `window4 = 4 * state.minIntervalMs`
 *  — if that multiplier ever changes there, change it here too. */
function _renderDoublingWindowLabel() {
  const el = g("dblWindowLabel");
  if (!el) return;
  el.textContent = (4 * throttle.minIntervalMs) / 60000 + " min";
}

/** Refresh all throttle-related UI elements (badge, countdown, banner). */
export function updateThrottleUI() {
  const can = canRebalance();
  const pct = Math.min(100, (throttle.dailyCount / throttle.dailyMax) * 100);
  _renderThrottleBadge(pct);
  _renderCountdownKpi(can);
  _renderRangeBanner(can);
  _renderDoublingWindowLabel();
}

/*-
 * Show or hide the yellow inline warning that explains why the
 * OOR-timeout setting becomes meaningless when Min Time Between
 * Rebalances >= OOR Rebalance Time Threshold. Called only from
 * saveMinInterval / saveOorTimeout — not on every render — so the
 * banner appears as feedback to the user's own action.
 *
 * Rationale: every rebalance attempt (including the timeout-driven
 * one) must clear the min-interval gate. If min >= timeout, the
 * timeout fires but the gate blocks it until min elapses, so the
 * timeout value never actually determines when the rebalance runs.
 */
function _validateIntervalVsTimeout() {
  const warn = g("intervalVsTimeoutWarn");
  if (!warn) return;
  const minVal = parseInt(g("inMinInterval")?.value, 10);
  const tmoVal = parseInt(g("inOorTimeout")?.value, 10);
  if (
    !Number.isFinite(minVal) ||
    !Number.isFinite(tmoVal) ||
    tmoVal === 0 ||
    minVal < tmoVal
  ) {
    warn.hidden = true;
    warn.textContent = "";
    return;
  }
  warn.hidden = false;
  warn.textContent =
    "Heads up: Min Time Between Rebalances (" +
    minVal +
    " min) is not less than OOR Rebalance Time Threshold (" +
    tmoVal +
    " min). OOR Rebalance Time Threshold is the timer that fires when " +
    "the price sits between the established price range and the red " +
    "bars on the position diagram (the buffer set by OOR Threshold " +
    "Before Rebalance Is Triggered). It won't take effect, because " +
    "Min Time Between Rebalances blocks every rebalance. Set Min Time " +
    "Between Rebalances below OOR Rebalance Time Threshold. " +
    "Note: when the price moves past the red bars on the position " +
    "diagram (OOR Threshold Before Rebalance Is Triggered), that " +
    "still triggers an immediate rebalance, as soon as Min Time " +
    "Between Rebalances has elapsed since the previous rebalance.";
}

/** Save the OOR timeout setting and persist to backend. */
export function saveOorTimeout() {
  const el = g("inOorTimeout");
  const val = parseInt(el?.value, 10);
  /*- No literal fallback per feedback_one_literal_per_shipped_default:
   *  reject invalid input instead of silently substituting a literal.
   *  User must re-enter a valid value to save. */
  if (!Number.isFinite(val) || val < 0) return;
  const timeoutMin = val;
  if (el) el.value = timeoutMin;
  markInputDirty("inOorTimeout");
  const active = posStore.getActive();
  const positionKey = active
    ? compositeKey(
        "pulsechain",
        active.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : undefined;
  fetchWithCsrf("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rebalanceTimeoutMin: timeoutMin, positionKey }),
  }).catch(function () {
    /* dashboard-only mode */
  });
  _validateIntervalVsTimeout();
}

/** Save just the OOR threshold, update the preview, and persist to backend. */
export function saveOorThreshold() {
  const raw = parseFloat(g("inOorThreshold")?.value);
  /*- No literal fallback per feedback_one_literal_per_shipped_default:
   *  reject invalid input instead of silently substituting a literal.
   *  User must re-enter a valid value (1..100) to save. */
  if (!Number.isFinite(raw)) return;
  botConfig.oorThreshold = Math.min(100, Math.max(1, raw));
  const inp = g("inOorThreshold");
  if (inp) inp.value = botConfig.oorThreshold;
  markInputDirty("inOorThreshold");
  const disp = g("activeOorThreshold");
  if (disp) disp.textContent = botConfig.oorThreshold;
  const activePos = posStore.getActive();
  if (activePos) savePositionOorThreshold(activePos, botConfig.oorThreshold);
  if (_positionRangeVisual) _positionRangeVisual();
  const positionKey = activePos
    ? compositeKey(
        "pulsechain",
        activePos.walletAddress,
        activePos.contractAddress,
        activePos.tokenId,
      )
    : undefined;
  fetchWithCsrf("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rebalanceOutOfRangeThresholdPercent: botConfig.oorThreshold,
      positionKey,
    }),
  }).catch(function () {
    /* dashboard-only mode */
  });
}

/** Save a single config key from an input element. */
export function _saveSingleConfig(inputId, key, parse) {
  markInputDirty(inputId);
  const val = parse(g(inputId)?.value);
  const active = posStore.getActive();
  const positionKey = active
    ? compositeKey(
        "pulsechain",
        active.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : undefined;
  fetchWithCsrf("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: val, positionKey }),
  }).catch(() => {});
  const pl = _posLabel();
  act(
    ACT_ICONS.gear,
    "start",
    "Setting Saved",
    formatSettingChange(key, val) + (pl ? "\n" + pl : ""),
  );
}

/** Save min rebalance interval. */
/**
 * Apply a SAVED Min Time Between Rebalances value (minutes) to the
 * client throttle so the derived displays (Doubling Trigger Window
 * label, countdown KPI) reflect it.  Two callers:
 *   - `saveMinInterval()` — optimistic apply on the Save click;
 *   - `_populateConfigInputs()` in dashboard-data.js — per-position
 *     seed from the saved config in the /api/status payload.  This
 *     covers dashboard-only mode (bots not running → no
 *     `throttleState` in the payload at all) and the window before a
 *     freshly-started bot's first poll emits a snapshot.
 * Invalid input is ignored (no literal fallback per
 * feedback_one_literal_per_shipped_default).
 * @param {number} minutes  Saved Min Time Between Rebalances.
 */
export function applySavedMinInterval(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return;
  throttle.minIntervalMs = minutes * 60 * 1000;
  if (!throttle.doublingActive) throttle.currentWaitMs = throttle.minIntervalMs;
  updateThrottleUI();
}

export function saveMinInterval() {
  const n = parseInt(g("inMinInterval")?.value, 10);
  /*- No literal fallback per feedback_one_literal_per_shipped_default:
   *  reject invalid input rather than silently using a literal default. */
  if (!Number.isFinite(n) || n < 1) return;
  /*- Optimistic client apply on Save: the Doubling Trigger Window label
   *  and countdown KPI derive from `throttle.minIntervalMs`, which is
   *  save-gated (see `onParamChange`).  Applying here makes the label
   *  reflect the new value on the Save click itself instead of waiting
   *  up to one poll cycle for the server round-trip. */
  applySavedMinInterval(n);
  _saveSingleConfig("inMinInterval", "minRebalanceIntervalMin", () => n);
  _validateIntervalVsTimeout();
}
/** Save max rebalances per day. */
export function saveMaxReb() {
  const n = parseInt(g("inMaxReb")?.value, 10);
  /*- No literal fallback per feedback_one_literal_per_shipped_default:
   *  reject invalid input rather than silently using `throttle.dailyMax`.
   *  The user must enter a valid positive integer to save. */
  if (!Number.isFinite(n) || n < 1) return;
  _saveSingleConfig("inMaxReb", "maxRebalancesPerDay", () => n);
  const el = g("kpiToday");
  if (el) {
    const cur = parseInt(el.textContent, 10) || 0;
    el.textContent = cur + " / " + n;
  }
}
/*- `saveSlippage` (and its `_validSlip` validator) was removed when
 *  the single "Slippage Tolerance" input was replaced by two
 *  per-token inputs (slippagePctToken0 / slippagePctToken1) driven
 *  by dashboard-per-token-slippage.js.  The per-position
 *  `slippagePct` field remains valid in bot-config.json so existing
 *  saved values load without error; the swap layer's
 *  `resolveSlippagePct` uses per-token values (or the shipped
 *  default when unset) — the legacy value is dormant. */

/** Save check interval. */
export function saveCheckInterval() {
  const n = parseInt(g("inInterval")?.value, 10);
  /*- No literal fallback per feedback_one_literal_per_shipped_default:
   *  reject invalid input rather than silently substituting a literal
   *  (the previous `|| 60` was a stale fallback — the shipped JSON
   *  default is now 300, not 60). */
  if (!Number.isFinite(n) || n < 1) return;
  _saveSingleConfig("inInterval", "checkIntervalSec", () => n);
}
/** Save gas strategy. */
export function saveGasStrategy() {
  _saveSingleConfig("inGas", "gasStrategy", (v) => v || "auto");
}

/** Update the complement offset input when one changes. */
export function updateOffsetComplement(sourceId) {
  const src = g(sourceId);
  if (!src) return;
  const val = Math.max(0, Math.min(100, parseInt(src.value, 10) || 0));
  src.value = val;
  const otherId =
    sourceId === "inOffsetToken0" ? "inOffsetToken1" : "inOffsetToken0";
  const other = g(otherId);
  if (other) other.value = 100 - val;
}

/** Save the current offset value. */
export function saveOffset() {
  const el = g("inOffsetToken0");
  const n = parseInt(el?.value, 10);
  /*- No literal fallback per feedback_one_literal_per_shipped_default:
   *  reject invalid input rather than silently substituting a literal. */
  if (!Number.isFinite(n)) return;
  const val = Math.max(0, Math.min(100, n));
  if (el) el.value = val;
  const other = g("inOffsetToken1");
  if (other) other.value = 100 - val;
  _saveSingleConfig("inOffsetToken0", "offsetToken0Pct", () => val);
}

/** Save the Approval Multiple (global). */
export function saveApprovalMultiple() {
  const el = g("inApprovalMultiple");
  let val = parseInt(el?.value, 10);
  if (!Number.isFinite(val) || val < 1) val = 1;
  if (val > 1_000_000) val = 1_000_000;
  if (el) el.value = val;
  _saveSingleConfig("inApprovalMultiple", "approvalMultiple", () => val);
}

/** Reset offset to 50/50 and save. */
export function resetOffset() {
  const el0 = g("inOffsetToken0");
  const el1 = g("inOffsetToken1");
  if (el0) el0.value = 50;
  if (el1) el1.value = 50;
  saveOffset();
}

/*- The Price Range Extension config handlers (`saveRangeWidth`,
 *  `resetRangeWidth`, `setDefaultRangeWidth`, `saveFullRangeToggle`)
 *  live in `dashboard-price-range-extension.js` — extracted from this
 *  file when the Full-Range checkbox handler was added and this file
 *  passed the 500-line cap. */

/** Update OOR threshold + timeout display from status. */
export function updateTriggerDisplay(d) {
  const th = g("activeOorThreshold");
  if (th && d.rebalanceOutOfRangeThresholdPercent !== undefined)
    th.textContent = d.rebalanceOutOfRangeThresholdPercent;
  const to = g("activeOorTimeout");
  if (to)
    to.textContent =
      d.rebalanceTimeoutMin > 0
        ? d.rebalanceTimeoutMin
        : d.rebalanceTimeoutMin === 0
          ? "disabled"
          : "\u2014";
}
