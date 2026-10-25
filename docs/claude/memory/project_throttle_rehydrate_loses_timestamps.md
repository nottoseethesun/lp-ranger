---
name: project-throttle-rehydrate-loses-timestamps
description: "Nice-to-have — `throttle.rehydrate(count)` restores only dailyCount, not rebTimestamps, so doubling de-bounce is silently disabled across bot restarts until 3 NEW rebalances accumulate post-restart."
metadata: 
  node_type: memory
  type: project
  originSessionId: ee80f1a7-2778-41af-8f18-a3f5993e9278
  modified: 2026-10-24T04:55:09.182Z
---

`src/lib/throttle.js#rehydrate(count)` (around line 259) takes only a
COUNT and sets `state.dailyCount = count`.  It does NOT restore
`state.rebTimestamps`.

`_evaluateDoubling()` is the only consumer of `rebTimestamps` — it
filters for entries within `4 × minIntervalMs` to decide whether to
activate doubling.  After a bot restart, `rebTimestamps = []`, so
`recent.length` is always 0 and doubling never activates from
historical events.  The bot only enforces the bare `minIntervalMs`
floor until 3 NEW rebalances happen post-restart inside the doubling
window.

`dailyCount` IS correctly rehydrated, so the daily-max cap survives
restarts.  Only the burst-protection / doubling mode is broken.

**Why:** User mandate (2026-06-21): de-bounce surviving a bot restart
is a **nice-to-have** because bot restarts are a major edge case
(infrequent, only for updates), not the normal flow.  Bot crashes
during the burn-in period may cause this to manifest, but the user
does not want this fixed yet — work on the true production bugs
first.

**How to apply:**
- Do NOT fix this proactively; it's deferred polish.
- If the user asks for it later, the fix is small:
  - Change `rehydrate(count)` → `rehydrate({ timestamps })`.
  - Populate `state.rebTimestamps = [...timestamps]` and `state.dailyCount = timestamps.length`.
  - Call `_evaluateDoubling()` once at the end of `rehydrate` so the post-restart state correctly reflects any in-flight doubling activation.
  - Caller in `src/lib/bot-recorder.js` (around line 248–253) already has timestamps via `found.map((e) => e.timestamp * 1000)`; just thread them through.
- Do NOT remove the existing dailyCount-rehydration path — that part
  works correctly and must keep working.

Filed during the layered-config audit on PR
[[project-layered-config-refactor]] when investigating the production
de-bounce bug; the actual production bug turned out to be different
and does not require a restart to manifest.
