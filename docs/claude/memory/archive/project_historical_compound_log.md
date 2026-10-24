---
name: historical-compound-activity-log-closed
description: CLOSED 2026-07-17 PR
metadata: 
  node_type: memory
  type: project
  originSessionId: ef6c5215-1055-44cf-b98a-f7aa871665e8
  modified: 2026-10-24T05:23:58.768Z
---

**CLOSED 2026-07-17 PR #153.**

`populateCompoundHistoryOnce` in `src/client/web/dashboard-populate-history.js` renders historical compounds into the Activity Log on cold load, mirroring the rebalance-history render pipeline (`populateRebalanceHistoryOnce`) line-for-line. Sync-complete gate → one-shot latch → sort ascending → iterate + `act()`. Reset on position/wallet switch via `resetPopulateHistoryFlags()` (called from `resetHistoryFlag()` in `dashboard-data.js`).

Trigger labels: `historical → "Historical"`, `auto → "Auto"`, `manual → "Manual"` (map in `dashboard-compound-log.js`).

Companion doc `docs/roadmap/nice-to-haves/project_historical_compound_log.md` was deleted in the same PR (feature no longer belongs on the nice-to-have list).

Related: [[feedback-no-junk-repair-code]] — this feature was almost called a "backfill" but the user banned the word mid-PR, prompting a rename sweep and a stronger feedback memory.
