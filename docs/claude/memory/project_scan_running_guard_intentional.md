---
name: project-scan-running-guard-intentional
description: "`_triggerScan`'s `_scanRunning` guard intentionally drops new scan requests while a scan is in flight — full-scans are coarse-grained by design and don't need up-to-the-second accuracy."
metadata: 
  node_type: memory
  type: project
  originSessionId: ee80f1a7-2778-41af-8f18-a3f5993e9278
  modified: 2026-10-24T04:55:09.163Z
---

`src/lib/bot-loop.js#_triggerScan`:

```js
botState._triggerScan = async () => {
  if (botState._scanRunning) return;   // drop the NEW call, not the in-flight one
  botState._scanRunning = true;
  try { ... await _scanAndReconstruct(...); ... }
  finally { botState._scanRunning = false; }
};
```

**Behaviour:** if a scan is already running and a new `_triggerScan`
arrives, the new call returns immediately — no queue, no retry, no
log.  The in-flight scan continues to completion.

**Why this is correct (not a bug):** full rebalance-history scans are
intentionally coarse-grained.  They run when:

  1. We have no scan info at all (boot, fresh position).
  2. We know a new event happened (post-rebalance trigger).

Neither case needs up-to-the-second accuracy.  The dashboard's
rebalance-events table will self-heal on the next scan.  The
throttle is unaffected — `recordRebalance()` synchronously updates
`dailyCount` / `rebTimestamps` / `lastRebTime` before
`_triggerScan` even gets called.

**How to apply:** when reviewing/auditing the rebalance pipeline, do
NOT flag this guard as a missed-update or stale-data risk.  It's
deliberate.  If a future change requires up-to-the-second event
freshness, queue/coalesce trigger requests explicitly rather than
removing the guard.

Confirmed by user 2026-06-21.
