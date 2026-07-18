/**
 * @file dashboard-data-deposit.js
 * @description Deposit, realized gains, lifetime-days override, and
 * shared localStorage helpers. Split from dashboard-data.js.
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
 * reuse the same key layout.  Enforces string tokenId so a numeric
 * or coerced value never produces a slightly-different localStorage
 * key from the string-typed path.
 */
export function _posKeyFrom(prefix, tokenId) {
  if (typeof tokenId !== "string" || tokenId.length === 0) return null;
  return prefix + tokenId;
}

/**
 * Pure per-pool localStorage key builder.  Takes every identity
 * field explicitly so callers iterating positions other than
 * posStore.getActive() can reuse the same key layout.  Requires
 * every identity slot to be a string (or a number for `fee`, since
 * that's how the bot-state exposes it) — no implicit coercion, so a
 * malformed input returns null rather than silently producing a
 * partial-match key.  All addresses are lower-cased to preserve
 * backwards compatibility with existing localStorage entries written
 * by the single-arg helpers below.
 */
export function _poolKeyFrom(
  prefix,
  walletAddress,
  contractAddress,
  token0,
  token1,
  fee,
) {
  if (typeof walletAddress !== "string" || walletAddress.length === 0)
    return null;
  if (typeof token0 !== "string" || token0.length === 0) return null;
  if (typeof token1 !== "string" || token1.length === 0) return null;
  const contract =
    typeof contractAddress === "string" ? contractAddress.toLowerCase() : "";
  const feePart =
    typeof fee === "number" && Number.isFinite(fee) ? fee.toString() : "0";
  return (
    prefix +
    "pulsechain_" +
    walletAddress.toLowerCase() +
    "_" +
    contract +
    "_" +
    token0.toLowerCase() +
    "_" +
    token1.toLowerCase() +
    "_" +
    feePart
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
/*- Shared reset helper — clears the localStorage override and closes
 *  the inline edit dialog.  Used by the "Return to Automatic Detection"
 *  button on every inline-edit dialog whose value is stored in
 *  localStorage (realized gains, per-position deposit, per-position
 *  realized gains).  Auto-detection resumes on the next KPI update
 *  because the load path returns 0 when localStorage lacks the key. */
export function _resetInput(key, wrapId, afterReset) {
  if (key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* private mode */
    }
  }
  const wrap = g(wrapId);
  if (wrap) wrap.classList.remove("open");
  if (afterReset) afterReset();
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
/** Clear the lifetime Realized Gains override for this pool. */
export function resetRealizedGains() {
  _resetInput(_poolKey("9mm_realized_pool_"), "realizedGainsInputWrap", () => {
    const ls = _lastStatusRef?.();
    if (ls && _updateKpisRef) _updateKpisRef(ls);
  });
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
/** Clear the per-position Realized Gains override for this tokenId. */
export function resetCurRealized() {
  _resetInput(_posKey("9mm_realized_pos_"), "curRealizedInputWrap", () => {
    const ls = _lastStatusRef?.();
    if (ls && _updateKpisRef) _updateKpisRef(ls);
  });
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
/** Clear the per-position Initial Deposit override for this tokenId.
 *  The load path returns 0 when the key is absent, so the KPI
 *  refresher's fallback (historical-price auto-detection) takes over. */
export function resetCurDeposit() {
  _resetInput(_posKey("9mm_deposit_pos_"), "curDepositInputWrap", () =>
    refreshCurDepositDisplay(),
  );
}
export function toggleInitialDeposit() {
  _toggleWrap(
    "initialDepositInputWrap",
    "initialDepositInput",
    loadInitialDeposit,
  );
}
/** Clear the Lifetime Deposit override and revert to auto-detection.
 *  Wired to the "Return to Automatic Detection" button on the inline
 *  edit dialog. */
export function resetInitialDeposit() {
  const key = _poolKey("9mm_deposit_pool_");
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
  const wrap = g("initialDepositInputWrap");
  if (wrap) wrap.classList.remove("open");
  const active = posStore.getActive();
  const pk = active
    ? compositeKey(
        "pulsechain",
        active.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : undefined;
  if (pk) {
    log.info("[lp-ranger] [deposit] reset override pk=%s", pk);
    fetchWithCsrf("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialDepositUsd: 0, positionKey: pk }),
    }).catch(() => {});
  }
  refreshDepositLabel();
  if (active && !isPositionManaged(active.tokenId) && _refetchUnmanaged)
    _refetchUnmanaged(active);
  else {
    const ls = _lastStatusRef?.();
    if (ls && _updateKpisRef) _updateKpisRef(ls);
  }
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

// ── Lifetime Days override ────────────────────────

/*- Per-pool localStorage prefix for the Lifetime Days override.  The
 *  stored value is a YYYY-MM-DD "start date" (UTC); the input takes
 *  days, and on save we convert `today - days` → date.  Storing a
 *  date rather than a number lets the day count auto-increment
 *  overnight — the user's "N days" reading stays fresh without
 *  re-editing.  Empty / missing → auto-detected `ltStartDate()`
 *  candidates take over. */
const _LT_DAYS_START_PREFIX = "9mm_lt_start_pool_";

/** Return today's date (UTC) as YYYY-MM-DD.  Extracted so tests can
 *  drive it deterministically without freezing `Date`. */
function _todayUtc(now) {
  const d = new Date(now ?? Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Subtract `days` from `now` (ms) and return the resulting YYYY-MM-DD
 *  in UTC.  Non-finite / negative input returns today's date. */
export function daysAgoDateUtc(days, now) {
  const nowMs = now ?? Date.now();
  const n = Number.isFinite(days) && days > 0 ? days : 0;
  return _todayUtc(nowMs - n * 86400000);
}

/** Load the per-pool Lifetime Days override (start date, YYYY-MM-DD).
 *  Returns null when no override is set — callers fall through to
 *  `ltStartDate()`'s auto-detected candidates. */
export function loadLifetimeStartDateOverride() {
  const key = _poolKey(_LT_DAYS_START_PREFIX);
  if (!key) return null;
  try {
    const v = localStorage.getItem(key);
    return typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Compute the current display value (days number) for the Lifetime
 *  Days input from the stored start date.  Returns 0 when no override
 *  is set OR when the stored date is unparseable / in the future. */
export function loadLifetimeDaysDisplay() {
  const startDate = loadLifetimeStartDateOverride();
  if (!startDate) return 0;
  const startMs = Date.parse(startDate + "T00:00:00Z");
  if (!Number.isFinite(startMs)) return 0;
  const days = (Date.now() - startMs) / 86400000;
  return Number.isFinite(days) && days > 0 ? Math.round(days) : 0;
}

/** Toggle the Lifetime Days edit input row — mirrors `toggleInitialDeposit`. */
export function toggleLifetimeDays() {
  _toggleWrap("lifetimeDaysInputWrap", "lifetimeDaysInput", () => {
    const d = loadLifetimeDaysDisplay();
    return d > 0 ? d : "";
  });
}

/** Save the Lifetime Days input as a per-pool override.  Converts the
 *  user-entered days to `today − days` (YYYY-MM-DD UTC), writes to
 *  localStorage, and POSTs to `/api/config` under
 *  `lifetimeStartDateOverrideUtc` so the server payload's `ltStartDate`
 *  picks it up on the next poll.  Empty input / 0 clears the override
 *  (POST `null`, delete localStorage). */
export function saveLifetimeDays() {
  const inp = g("lifetimeDaysInput");
  const key = _poolKey(_LT_DAYS_START_PREFIX);
  if (!inp || !key) return;
  const raw = parseFloat(inp.value);
  const days = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const startDate = days > 0 ? daysAgoDateUtc(days) : null;
  try {
    if (startDate) localStorage.setItem(key, startDate);
    else localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
  const wrap = g("lifetimeDaysInputWrap");
  if (wrap) wrap.classList.remove("open");
  const active = posStore.getActive();
  const pk = active
    ? compositeKey(
        "pulsechain",
        active.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : undefined;
  if (!pk) return;
  log.info(
    "[lp-ranger] [lt-days] save days=%s startDate=%s pk=%s",
    days,
    startDate,
    pk,
  );
  fetchWithCsrf("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lifetimeStartDateOverrideUtc: startDate,
      positionKey: pk,
    }),
  }).catch(() => {});
  refreshLifetimeDaysLabel();
  if (active && !isPositionManaged(active.tokenId) && _refetchUnmanaged)
    _refetchUnmanaged(active);
  else {
    const ls = _lastStatusRef?.();
    if (ls && _updateKpisRef) _updateKpisRef(ls);
  }
}

/** Update the Lifetime Days edit label so it reflects the current
 *  override state.  Mirrors `refreshDepositLabel`. */
export function refreshLifetimeDaysLabel() {
  const d = loadLifetimeDaysDisplay();
  const l = g("lifetimeDaysLabel");
  if (l)
    l.textContent =
      d > 0 ? `Total Lifetime Days: ${d}` : "Edit Total Lifetime Days";
}

/** Clear the Lifetime Days override and revert to auto-detection.
 *  Wired to the "Return to Automatic Detection" button on the
 *  inline edit dialog.  Behaviourally identical to saving an empty
 *  value, but named explicitly for user clarity. */
export function resetLifetimeDays() {
  const key = _poolKey(_LT_DAYS_START_PREFIX);
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
  const wrap = g("lifetimeDaysInputWrap");
  if (wrap) wrap.classList.remove("open");
  const active = posStore.getActive();
  const pk = active
    ? compositeKey(
        "pulsechain",
        active.walletAddress,
        active.contractAddress,
        active.tokenId,
      )
    : undefined;
  if (pk) {
    log.info("[lp-ranger] [lt-days] reset override pk=%s", pk);
    fetchWithCsrf("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lifetimeStartDateOverrideUtc: null,
        positionKey: pk,
      }),
    }).catch(() => {});
  }
  refreshLifetimeDaysLabel();
  if (active && !isPositionManaged(active.tokenId) && _refetchUnmanaged)
    _refetchUnmanaged(active);
  else {
    const ls = _lastStatusRef?.();
    if (ls && _updateKpisRef) _updateKpisRef(ls);
  }
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
