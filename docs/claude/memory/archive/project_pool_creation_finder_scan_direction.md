---
name: Pool-creation Factory scan direction
description: Resolved 2026-09-13 — findPoolCreationBlock now scans newest-first; the roadmap entry and README row are gone
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-09-13T19:33:44.995Z
---

**Resolved 2026-09-13.** `findPoolCreationBlock` passes
`direction: "desc"` to `scanChunked`, so the Factory's `PoolCreated` log
is walked newest-first with an early exit on the first match. The
roadmap file `project_pool_creation_scan_direction.md` and the README's
"Reverse the Pool-Creation Block Scan" row have been removed.

Chunk width is `getLogsChunkSize` (7,500), not the 50k this memory
originally recorded — endpoints reject `eth_getLogs` above 10,000
blocks, so no caller can ask for wider.

Kept for history below.

---

`src/pool-creation-finder.js` `findPoolCreationBlock` walks the V3
Factory's `PoolCreated` event log from oldest to newest. For a pool
created today inside a 5-year scan window, that traverses ~150 chunks of
empty history before finding the creation event in the most recent
chunk.

Since the cached-resolver fix (commit `c57339f`, branch
`fix-event-scanner-pool-creation-cache-bypass`), this cost is paid at
most **once per pool ever** — `getPoolCreationBlockCached` memoises the
result in-process and persists it to disk. So this is purely a
cold-cache, first-encounter optimisation.

**Why:** Surfaced 2026-05-02 on a freshly-created TEXAN/eTexan pool. The
primary bug (wallet LP scans re-walking the Factory every time) is
fixed; this remaining inefficiency only hurts the very first lookup.

**How to apply:** Reverse the loop in `findPoolCreationBlock` (iterate
from `toBlock` down to `fromBlock` in chunks, returning the first
match). Newly-created pools resolve in one chunk; old pools fall back to
roughly the same cost as today.
