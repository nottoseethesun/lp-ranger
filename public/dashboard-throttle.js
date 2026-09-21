/**
 * @file dashboard-throttle.js
 * @description Trigger configuration, throttle state / UI, and the
 * Apply All function for the LP Ranger dashboard.
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
} from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";
import {
  _posLabel,
  markInputDirty,
  getInputDefault,
} from "./dashboard-data.js";
import { isViewingClosedPos } from "./dashboard-closed-pos.js";
import { formatSettingChange } from "./dashboard-setting-labels.js";
import { saveConfigValues } from "./dashboard-config-save.js";

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

/**
 * Render an "N/A" placeholder.
 *
 * @param {HTMLElement|null} el
 * @param {string} [className]
 * @param {string} [tooltip]  Title to attach; pass `""` where the help
 *   lives on a neighbouring circle-i instead.  A tooltip on the figure
 *   itself is invisible on touch and unadvertised on desktop, so it is
 *   only right for elements that have no icon beside them — currently
 *   just the Bot Settings throttle badge.
 */
function _renderNa(el, className, tooltip) {
  if (!el) return;
  el.textContent = "N/A";
  if (className !== undefined) el.className = className;
  el.title = tooltip === undefined ? _NA_TOOLTIP : tooltip;
}

/** Clear the N/A tooltip (used when re-rendering live values). */
function _clearNa(el) {
  if (el) el.title = "";
}

/**
 * Render the throttle badge.  Six states, resolved as a FIRST-MATCH
 * ladder — the order is the point, since more than one can be true at
 * once and the badge shows the most binding constraint:
 *
 *   1. `N/A`        — position is not managed; nothing is scheduled.
 *   2. `CAPPED`     — the pool hit Max Rebalances / Day.
 *   3. `DOUBLING ×N`— doubling mode is active (longer cooldown).
 *   4. `THROTTLED`  — inside the Min Time Between Rebalances cooldown.
 *   5. `NEAR LIMIT` — at or past 80% of the daily cap, nothing blocked.
 *   6. `OK`         — free to rebalance now.
 *
 * Because the ladder short-circuits, `NEAR LIMIT` only shows when the
 * bot is otherwise free to act: at 4 of 5 but mid-cooldown the badge
 * reads THROTTLED, which is the more immediate constraint.
 *
 * Every one of these has a matching section in the `throttleBadge`
 * entry of `param-help-content.js` — a state the badge can paint with
 * no explanation behind the circle-i is a user staring at a word with
 * nowhere to look it up.  `test/dashboard-param-help-coverage.js`
 * pins the pairing.
 *
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
    /*- Help lives on the circle-i beside the "Rebalance Interval"
     *  label, not on this figure — see `_renderNa`. */
    _renderNa(cd, "kpi-value neu", "");
    return;
  }
  _clearNa(cd);
  /*- Save-gated: render from `throttle.minIntervalMs` (the saved
   *  value) — NOT the raw input, which may hold unsaved typing.
   *  Keeps this KPI consistent with the Doubling Trigger Window
   *  label (audit finding: the two adjacent displays disagreed
   *  while typing). */
  const minIntervalMin = Math.round(throttle.minIntervalMs / 60000);
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
  markInputDirty("inOorTimeout");
  _saveSingleConfig("inOorTimeout", "rebalanceTimeoutMin", (v) =>
    parseInt(v, 10),
  );
  _validateIntervalVsTimeout();
}

/**
 * Save the Impermanent Loss Guard percent.
 *
 * Sends what was typed. The server decides whether it is acceptable and
 * says so; the badge under Trigger Type follows on the next poll via
 * `updateTriggerDisplay`.
 */
export function saveIlGuard() {
  const pct = parseInt(g("inIlGuard")?.value, 10);
  _saveSingleConfig("inIlGuard", "impermanentLossGuardPct", () => pct);
  const disp = g("activeIlGuard");
  if (disp) disp.textContent = String(pct);
}

/** Save just the OOR threshold, update the preview, and persist to backend. */
export function saveOorThreshold() {
  const raw = parseFloat(g("inOorThreshold")?.value);
  markInputDirty("inOorThreshold");
  _saveSingleConfig(
    "inOorThreshold",
    "rebalanceOutOfRangeThresholdPercent",
    () => raw,
  );
  /*- The derived displays follow the typed value straight away, as they
   *  always have: the diagram is a preview, the poll re-syncs it from
   *  the server every cycle, and a refused save has already put the
   *  field back by then. Nothing here decides whether the value is
   *  acceptable — that is `src/config-bounds.js`. */
  botConfig.oorThreshold = raw;
  const disp = g("activeOorThreshold");
  if (disp) disp.textContent = raw;
  const activePos = posStore.getActive();
  if (activePos) savePositionOorThreshold(activePos, raw);
  if (_positionRangeVisual) _positionRangeVisual();
}

/**
 * Save one Bot Settings input, whatever it holds.
 *
 * Nothing here judges the value — `src/config-bounds.js` on the server
 * does that, and `saveConfigValues` puts the field back and says why
 * when it is refused.
 *
 * @param {string} inputId
 * @param {string} key              The config key to write.
 * @param {Function} parse          Turns the field's text into the value.
 * @param {Function} [onSaved]      Ran only once the server has taken it.
 * @returns {void}
 */
export function _saveSingleConfig(inputId, key, parse, onSaved) {
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
  saveConfigValues({
    values: { [key]: val },
    positionKey,
    inputs: { [key]: inputId },
    onSaved: () => {
      /*- Logged once the server has taken it, not when the request goes
       *  out: a refused save would otherwise read "Setting Saved" in the
       *  Activity Log while the dialog says it was rejected. */
      const pl = _posLabel();
      act(
        ACT_ICONS.gear,
        "start",
        "Setting Saved",
        formatSettingChange(key, val) + (pl ? "\n" + pl : ""),
      );
      if (onSaved) onSaved();
    },
  });
}

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
  /*- Coerce before validating: hand-edited bot-config.json can carry
   *  string-typed numbers, and the status payload spreads config
   *  values verbatim. */
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 1) return;
  throttle.minIntervalMs = n * 60 * 1000;
  if (!throttle.doublingActive) throttle.currentWaitMs = throttle.minIntervalMs;
  updateThrottleUI();
}

/**
 * Apply a polled `throttleState.minIntervalMs` to the client throttle,
 * honoring the one-shot `data-skip-next-poll` marker on
 * `#dblWindowLabel`.  `saveMinInterval` sets that marker because the
 * bot only refreshes its emitted `throttleState` snapshot on its own
 * poll cycle (`POST /api/config` does not kick the bot poll) — so the
 * first dashboard sweep after a Save still carries the PRE-save value
 * and would clobber the optimistic apply, showing a one-sweep revert.
 * The poll consumes the marker (removes it) and skips that single
 * update; subsequent sweeps apply normally.
 * @param {number} minIntervalMs  From the polled `throttleState`.
 */
export function applyPolledMinInterval(minIntervalMs) {
  if (typeof minIntervalMs !== "number") return;
  const lbl = g("dblWindowLabel");
  if (lbl && lbl.dataset.skipNextPoll !== undefined) {
    delete lbl.dataset.skipNextPoll;
    return;
  }
  throttle.minIntervalMs = minIntervalMs;
}

/** Save Min Time Between Rebalances: validate, apply optimistically,
 *  stamp the one-shot poll-skip marker, persist to the server. */
export function saveMinInterval() {
  const n = parseInt(g("inMinInterval")?.value, 10);
  /*- Optimistic client apply on Save: the Doubling Trigger Window label
   *  and countdown KPI derive from `throttle.minIntervalMs`, which is
   *  save-gated (see `onParamChange`). Applying here makes the label
   *  reflect the new value on the Save click itself instead of waiting
   *  for the round-trip; the poll re-syncs it from the server every
   *  cycle, so a refused value does not persist on screen. */
  applySavedMinInterval(n);
  /*- One-shot poll-skip marker — see `applyPolledMinInterval`. */
  const lbl = g("dblWindowLabel");
  if (lbl) lbl.dataset.skipNextPoll = "1";
  _saveSingleConfig("inMinInterval", "minRebalanceIntervalMin", () => n);
  _validateIntervalVsTimeout();
}
/** Save max rebalances per day. */
export function saveMaxReb() {
  const n = parseInt(g("inMaxReb")?.value, 10);
  _saveSingleConfig("inMaxReb", "maxRebalancesPerDay", () => n);
  const el = g("kpiToday");
  if (el) {
    const cur = parseInt(el.textContent, 10) || 0;
    el.textContent = cur + " / " + n;
  }
}
/*- `saveSlippage` (and its `_validSlip` validator) was removed when
 *  the single "Slippage Tolerance" input was replaced by two per-token
 *  inputs (slippagePctToken0 / slippagePctToken1) driven by
 *  dashboard-per-token-slippage.js.  The per-position `slippagePct`
 *  that row used to save is retired and dropped on load; every swap
 *  now asks `resolveSlippagePct` for the destination token's value. */

/** Save check interval. */
export function saveCheckInterval() {
  _saveSingleConfig("inInterval", "checkIntervalSec", (v) => parseInt(v, 10));
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
  const val = parseInt(g("inOffsetToken0")?.value, 10);
  _saveSingleConfig("inOffsetToken0", "offsetToken0Pct", () => val);
  /*- The two shares add to 100, so the companion field tracks this one.
   *  Whether the figure is acceptable is the server's answer, not this
   *  field's. */
  const other = g("inOffsetToken1");
  if (other) other.value = 100 - val;
}

/** Save the Approval Multiple (global). */
export function saveApprovalMultiple() {
  _saveSingleConfig("inApprovalMultiple", "approvalMultiple", (v) =>
    parseInt(v, 10),
  );
}

/**
 * "No Offset" button: put the shipped centred offset into both inputs
 * and stop there.  It does NOT persist — only Save writes config, which
 * is how every other edit row in the app behaves.  Mirrors the Price
 * Range Extension row's "Default" button: inject, mark dirty so the next
 * poll's sync can't clobber the injected value, and leave the user to
 * click Save.
 *
 * No-op until `/api/bot-config-defaults` resolves — no literal fallback
 * per feedback_one_literal_per_shipped_default; the centred value lives
 * only in bot-config-defaults.json.
 */
export function resetOffset() {
  const def = getInputDefault("offsetToken0Pct");
  if (!Number.isFinite(def)) return;
  const el0 = g("inOffsetToken0");
  const el1 = g("inOffsetToken1");
  if (el0) el0.value = String(def);
  if (el1) el1.value = String(100 - def);
  markInputDirty("inOffsetToken0");
}

/*- The Price Range Extension config handlers (`saveRangeWidth`,
 *  `setDefaultRangeWidth`, `onFullRangeToggle`)
 *  live in `dashboard-price-range-extension.js` — extracted from this
 *  file when the Full-Range checkbox handler was added and this file
 *  passed the 500-line cap. */

/** Update OOR threshold + timeout display from status. */
export function updateTriggerDisplay(d) {
  const th = g("activeOorThreshold");
  if (th && d.rebalanceOutOfRangeThresholdPercent !== undefined)
    th.textContent = d.rebalanceOutOfRangeThresholdPercent;
  const ilg = g("activeIlGuard");
  if (ilg && d.impermanentLossGuardPct !== undefined)
    ilg.textContent = d.impermanentLossGuardPct;
  const to = g("activeOorTimeout");
  if (to)
    to.textContent =
      d.rebalanceTimeoutMin > 0
        ? d.rebalanceTimeoutMin
        : d.rebalanceTimeoutMin === 0
          ? "disabled"
          : "\u2014";
}
