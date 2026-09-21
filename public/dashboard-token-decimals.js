/**
 * @file dashboard-token-decimals.js
 * @description Manual per-token decimals override for the Pool Details dialog —
 *   a last-ditch fail-safe for rare tokens whose decimals can't be read
 *   on-chain (which otherwise auto-stops the position; see
 *   `src/bot-recorder-decimals-heal._ensureTokenDecimals`). Pool-scoped; persisted
 *   to localStorage + server config (`decimalsOverride0/1` +
 *   `decimalsOverrideForce0/1`, POSITION_KEYS). The heal consults these only
 *   when the on-chain read fails — or, with Force checked, always. Each token
 *   block shows a red notice when its decimals look unreadable, else a neutral
 *   advisory. Mirrors the shape of `dashboard-price-override.js`.
 */

import { g, compositeKey } from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions.js";
import { getLastStatus, isSyncComplete } from "./dashboard-data.js";
import { log } from "./dashboard-log.js";
import { saveConfigValues } from "./dashboard-config-save.js";

/*- The app has ONE Synced state, shown by the single sync badge and read
 *  here through its single source of truth. It is not true until every
 *  position's data has loaded — managed and unmanaged alike — so it is
 *  the only honest answer to "has anything actually read these decimals
 *  yet?".
 *
 *  Only an explicit `true` counts. The accessor returns true|false|null,
 *  and null (no poll has landed) is not synced. */
function _synced() {
  return isSyncComplete() === true;
}

/*- Is the active position managed?
 *
 *  The override only ever helps a managed position. Its whole purpose is
 *  to let the bot heal a token whose decimals cannot be read, and the
 *  correction it applies is historical — it re-values what the bot has
 *  already recorded. An unmanaged position has no recorded history to
 *  correct, so there is nothing for the form to do there. */
function _managed() {
  const a = posStore.getActive();
  return !!a && isPositionManaged(a.tokenId) === true;
}

/*- Show or hide one token's whole mini-form: the row and its notice.
 *
 *  Hidden outright for unmanaged positions rather than merely disabled —
 *  a greyed-out control invites the operator to wonder what would unlock
 *  it, when the answer is that it would never do anything for them. */
function _setFormVisible(idx, visible) {
  const form = g("pdDecimalsForm" + idx);
  if (form) form.hidden = !visible;
}

/*- Pool-scoped localStorage key (token0_token1_fee) — matches the server-side
 *  scope so the override follows the pool across rebalances (new tokenId). */
function _key() {
  const a = posStore.getActive();
  if (!a || !a.token0 || !a.token1) return null;
  return (
    "9mm_decimals_override_" +
    a.token0.toLowerCase() +
    "_" +
    a.token1.toLowerCase() +
    "_" +
    (a.fee || 0)
  );
}

/** Load saved overrides `{ d0, force0, d1, force1 }`. Missing → `{}`. */
export function loadDecimalsOverrides() {
  const k = _key();
  if (!k) return {};
  try {
    const j = JSON.parse(localStorage.getItem(k));
    return j !== null && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/*- The managed+Synced pair the dialog was last painted for; null when
 *  closed. Both matter: clicking Manage must bring the forms in, and
 *  Synced moving must enable or disable them. */
let _paintedState = null;

/*- Trace every input the enable/warn decision uses, at the moment it is
 *  made.  Permanent, in the spirit of the rebalance-pipeline diagnostics:
 *  this form has now produced a false "couldn't be read" warning twice
 *  under conditions that were not reproducible from reading the code, and
 *  the answer lives in values only the running app holds — which of
 *  Synced / poolState / the store entry is actually populated when the
 *  warning appears. */
function _logInputs(managed, synced) {
  const st = getLastStatus();
  const a = posStore.getActive();
  log.info(
    "%c[lp-ranger] [token-decimals] managed=%s synced=%s raw=%s tid=#%s " +
      "poolState=%s ps.d0=%s ps.d1=%s entry.d0=%s entry.d1=%s " +
      "rebalScan=%s lifetimeScan=%s posScan=%s",
    "color:#0ff;background:#023;padding:1px 4px;border-radius:2px",
    managed,
    synced,
    String(isSyncComplete()),
    a?.tokenId,
    st?.poolState ? "yes" : "NO",
    String(st?.poolState?.decimals0),
    String(st?.poolState?.decimals1),
    String(a?.decimals0),
    String(a?.decimals1),
    String(st?.rebalanceScanComplete),
    String(st?.lifetimeScanComplete),
    String(st?._positionScan?.status),
  );
}

function _save(obj) {
  const k = _key();
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(obj));
  } catch {
    /* localStorage may be unavailable (private mode); non-fatal. */
  }
}

/*- Parse an input string into a valid ERC-20 decimals integer [0,77], or
 *  null.  Explicit checks so "" / non-numeric / out-of-range never persist. */
function _parseDecimals(v) {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 77 ? n : null;
}

/*- The active position's on-chain decimals for token `idx`, from the last
 *  status poll's poolState (the same source the KPI panel reads). Returns a
 *  number or undefined. */
function _currentDecimals(idx) {
  const st = getLastStatus();
  const ps = st !== null && st !== undefined ? st.poolState : undefined;
  const d = ps !== null && ps !== undefined ? ps["decimals" + idx] : undefined;
  return typeof d === "number" ? d : undefined;
}

/**
 * Whether to warn that a token's decimals could not be read.
 *
 * Synced is the gate, and it is checked first: until the app reaches
 * Synced, no position's data is guaranteed loaded, so an absent value
 * means "not loaded yet", not "unreadable". Warning then would send the
 * operator to repair something that is not broken.
 *
 * Once Synced, the value must be a valid ERC-20 decimals — an integer in
 * [0, 77]. Anything else genuinely could not be read, which is the case
 * this override exists to let them fix.
 *
 * Pure and exported because it is the whole decision and the Synced flag
 * lives behind a non-exported poll handler, so the true branch cannot be
 * reached through the real singleton. Mirrors the `_syncStatus` /
 * `_computeSyncStatus` split in dashboard-data.js.
 *
 * @param {boolean} synced    The app-wide Synced state.
 * @param {number|undefined} decimals  Decimals as currently known.
 * @returns {boolean}
 */
export function _shouldWarn(synced, decimals) {
  if (!synced) return false;
  return !(
    typeof decimals === "number" &&
    Number.isInteger(decimals) &&
    decimals >= 0 &&
    decimals <= 77
  );
}

/*- Enable or disable one token's mini-form.
 *
 *  Covers the Force checkbox and Save button as well as the input: Save
 *  left live beside a disabled field would persist the empty value as an
 *  override, which is the opposite of the intent. */
function _setEnabled(idx, enabled) {
  for (const id of ["pdDecimals", "pdDecimalsForce", "pdDecimalsSave"]) {
    const el = g(id + idx);
    if (el) el.disabled = !enabled;
  }
}

/*- Show the bad (red) or ok (neutral) notice for one token block.
 *
 *  While unsynced the check does not run and the warning is cleared: the
 *  data may simply not have loaded yet, and accusing a token of being
 *  unreadable at that point sends the operator to fix something that is
 *  not broken. */
function _paintNotice(idx, synced) {
  const bad = g("pdDecimalsBad" + idx);
  const ok = g("pdDecimalsOk" + idx);
  const isBad = _shouldWarn(synced, _currentDecimals(idx));
  if (bad) bad.hidden = !isBad;
  if (ok) ok.hidden = isBad;
}

/** Populate both mini-forms from saved overrides (or the current on-chain
 *  decimals) and paint the notices. Called when Pool Details opens. */
export function populateDecimalsOverride() {
  const ov = loadDecimalsOverrides();
  const managed = _managed();
  const synced = _synced();
  _logInputs(managed, synced);
  _paintedState = managed + "|" + synced;
  /*- Unmanaged: hide both forms and evaluate nothing. No check runs, so
   *  no warning can be produced, and none can be left on screen — the
   *  notice lives inside the hidden wrapper. */
  if (!managed) {
    for (const idx of [0, 1]) _setFormVisible(idx, false);
    return;
  }
  for (const idx of [0, 1]) {
    _setFormVisible(idx, true);
    const input = g("pdDecimals" + idx);
    const force = g("pdDecimalsForce" + idx);
    if (input) {
      const saved = ov["d" + idx];
      const cur = _currentDecimals(idx);
      input.value =
        typeof saved === "number"
          ? String(saved)
          : typeof cur === "number"
            ? String(cur)
            : "";
    }
    if (force) force.checked = ov["force" + idx] === true;
    _setEnabled(idx, synced);
    _paintNotice(idx, synced);
  }
}

/**
 * Re-paint when the Synced state changes while the dialog is open.
 *
 * Synced moves in both directions, and the form has to follow it both
 * ways: reaching Synced enables the fields and runs the check, and
 * dropping back to syncing disables them again and clears any warning.
 * A form frozen in its previous state would either withhold a repair the
 * operator needs or leave an accusation standing against data that is
 * being reloaded.
 *
 * Rides the existing status poll, so it runs at the dashboard's base
 * heartbeat and adds no cadence of its own.
 *
 * Repaints on CHANGE only. Every poll would refill the input from chain
 * every few seconds and wipe out whatever is being typed.
 */
export function refreshDecimalsOverrideOnPoll() {
  const modal = g("poolDetailsModal");
  /*- Closed: forget the painted state so the next open repaints from
   *  scratch rather than being skipped as "already current". */
  if (!modal || modal.classList.contains("hidden")) {
    _paintedState = null;
    return;
  }
  if (_managed() + "|" + _synced() === _paintedState) return;
  populateDecimalsOverride();
}

/*- Persist both tokens' overrides to server config for the active position. */
function _persistToServer(ov) {
  const a = posStore.getActive();
  if (!a) return;
  const pk = compositeKey(
    "pulsechain",
    a.walletAddress,
    a.contractAddress,
    a.tokenId,
  );
  saveConfigValues({
    values: {
      decimalsOverride0: ov.d0 ?? null,
      decimalsOverride1: ov.d1 ?? null,
      decimalsOverrideForce0: ov.force0 === true,
      decimalsOverrideForce1: ov.force1 === true,
    },
    positionKey: pk,
    inputs: {
      decimalsOverride0: "pdDecimals0",
      decimalsOverride1: "pdDecimals1",
    },
  });
}

/** Save one token's decimals override (localStorage + server), then repaint. */
export function saveDecimalsOverride(idx) {
  const ov = loadDecimalsOverrides();
  const input = g("pdDecimals" + idx);
  const force = g("pdDecimalsForce" + idx);
  ov["d" + idx] = input ? _parseDecimals(input.value) : null;
  ov["force" + idx] = force ? force.checked === true : false;
  _save(ov);
  _persistToServer(ov);
  _paintNotice(idx);
}
