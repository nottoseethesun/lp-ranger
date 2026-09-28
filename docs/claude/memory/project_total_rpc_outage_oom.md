---
name: project_total_rpc_outage_oom
description: "Production 0.9.4 was OOM-killed on 2026-09-27 when all three RPC endpoints failed together: ethers' network detection bypasses the paced send(), so the read-retry loop spun and leaked ~11 KB per iteration. Fixed 2026-09-28 with staticNetwork in buildProvider; not yet on Production."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-28T17:32:37.389Z
---

**Fixed 2026-09-28, uncommitted/unreleased at the time of writing.**
Hit Production on release 0.9.4 (`commit=4df40c5`), 2026-09-27.
Evidence: `troubleshooting-work/out-of-memory-error/lp-ranger.log`
(113 MB, 483,727 lines).

All three PulseChain endpoints began answering `502` at 07:07:25. Two
`retryRead` loops then spun for **5 h 44 m**, each reaching attempt
**#112,749** — 225,498 iterations at ~11/sec — while the rest of the
process was frozen solid. Not one non-retry line was written in that
window. Every retry hit `rpc.pulsechain.box`, the third endpoint; the
list never restarted at the first. Memory climbed until the kernel
killed it.

## Why it happened

Six links, each confirmed by reproduction:

1. `_patchRequestPacing` (`src/bot-provider.js`) wraps `provider.send`.
   Under a halt, `acquire()` never resolves, so that wrapper's body
   never runs.
2. ethers' `JsonRpcProvider.send()` is the **only** caller of `_start()`,
   and `_start()` is what sets `ready`. Held at `acquire()`, it is never
   reached, so the provider never becomes ready. Endpoints two and three
   were never ready to begin with — built at boot, never used while the
   primary was healthy.
3. Not ready, `_detectNetwork()` takes its primitive branch and calls
   **`this._send(payload)` directly**. That is the one path that never
   consults the request manager: unpaced and unhaltable.
4. `AbstractProvider.getNetwork()` clears its cached promise on failure,
   so **every** read detects again.
5. `retryRead` (`src/rpc-read-retry.js`) has no exit and no backoff by
   design; its stated brake is the global queue, and the failure
   short-circuits past it. So it spun at network speed.
6. Every iteration re-armed `halt()` and `_stickyUntilMs` to one hour
   out. At five reports a second neither could ever expire: the pause
   became permanent rather than hourly, which is why the whole app went
   silent and the endpoint list never rotated.

**The leak:** ethers' `call()` starts its `eth_call` — which queues via
`acquire()` — *before* awaiting network detection. Detection throws, the
call is abandoned, but its waiter stays in the unbounded `_queue`
holding ~11 KB of promise chain, args and payload. One orphan per
iteration; 225,498 of them is roughly 2.5 GB.

## The fix

`buildProvider` now hands every provider a **`staticNetwork`** built from
`chains.json`'s `chainId` (`_knownNetwork`). `_detectNetwork` returns
from config without touching the wire, so there is no failing step for
`call()` to race and the queued read is the only thing in flight — held
by the halt, as designed. It also drops a redundant `eth_chainId` that
`getNetwork` had been sending on *every* read.

Trade accepted: ethers no longer notices an endpoint changing chain
mid-session. That check only ever compared an endpoint against its own
first answer, so it never caught one endpoint in the list disagreeing
with another, and a wrong chain surfaces at once as contract reads that
find nothing.

Reproduction lives in `test/rpc-outage-no-unpaced-detection.test.js`. It
needs a **real socket** — a stub provider never runs `_detectNetwork`, so
it has no seam to exercise. Against the unfixed tree it fails on all
three assertions: 3,806 requests and 3,807 queued reads in a 1.5-second
window, versus three requests and a queue of one after the fix.

## What to watch on Production

The pause should now behave as written: one banner, silence for the
hour, then the list restarts at `g4mm4`. If a future log shows the
banner repeating faster than hourly, something has reopened a path
around `acquire()` — that repetition is the tell, and it is cheap to
grep for.

## Theories checked and discarded

A string config value slipping past `halt()`'s `Number.isFinite` guard
while the banner still read "1 HOUR(S)" — already covered by
`_assertTimerKeys` and `_timerOrNull`. And `getPoolState`'s
fresh-provider-per-URL-per-attempt — it logs `[pool-state]`, which
appears exactly once in the whole log.

Related: [[feedback_verify_runtime_before_rediagnosing]],
[[feedback_instrument_before_inferring]], [[project_consolidate_rpc_retry]],
[[feedback_defense_in_depth_must_be_slower]].
