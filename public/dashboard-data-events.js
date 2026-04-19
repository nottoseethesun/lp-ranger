/**
 * @file dashboard-data-events.js
 * @description Extracted from `dashboard-data.js` to keep that file under
 * the 500-line ESLint cap.  Scans every position's server state for new
 * rebalance, compound, and TX-cancelled events (detected via `lastRebalanceAt`,
 * `lastCompoundAt`, and `txCancelled.at` deltas), fires the Activity Log
 * entry, and plays the appropriate sound effect.
 */

"use strict";

import { act, ACT_ICONS } from "./dashboard-helpers.js";
import { _logCtx, _fmtTxCopy } from "./dashboard-data-status.js";
import { scanPositions } from "./dashboard-positions.js";
import {
  checkRebalanceSound,
  checkCompoundSound,
  primeSoundTrackers,
} from "./dashboard-sounds.js";

/** Per-key "last seen" trackers — prevent duplicate log entries. */
const _lastRebAt = new Map();
const _txCancelSeen = new Set();

/** Clear event-log trackers (called from `resetPollingState`). */
export function resetEventLogTrackers() {
  _lastRebAt.clear();
  _txCancelSeen.clear();
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
    if (st.lastRebalanceAt && st.lastRebalanceAt !== _lastRebAt.get(key)) {
      _lastRebAt.set(key, st.lastRebalanceAt);
      const evts = st.rebalanceEvents || [];
      const ev = evts.length ? evts[evts.length - 1] : null;
      if (ev) {
        const tx = ev.txHash ? "<br>" + _fmtTxCopy(ev.txHash) : "";
        /*- Use the event's on-chain timestamp so the Activity Log agrees
            with the Rebalance Events table. Falls back to now if the event
            carries no timestamp (shouldn't happen in practice). */
        const when = ev.dateStr
          ? new Date(ev.dateStr)
          : ev.timestamp
            ? new Date(ev.timestamp * 1000)
            : undefined;
        act(
          ACT_ICONS.gear,
          "fee",
          "Rebalance",
          "NFT #" + ev.oldTokenId + " \u2192 #" + ev.newTokenId + tx + ctx,
          when,
        );
      }
      scanPositions({ silent: true }).catch(() => {});
    }
    checkCompoundSound(key, st.lastCompoundAt);
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
