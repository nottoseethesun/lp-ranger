/**
 * @file dashboard-data-deposit.js
 * @description Deposit, realized gains, and shared
 * localStorage helpers. Split from dashboard-data.js.
 */
import { log } from "./dashboard-log.js";
import { g, compositeKey, fetchWithCsrf } from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";
import { _fmtUsd } from "./dashboard-data-kpi.js";

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

/**
 * Pure per-position localStorage key builder.  Takes tokenId
 * explicitly so callers iterating positions other than
 * posStore.getActive() (e.g. the All Positions Stats modal) can
 * reuse the same key layout.
 */
export function _posKeyFrom(prefix, tokenId) {
  return tokenId ? prefix + tokenId : null;
}

/**
 * Pure per-pool localStorage key builder.  Takes every identity
 * field explicitly so callers iterating positions other than
 * posStore.getActive() can reuse the same key layout.  All addresses
 * are lower-cased to preserve backwards compatibility with existing
 * localStorage entries written by the single-arg helpers below.
 */
export function _poolKeyFrom(
  prefix,
  walletAddress,
  contractAddress,
  token0,
  token1,
  fee,
) {
  if (!walletAddress || !token0 || !token1) return null;
  return (
    prefix +
    "pulsechain_" +
    walletAddress.toLowerCase() +
    "_" +
    (contractAddress || "").toLowerCase() +
    "_" +
    token0.toLowerCase() +
    "_" +
    token1.toLowerCase() +
    "_" +
    (fee || 0)
  );
}

export function _posKey(prefix) {
  const a = posStore.getActive();
  return _posKeyFrom(prefix, a?.tokenId);
}
export function _poolKey(prefix) {
  const a = posStore.getActive();
  return _poolKeyFrom(
    prefix,
    a?.walletAddress,
    a?.contractAddress,
    a?.token0,
    a?.token1,
    a?.fee,
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
  if (d) d.textContent = s > 0 ? _fmtUsd(s) : "\u2014";
  if (l) l.textContent = "Edit Total Lifetime Deposit for This Pool";
}
export function loadCurDeposit() {
  return _loadNum(_posKey("9mm_deposit_pos_"), false);
}
export function refreshCurDepositDisplay(fallback, usedFallback) {
  const userVal = loadCurDeposit();
  const v = userVal || fallback || 0,
    d = g("curDepositDisplay");
  if (d) d.textContent = v > 0 ? _fmtUsd(v) : "\u2014";
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
      log.info("[lp-ranger] [deposit] save %s to %s", amount, pk);
      await fetchWithCsrf("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

// ── Parameterized loaders for iterating positions other than the active one ──

/**
 * Load per-pool realized gains for an arbitrary position (not
 * necessarily the active one).  Matches loadRealizedGains() but
 * accepts the pool identity explicitly.
 * @param {{walletAddress:string, contractAddress:string, token0:string, token1:string, fee:number}} ctx
 * @returns {number}
 */
export function loadRealizedGainsForPool(ctx) {
  return _loadNum(
    _poolKeyFrom(
      "9mm_realized_pool_",
      ctx?.walletAddress,
      ctx?.contractAddress,
      ctx?.token0,
      ctx?.token1,
      ctx?.fee,
    ),
    true,
  );
}

/**
 * Load per-pool initial deposit override for an arbitrary position.
 * Matches loadInitialDeposit() but accepts the pool identity
 * explicitly.
 * @param {{walletAddress:string, contractAddress:string, token0:string, token1:string, fee:number}} ctx
 * @returns {number}
 */
export function loadInitialDepositForPool(ctx) {
  return _loadNum(
    _poolKeyFrom(
      "9mm_deposit_pool_",
      ctx?.walletAddress,
      ctx?.contractAddress,
      ctx?.token0,
      ctx?.token1,
      ctx?.fee,
    ),
    false,
  );
}
