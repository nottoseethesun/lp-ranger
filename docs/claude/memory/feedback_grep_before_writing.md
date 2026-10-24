---
name: grep-before-writing
description: "Before writing any new code that reads server data or calls a module API, grep for the existing usage first. Do not hypothesize about causes when reading the code would tell you."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d932d59e-01b4-45db-82b1-6d987abcda8f
  modified: 2026-10-24T05:23:48.426Z
---

Before writing any new client-side reader of server state, any call to a service module, or any new consumer of an existing data shape — grep the codebase for how the same thing is already done.  Do NOT reach for hypothetical causes (browser cache, timing races, cache-busting theories) while a two-second grep would tell you the actual answer.

**Why:** Every non-race failure in the 0.8.8 Reload Current Position session traced to skipping this step.
- `_positionState` used `d.positions[key]` when `flattenV2Status` exposes the map at `d._allPositionStates`.  `showPerPositionAlerts` in `dashboard-alerts.js` was reading it correctly — a `grep _allPositionStates src/client/web/` would have shown me in 5 seconds.
- `positionMgr.getPosition()` was a fantasy method.  The real method is `.get()`, right there in `position-manager.js`.
- `state?.position` was wrong for the pool identity; the correct field is `state?.activePosition` (populated by `_activePosSummary` in `bot-recorder.js`).  Any grep of other consumers would have shown it.

Each of these caused the user to sit through an 8-minute scan to confirm a bug that was verifiable from the code in seconds.

**How to apply:**
- Before writing any new reader of server data: `grep -rn "<field-I'm-about-to-read>" src/ src/client/web/`.  Look at 2-3 existing consumers.  If they read a different field, I'm probably wrong.
- Before calling any method on an imported module: `grep -n "function <method>\|<method>:" <module-file>`.  If it doesn't exist, don't call it.
- When something isn't working, read the code that produces the data BEFORE hypothesizing about environment.  "browser cache" is almost never the answer for behavior in a dev tab.

The user's phrasing: "So smart at the detailed stuff, but actually retarded about the simple stuff."  The pattern is real.  Grep is the fix.
