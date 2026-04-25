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
  csrfHeaders,
} from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";
import {
  _createModal,
  _posLabel,
  _posContextHtml,
  markInputDirty,
} from "./dashboard-data.js";
import { isViewingClosedPos } from "./dashboard-closed-pos.js";

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

/** Re-read UI inputs and update throttle parameters. */
export function onParamChange() {
  const minEl = g("inMinInterval"),
    maxEl = g("inMaxReb");
  throttle.minIntervalMs = (parseInt(minEl?.value) || 10) * 60 * 1000;
  throttle.dailyMax = parseInt(maxEl?.value) || throttle.dailyMax;
  if (!throttle.doublingActive) throttle.currentWaitMs = throttle.minIntervalMs;
  updateThrottleUI();
}

/**
 * Render the throttle badge (OK / NEAR LIMIT / LIMIT HIT / DOUBLING).
 * @param {number} pct  Daily usage percentage.
 */
function _renderThrottleBadge(pct) {
  const badge = g("throttleBadge");
  if (!badge) return;
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
  const minIntervalEl = g("inMinInterval");
  const minIntervalMin = minIntervalEl
    ? parseInt(minIntervalEl.value, 10) || 10
    : 10;
  const cd = g("kpiCountdown");
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

/** Refresh all throttle-related UI elements (badge, countdown, banner). */
export function updateThrottleUI() {
  const can = canRebalance();
  const pct = Math.min(100, (throttle.dailyCount / throttle.dailyMax) * 100);
  _renderThrottleBadge(pct);
  _renderCountdownKpi(can);
  _renderRangeBanner(can);
}

/** Save the OOR timeout setting and persist to backend. */
export function saveOorTimeout() {
  const el = g("inOorTimeout");
  const val = parseInt(el?.value, 10);
  const timeoutMin = Number.isFinite(val) && val >= 0 ? val : 180;
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
  fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ rebalanceTimeoutMin: timeoutMin, positionKey }),
  }).catch(function () {
    /* dashboard-only mode */
  });
}

/** Save just the OOR threshold, update the preview, and persist to backend. */
export function saveOorThreshold() {
  botConfig.oorThreshold = Math.min(
    100,
    Math.max(1, parseFloat(g("inOorThreshold")?.value) || 5),
  );
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
  fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({
      rebalanceOutOfRangeThresholdPercent: botConfig.oorThreshold,
      positionKey,
    }),
  }).catch(function () {
    /* dashboard-only mode */
  });
}

/** Save a single config key from an input element. */
function _saveSingleConfig(inputId, key, parse) {
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
  fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify({ [key]: val, positionKey }),
  }).catch(() => {});
  const pl = _posLabel();
  act(
    ACT_ICONS.gear,
    "start",
    "Setting Saved",
    key + " = " + val + (pl ? "\n" + pl : ""),
  );
}

/** Save min rebalance interval. */
export function saveMinInterval() {
  _saveSingleConfig(
    "inMinInterval",
    "minRebalanceIntervalMin",
    (v) => parseInt(v, 10) || 10,
  );
}
/** Save max rebalances per day. */
export function saveMaxReb() {
  const val = parseInt(g("inMaxReb")?.value, 10) || throttle.dailyMax;
  _saveSingleConfig("inMaxReb", "maxRebalancesPerDay", () => val);
  const el = g("kpiToday");
  if (el) {
    const cur = parseInt(el.textContent, 10) || 0;
    el.textContent = cur + " / " + val;
  }
}
/** Save slippage tolerance. */
function _validSlip(v) {
  const n = parseFloat(v),
    d = botConfig.defaultSlip || 0.5;
  if (!Number.isFinite(n) || n < 0 || n > 99) return d;
  return n;
}
export function saveSlippage() {
  const val = _validSlip(g("inSlip")?.value);
  const el = g("inSlip");
  if (el) el.value = val;
  if (val === 0)
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Slippage Set to 0%",
      _posContextHtml() +
        "<p>Trades will fail with zero slippage unless pool conditions are perfectly stable.</p>" +
        '<p class="9mm-pos-mgr-text-muted">Set a small value like 0.3\u20131% for normal operation.</p>',
    );
  else if (val > 20)
    _createModal(
      null,
      "9mm-pos-mgr-modal-caution",
      "Slippage Very High",
      _posContextHtml() +
        "<p>Slippage of " +
        val +
        "% may result in significant loss of funds.</p>",
    );
  _saveSingleConfig("inSlip", "slippagePct", () => val);
}
/** Save check interval. */
export function saveCheckInterval() {
  _saveSingleConfig(
    "inInterval",
    "checkIntervalSec",
    (v) => parseInt(v, 10) || 60,
  );
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
  const val = Math.max(0, Math.min(100, parseInt(el?.value, 10) || 50));
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

export {
  openRebalanceRangeModal,
  closeRebalanceRangeModal,
  updateRebalanceRangeHint,
  confirmRebalanceRange,
} from "./dashboard-throttle-rebalance.js";

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
