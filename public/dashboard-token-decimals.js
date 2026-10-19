/**
 * @file dashboard-token-decimals.js
 * @description Manual per-token decimals override for the Pool Details dialog —
 *   a last-ditch fail-safe for rare tokens whose decimals can't be read
 *   on-chain (which otherwise auto-stops the position; see
 *   `src/bot-recorder-decimals-heal._ensureTokenDecimals`). Saved in the
 *   position's server config (`decimalsOverride0/1` +
 *   `decimalsOverrideForce0/1`, POSITION_KEYS), which the dialog also
 *   opens from. The heal consults these only when the on-chain read fails
 *   — or, with Force checked, always. Each token block shows a red notice
 *   when its decimals look unreadable, else a neutral advisory.
 */

import { g, compositeKey } from "./dashboard-helpers.js";
import { posStore, isPositionManaged } from "./dashboard-positions-store.js";
import { getLastStatus, isSyncComplete } from "./dashboard-data.js";
import { log } from "./dashboard-log.js";
import {
  saveConfigValues,
  rememberGoodInput,
} from "./dashboard-config-save.js";
import { activeChainId } from "./dashboard-chain.js";
// The server's own rule for a value inside a range.
import { withinBound } from "../src/range-check.js";
// Bundled at build time: the range a usable decimals falls in.
import SETTING_BOUNDS from "../app-config/app-defaults-for-user-configurable/setting-bounds.json" with { type: "json" };

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

/**
 * What each coin's field and Force box show when Pool Details opens.
 *
 * Both coins are always filled in. A coin with an override saved on the
 * server shows that override and its Force box; one without shows the
 * decimals the chain gave, with Force off. Save sends both coins as they
 * are shown, so editing one coin can neither clear the other's saved
 * override nor put a forced correction back to the chain's figure.
 *
 * Pure and exported so the decision can be driven directly.
 *
 * @param {object|null} status  The last status poll's view of the active
 *   position: its saved settings and its `poolState`.
 * @returns {Array<{decimals: number|null, force: boolean}>}  Coin 0, then
 *   coin 1. `decimals` is null when neither source has a figure.
 */
export function decimalsFormValues(status) {
  return [0, 1].map((idx) => {
    const saved = status?.["decimalsOverride" + idx];
    const chain = status?.poolState?.["decimals" + idx];
    return {
      decimals:
        typeof saved === "number"
          ? saved
          : typeof chain === "number"
            ? chain
            : null,
      force: status?.["decimalsOverrideForce" + idx] === true,
    };
  });
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

/**
 * What the operator typed, for the server to judge.
 *
 * An empty field is null, which clears the override. Anything else is
 * sent as typed — a number when it reads as one, the text itself when it
 * does not — because whether it is a usable decimals is the server's
 * call (`src/config-bounds.js`), which refuses an out-of-range or
 * fractional value and leaves the saved one in place. Turning such a
 * value into null here would send "clear" instead, and delete the saved
 * override the operator meant to change. Text rather than NaN, because
 * NaN travels as null in JSON.
 *
 * Exported so the mapping can be driven directly.
 *
 * @param {string} v  The field's value.
 * @returns {number|string|null}
 */
export function typedDecimals(v) {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : v.trim();
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
 * Once Synced, the value must be a valid ERC-20 decimals — a whole number
 * inside `tokenDecimals` in setting-bounds.json, the range the server
 * holds a read or an override to. Anything else genuinely could not be
 * read, which is the case this override exists to let them fix.
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
  return !withinBound(decimals, SETTING_BOUNDS.tokenDecimals);
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
  const shown = decimalsFormValues(getLastStatus());
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
    const { decimals } = shown[idx];
    if (input) {
      input.value = decimals === null ? "" : String(decimals);
      /*-
       *  What the field opens with is the value in force, so a save the
       *  server refuses puts the field back to it.
       */
      if (decimals !== null) rememberGoodInput("pdDecimals" + idx, decimals);
    }
    if (force) force.checked = shown[idx].force;
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

/*- Persist both tokens' overrides to server config for the active
 *  position, and run `onAccepted` once the server has taken them. */
/**
 * The values a Save sends: both coins' fields and Force boxes as shown.
 *
 * Pure and exported so the mapping can be driven directly.
 *
 * @param {Array<{text: string, force: boolean}>} fields  Coin 0, then
 *   coin 1: what each field holds and whether its Force box is checked.
 * @returns {object}  `decimalsOverride0/1` and `decimalsOverrideForce0/1`.
 */
export function decimalsSaveValues(fields) {
  const values = {};
  fields.forEach((f, idx) => {
    values["decimalsOverride" + idx] = typedDecimals(f.text);
    values["decimalsOverrideForce" + idx] = f.force === true;
  });
  return values;
}

/**
 * Save both coins' overrides, as the form shows them, to the active
 * position's server config.
 */
function _persistToServer(values) {
  const a = posStore.getActive();
  if (a === null || a === undefined) return;
  const chain = activeChainId();
  const pk = compositeKey(chain, a.walletAddress, a.contractAddress, a.tokenId);
  saveConfigValues({
    values,
    positionKey: pk,
    inputs: {
      decimalsOverride0: "pdDecimals0",
      decimalsOverride1: "pdDecimals1",
    },
  });
}

/**
 * Save the decimals overrides from either coin's Save button.
 *
 * Both coins are sent as the form shows them, the other coin included:
 * the dialog opened with each coin's value in force (`decimalsFormValues`),
 * so the coin not being edited is saved as it already stood.
 *
 * @param {number} idx  The coin whose Save was clicked, 0 or 1.
 */
export function saveDecimalsOverride(idx) {
  const fields = [0, 1].map((i) => ({
    text: g("pdDecimals" + i)?.value ?? "",
    force: g("pdDecimalsForce" + i)?.checked === true,
  }));
  _persistToServer(decimalsSaveValues(fields));
  _paintNotice(idx);
}
