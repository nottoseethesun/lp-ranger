---
name: PR #125 lp-browser-scan refresh — Prod burn-in watch
description: PR #125 (refresh LP browser scan after rebalance even when scan first fails) entered Prod burn-in 2026-05-10; user is watching for test-in-wild
type: project
originSessionId: 07cc2228-b226-49e1-ab79-d7e34d6e38c0
---
PR #125 (commit 14a5bf6, merged 3c1d6a4): `fix(lp-browser): refresh after rebalance, even when scan first fails`. Entered Prod burn-in window starting 2026-05-10.

**Why:** User explicitly said they'll watch for a "test in the wild" of this fix during burn-in — meaning the fix is in but they haven't yet observed the recovery path triggering naturally on Prod.

**How to apply:** If the user references the lp-browser-scan refresh, the rebalance-driven retry, or burn-in observations of either, this is the PR they mean. Code paths to look at: `_handleRebalance` in `public/dashboard-data-events.js` (rebalance-driven `scanPositions` retry that advances `_lastRebAt` only on `{ok:true}`). Burn-in window context: see `project_burn_in_release.md`.
