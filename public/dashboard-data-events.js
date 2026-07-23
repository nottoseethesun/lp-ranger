/**
 * @file dashboard-data-events.js
 * @description Extracted from `dashboard-data.js` to keep that file under
 * the 500-line ESLint cap.  Scans every position's server state for new
 * rebalance, compound, and TX-cancelled events (detected via `lastRebalanceAt`,
 * `lastCompoundAt`, and `txCancelled.at` deltas), fires the Activity Log
 * entry, and plays the appropriate sound effect.
 */

"use strict";

import { log } from "./dashboard-log.js";
import { act, ACT_ICONS } from "./dashboard-helpers.js";
import { _logCtx } from "./dashboard-data-status.js";
import { scanPositions } from "./dashboard-positions.js";
import {
  checkRebalanceSound,
  checkCompoundSound,
  primeSoundTrackers,
} from "./dashboard-sounds.js";
import { formatCompoundEntry } from "./dashboard-compound-log.js";

/** Per-key "last seen" trackers — prevent duplicate log entries. */
const _lastRebAt = new Map();
const _lastCompAt = new Map();
const _txCancelSeen = new Set();

/**
 * Human-readable label for a rebalance trigger.
 *   "out-of-range"     → "Out of Range"
 *   "manual"           → "Manual"
 *   "residual-cleanup" → "Residual Cleanup"
 * Historical / chain-scanned events have no trigger field → "" (omit).
 */
function _triggerLabel(trigger) {
  if (trigger === "manual") return "Manual";
  if (trigger === "residual-cleanup") return "Residual Cleanup";
  if (trigger === "out-of-range") return "Out of Range";
  return "";
}

/** Clear event-log trackers (called from `resetPollingState`). */
export function resetEventLogTrackers() {
  _lastRebAt.clear();
  _lastCompAt.clear();
  _txCancelSeen.clear();
}

/**
 * Log a compound execution to the Activity Log when `lastCompoundAt`
 * advances.  Formatting is delegated to `formatCompoundEntry` so the
 * pure decision/format logic stays unit-testable.
 * @param {string} key   Composite position key.
 * @param {object} st    Per-position state slice.
 * @param {string} ctx   Position-context suffix from `_logCtx`.
 */
function _logCompound(key, st, ctx) {
  const entry = formatCompoundEntry(st, ctx, _lastCompAt.get(key));
  if (!entry) return;
  _lastCompAt.set(key, st.lastCompoundAt);
  act(
    ACT_ICONS.acorn,
    entry.type,
    entry.title,
    entry.detail,
    entry.when,
    entry.txHash,
  );
}

/**
 * Build the Activity Log payload for a rebalance event.  Pure helper \u2014
 * keeps `_handleRebalance` under the cyclomatic-complexity cap.
 *
 * @param {object} ev   Latest entry from `st.rebalanceEvents`.
 * @param {string} ctx  Position-context suffix from `_logCtx`.
 * @returns {{ when: Date|undefined, detail: string }}
 */
function _buildRebalanceLogEntry(ev, ctx) {
  /*- Use the event's on-chain timestamp so the Activity Log agrees
      with the Rebalance Events table. Falls back to now if the event
      carries no timestamp (shouldn't happen in practice). */
  const when = ev.dateStr
    ? new Date(ev.dateStr)
    : ev.timestamp
      ? new Date(ev.timestamp * 1000)
      : undefined;
  const trigger = _triggerLabel(ev.trigger);
  const detail =
    "NFT #" +
    ev.oldTokenId +
    " \u2192 #" +
    ev.newTokenId +
    (trigger ? " (" + trigger + ")" : "") +
    ctx;
  return { when, detail };
}

/**
 * Handle a per-position rebalance change: refresh the LP-browser scan
 * AND log the Activity entry, both gated on the same `_lastRebAt`
 * tracker.  The tracker is advanced ONLY after `scanPositions`
 * reports `{ok:true}`, so a transient failure (network, CSRF, RPC,
 * server scan-busy) leaves the tracker unset and the next 3 s poll
 * retries automatically.  Concurrent in-flight scans dedupe via the
 * same tracker check (the second resolution sees `_lastRebAt[key]
 * === at` and exits before logging twice).
 *
 * @param {string} key  Composite position key.
 * @param {object} st   Per-position state slice.
 * @param {string} ctx  Position-context suffix from `_logCtx`.
 */
/**
 * Pure pre-scan gate: has a new rebalance timestamp arrived that we
 * haven't yet handled?  Extracted from `_handleRebalance` so tests can
 * pin the "advance-tracker-AFTER-success, retry-on-failure" contract
 * without a mocked scanPositions.
 * @param {string|null|undefined} lastRebalanceAt  From the position state.
 * @param {string|null|undefined} trackedAt        From the module tracker.
 * @returns {boolean}  true → proceed to scan.
 */
export function _shouldTriggerRebalanceScan(lastRebalanceAt, trackedAt) {
  return !!lastRebalanceAt && lastRebalanceAt !== trackedAt;
}

/**
 * Pure post-scan decision: given the scan result plus the tracker
 * state, what should the follow-up do?  A `commit:false` outcome means
 * the tracker stays unset so the next poll re-fires the scan (the
 * user-reported retry-on-transient-failure path); `log:false` means
 * the Activity-log entry is skipped (no event yet in the payload, or
 * a concurrent handler already committed).
 * @param {{ok?:boolean}|null|undefined} scanResult
 * @param {string} at
 * @param {string|null|undefined} trackedAt
 * @param {object|null} ev  Latest rebalance event (or null).
 * @returns {{commit:boolean, log:boolean}}
 */
export function _shouldCommitRebalanceScan(scanResult, at, trackedAt, ev) {
  if (!scanResult?.ok) return { commit: false, log: false };
  if (trackedAt === at) return { commit: false, log: false };
  if (!ev) return { commit: true, log: false };
  return { commit: true, log: true };
}

function _handleRebalance(key, st, ctx) {
  if (!_shouldTriggerRebalanceScan(st.lastRebalanceAt, _lastRebAt.get(key)))
    return;
  const at = st.lastRebalanceAt;
  const evts = st.rebalanceEvents || [];
  const ev = evts.length ? evts[evts.length - 1] : null;
  log.info("[lp-ranger] [rebalance-scan] triggering for %s (at=%s)", key, at);
  scanPositions({ silent: true }).then((r) => {
    if (!r?.ok) {
      /*- Non-CSRF causes (RPC blip, server 500, scan-busy contention)
       *  surface here.  scanPositions itself already console.error'd
       *  the underlying message — we add a complementary line so the
       *  operator can see the rebalance-driven retry loop without
       *  having to correlate it with the generic scan log. */
      log.warn(
        "[lp-ranger] [rebalance-scan] retry pending for %s — %s (will re-fire on next /api/status poll)",
        key,
        r?.error || "scanPositions returned no result",
      );
    }
    const { commit, log: shouldLog } = _shouldCommitRebalanceScan(
      r,
      at,
      _lastRebAt.get(key),
      ev,
    );
    if (!commit) return;
    _lastRebAt.set(key, at);
    if (!shouldLog) return;
    const { when, detail } = _buildRebalanceLogEntry(ev, ctx);
    act(ACT_ICONS.lasso, "fee", "Rebalance", detail, when, ev.txHash);
  });
}

/**
 * Scan all position states for new events and log them.  Sound effects are
 * gated internally by `checkRebalanceSound` / `checkCompoundSound` so the
 * first poll after load/wallet-switch primes without firing.
 * @param {object} data  `/api/status` response.
 */
export function logAllPositionEvents(data) {
  for (const [key, st] of Object.entries(data._allPositionStates || {})) {
    const ctx = _logCtx(key, st);
    checkRebalanceSound(key, st.lastRebalanceAt);
    _handleRebalance(key, st, ctx);
    checkCompoundSound(key, st.lastCompoundAt);
    _logCompound(key, st, ctx);
    const tc = st.txCancelled;
    if (tc && !_txCancelSeen.has(key + tc.at)) {
      _txCancelSeen.add(key + tc.at);
      act(
        ACT_ICONS.warn,
        "alert",
        "TX Auto-Cancelled",
        tc.message +
          (tc.cancelTxHash
            ? " (TX: " + tc.cancelTxHash.slice(0, 10) + "\u2026)"
            : "") +
          ctx,
      );
    }
  }
  primeSoundTrackers();
}
