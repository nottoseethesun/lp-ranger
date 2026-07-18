/**
 * @file src/build-status-positions.js
 * @module build-status-positions
 * @description
 * Builder for the `positions` map in the `GET /api/status` response.
 * Extracted from `src/server-positions.js` to keep that file under the
 * 500-line cap.  Pure module — no in-memory state of its own; reads
 * the live bot states via the supplied `getStates` callback and the
 * disk config / position-manager via injected references.
 *
 * Merges three layers per position key:
 *   1. `posDefaults`              (server-wide defaults from /api/status)
 *   2. live bot state (loop 1)    — present only for actively-managed positions
 *   3. disk config slot           — settings, status, hodlBaseline, etc.
 *
 * Loop 2 (stopped / disk-only entries) emits a *terminal sync state*
 * so the dashboard's syncBadge resolves to "Synced" instead of staying
 * stuck on "Syncing…" for a position whose bot has retired.  See the
 * block comment on the loop-2 branch for the full bug-fix rationale.
 */

"use strict";

/**
 * Settings keys that flow through to the dashboard for *unmanaged*
 * positions (so the user sees persisted settings for positions the bot
 * isn't actively managing, e.g. closed-view or paused positions).
 */
const _UNMANAGED_SETTINGS_KEYS = [
  "rebalanceOutOfRangeThresholdPercent",
  "rebalanceTimeoutMin",
  "rebalanceRangeWidthPct",
  "slippagePct",
  "checkIntervalSec",
  "minRebalanceIntervalMin",
  "maxRebalancesPerDay",
  "gasStrategy",
  "priceOverride0",
  "priceOverride1",
  "priceOverrideForce",
  "autoCompoundEnabled",
  "autoCompoundThresholdUsd",
  "totalCompoundedUsd",
  "lastCompoundAt",
  "offsetToken0Pct",
  "lifetimeStartDateOverrideUtc",
];

/**
 * Build the `positions` map for the GET /api/status response: merges
 * per-position bot state, disk config, and sensible defaults; attaches a
 * canonical poolKey to every managed entry. Unmanaged positions (in
 * disk config but not currently running) get a lightweight subset of
 * their persisted settings so the dashboard UI still has context.
 *
 * @param {object} diskConfig   Parsed bot-config (has `.positions` map).
 * @param {object} posDefaults  Base defaults applied to every entry.
 * @param {object} positionMgr  Position manager (exposes poolKey()).
 * @param {object} cfg          Config object with CHAIN_NAME + POSITION_MANAGER.
 * @param {object} deps         Injected dependencies:
 *   - `getStates()` → returns the Map of composite-key → bot state
 *   - `attachPoolKeys(positions, positionMgr, cfg)` → mutates positions
 * @returns {Record<string, object>}
 */
function buildStatusPositions(diskConfig, posDefaults, positionMgr, cfg, deps) {
  const { getStates, attachPoolKeys } = deps;
  const positions = {};
  for (const [key, state] of getStates()) {
    const posConfig = diskConfig.positions[key] || {};
    positions[key] = { ...posDefaults, ...state, ...posConfig };
  }
  for (const [key, posConfig] of Object.entries(diskConfig.positions)) {
    if (positions[key]) continue;
    const s = { ...posDefaults };
    for (const k of _UNMANAGED_SETTINGS_KEYS)
      if (posConfig[k] !== undefined) s[k] = posConfig[k];
    /*- For positions that the user has explicitly stopped (or that
     *  auto-retired after a failed re-open attempt), publish a
     *  terminal sync state.  Rationale: there is no live bot loop
     *  scanning, so there is nothing for the dashboard to "still be
     *  syncing" — the scan-complete flags are the bot loop's signal
     *  to the dashboard, and without them dashboard-data._syncStatus
     *  paints "Syncing…" forever for a stopped slot.  That stuck
     *  badge then disables the closed-position Manage button (via
     *  computeManageUI's syncComplete gate), silently blocking the
     *  user from re-clicking Manage to retry a re-open with a freshly
     *  bumped slippage.  Only emit for status=='stopped' so that a
     *  status=='running' position whose bot loop is still booting
     *  (e.g. mid-startup-stagger) correctly shows "Syncing…"
     *  until its real bot state lands in loop 1.  `status` is included
     *  for diagnostic clarity in the payload — `computeManageUI`
     *  treats undefined and "stopped" identically (both => not
     *  running), so it does not change UI logic. */
    if (posConfig.status === "stopped") {
      s.status = "stopped";
      s.rebalanceScanComplete = true;
      s.lifetimeScanComplete = true;
    } else if (posConfig.status === "running") {
      /*- Mid-startup case: disk says this position is under management,
       *  but its bot loop hasn't booted yet (behind the startup
       *  stagger — one bot-loop start per CHECK_INTERVAL_SEC/N seconds
       *  in `src/server-auto-start.js`).  Echo `status: "running"` so
       *  the dashboard's readiness gate ("N of M managed positions
       *  loaded" on the All Positions Stats button) counts this slot
       *  in its denominator instead of treating it as invisible.
       *  Deliberately do NOT set scan-complete flags — they stay
       *  false-ish so the gate still reports the position as "not
       *  ready" until the real bot state lands via loop 1. */
      s.status = "running";
    }
    positions[key] = s;
  }
  attachPoolKeys(positions, positionMgr, cfg);
  return positions;
}

module.exports = {
  buildStatusPositions,
  _UNMANAGED_SETTINGS_KEYS, // exported for tests
};
