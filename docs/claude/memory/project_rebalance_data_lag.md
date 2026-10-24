---
name: Record rebalances made outside LP Ranger without a reload
description: Nice-to-have — a rebalance made outside LP Ranger (by hand, or by another install) stays unrecorded until Reload Current Position; LP Ranger's own are recorded as they happen
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-24T04:55:01.312Z
---
## Plain language

Every rebalance LP Ranger makes is recorded the moment it finishes
(`appendToPoolCache`, `src/lib/pool-scanner.js`). A rebalance made outside
LP Ranger, by hand on the 9mm site or by another install, after LP
Ranger has scanned the pool, is not: routine scans read only blocks
after the event cache's `lastBlock`, and cannot pair the new mint with
a predecessor that is in the file rather than in the blocks just read.
Nothing re-reads the pool's history on its own, so the rebalance stays
out of the Rebalance Events table and the bookkeeping report until
Reload Current Position. That reload needs a managed, synced position,
and it costs the Routed Via route of every rebalance recorded before
it.

Corrected 2026-10-20: this note used to say the gap closed by itself
within half an hour. It does not, in the current code; nothing
schedules a re-read from the floor.

## Status

Deferred nice-to-have. Full detail in
`docs/roadmap/nice-to-haves/project_rebalance_data_lag.md`, and in
`docs/engineering.md` § "Rebalance Event Caches". The User Manual's
"Rebalancing or Compounding Outside LP Ranger" gives operators the
advice: own moves from another wallet, or a reload.

## Fix when prioritized

When Pass 2 of `pairTransfers()` finds an unpaired new mint and
`cachedEvents` is non-empty, use the latest cached mint for the same
pool as the `mints[i-1]` predecessor.

## How to apply

Deferred until after soft-launch (per `project_burn_in_release.md`).
Do not implement until user explicitly picks it up.
