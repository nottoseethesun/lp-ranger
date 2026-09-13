---
name: Pool-creation Factory scan direction
description: Obsolete 2026-09-13 — findPoolCreationBlock no longer reads the Factory log at all; it binary-searches eth_getCode
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-09-13T20:34:51.326Z
---

**Obsolete 2026-09-13.** Scan direction stopped mattering:
`findPoolCreationBlock` does not read the Factory's `PoolCreated` log.
It binary-searches `eth_getCode` for the lowest block at which the pool
address holds contract code — 27 calls over a 27.5M-block chain,
verified exact against both of the operator's pools. The roadmap file
`project_pool_creation_scan_direction.md` and the README's "Reverse the
Pool-Creation Block Scan" row are gone.

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
