/**
 * @file dashboard-data-deposit.js
 * @description Deposit, realized gains, and shared
 * localStorage helpers. Split from dashboard-data.js.
 */
import { g, compositeKey, csrfHeaders } from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";

let _refetchUnmanaged = null;
let _lastStatusRef = null;
let _updateKpisRef = null;

/** Inject re-fetch callback (avoids circular). */
export function injectDataDeps(deps) {
  if (deps.refetchUnmanaged) _refetchUnmanaged = deps.refetchUnmanaged;
}

/** Wire KPI updater so deposit saves refresh. */
export function _wireDepositKpis(getLast, updKpis) {
  _lastStatusRef = getLast;
  _updateKpisRef = updKpis;
}

// ── Shared helpers ────────────────────────────────

export function _posKey(prefix) {
  const a = posStore.getActive();
  return a ? prefix + (a.tokenId || "unknown") : null;
}
export function _poolKey(prefix) {
  const a = posStore.getActive();
  if (!a?.token0 || !a?.token1 || !a?.walletAddress) return null;
  return (
    prefix +
    "pulsechain_" +
    a.walletAddress.toLowerCase() +
    "_" +
    (a.contractAddress || "").toLowerCase() +
    "_" +
    a.token0.toLowerCase() +
    "_" +
    a.token1.toLowerCase() +
    "_" +
    (a.fee || 0)
  );
}
export function _loadNum(key, allowZero) {
  if (!key) return 0;
  try {
    const v = parseFloat(localStorage.getItem(key));
    return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : 0;
  } catch {
    return 0;
  }
}
export function _toggleWrap(wrapId, inputId, loadFn) {
  const wrap = g(wrapId);
  if (!wrap) return;
  const show = !wrap.classList.contains("open");
  wrap.classList.toggle("open", show);
  if (show) {
    const inp = g(inputId);
    if (inp) {
      inp.value = loadFn() || "";
      inp.focus();
    }
  }
}
export function _saveInput(key, inputId, wrapId, afterSave, allowZero) {
  const inp = g(inputId);
  if (!key || !inp) return;
  const val = parseFloat(inp.value);
  const amount =
    Number.isFinite(val) && (allowZero ? val >= 0 : val > 0) ? val : 0;
  try {
    localStorage.setItem(key, String(amount));
  } catch {
    /* private mode */
  }
  const wrap = g(wrapId);
  if (wrap) wrap.classList.remove("open");
  if (afterSave) afterSave(amount);
}

// ── Realized gains ────────────────────────────────

export function loadRealizedGains() {
  return _loadNum(_poolKey("9mm_realized_pool_"), true);
}
export function toggleRealizedInput() {
  _toggleWrap(
    "realizedGainsInputWrap",
    "realizedGainsInput",
    loadRealizedGains,
  );
}
export function saveRealizedGains() {
  const key = _poolKey("9mm_realized_pool_");
  _saveInput(
    key,
    "realizedGainsInput",
    "realizedGainsInputWrap",
    () => {
      const ls = _lastStatusRef?.();
      if (ls && _updateKpisRef) _updateKpisRef(ls);
    },
    true,
  );
}

// ── Per-position realized gains ───────────────────

export function loadCurRealized() {
  return _loadNum(_posKey("9mm_realized_pos_"), true);
}
export function toggleCurRealized() {
  _toggleWrap("curRealizedInputWrap", "curRealizedInput", loadCurRealized);
}
export function saveCurRealized() {
  _saveInput(
    _posKey("9mm_realized_pos_"),
    "curRealizedInput",
    "curRealizedInputWrap",
    () => {
      const ls = _lastStatusRef?.();
      if (ls && _updateKpisRef) _updateKpisRef(ls);
    },
    true,
  );
}

// ── Initial deposit ───────────────────────────────

export function loadInitialDeposit() {
  return _loadNum(_poolKey("9mm_deposit_pool_"), false);
}
export function refreshDepositLabel() {
  const s = loadInitialDeposit(),
    d = g("lifetimeDepositDisplay"),
    l = g("initialDepositLabel");
  if (d) d.textContent = s > 0 ? "$usd " + s.toFixed(2) : "\u2014";
  if (l) l.textContent = "Edit Total Lifetime Deposit for This Pool";
}
export function loadCurDeposit() {
  return _loadNum(_posKey("9mm_deposit_pos_"), false);
}
export function refreshCurDepositDisplay(fallback, usedFallback) {
  const userVal = loadCurDeposit();
  const v = userVal || fallback || 0,
    d = g("curDepositDisplay");
  if (d) d.textContent = v > 0 ? "$usd " + v.toFixed(2) : "\u2014";
  const popover = g("curDepositPriceInfoText");
  if (popover && v > 0) {
    if (userVal > 0)
      popover.textContent =
        "Manually entered value. To revert to auto-detection, edit and save the field as empty (0).";
    else
      popover.textContent = usedFallback
        ? "Valued using Current Price (historical price unavailable). Re-start the app to try again to fetch historical prices."
        : "Valued using Historical Price at the time of deposit.";
  }
}
export function toggleCurDeposit() {
  _toggleWrap("curDepositInputWrap", "curDepositInput", loadCurDeposit);
}
export function saveCurDeposit() {
  _saveInput(
    _posKey("9mm_deposit_pos_"),
    "curDepositInput",
    "curDepositInputWrap",
    () => refreshCurDepositDisplay(),
    false,
  );
}
export function toggleInitialDeposit() {
  _toggleWrap(
    "initialDepositInputWrap",
    "initialDepositInput",
    loadInitialDeposit,
  );
}
export function saveInitialDeposit() {
  _saveInput(
    _poolKey("9mm_deposit_pool_"),
    "initialDepositInput",
    "initialDepositInputWrap",
    async (amount) => {
      const active = posStore.getActive(),
        pk = active
          ? compositeKey(
              "pulsechain",
              active.walletAddress,
              active.contractAddress,
              active.tokenId,
            )
          : undefined;
      console.log("[lp-ranger] [deposit] save %s to %s", amount, pk);
      await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({
          initialDepositUsd: amount,
          positionKey: pk,
        }),
      }).catch(() => {});
      refreshDepositLabel();
      if (active && !isPositionManaged(active.tokenId) && _refetchUnmanaged)
        _refetchUnmanaged(active);
      else {
        const ls = _lastStatusRef?.();
        if (ls && _updateKpisRef) _updateKpisRef(ls);
      }
    },
    false,
  );
}
