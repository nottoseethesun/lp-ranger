---
name: project_dashboard_cleanup_nth
description: "NTH (polish, not bugs) — dashboard import cycles, module-level cache sweep, 42 orphan HTML ids"
metadata: 
  node_type: memory
  type: project
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-20T22:28:49.522Z
---

# Dashboard cleanup — nice-to-haves

Polish, not bugs. Merged from: project_dashboard_cycle_cleanup, project_dashboard_state_cleanup, project_unused_html_ids_audit.

## dashboard cycle cleanup

`npm run show-dependency-cycles` (added 2026-05-03 on `add-madge-cycle-check`) reports 31 circular dependencies, all in `public/dashboard-*.js`. None in the CJS server-side code.

**Why:** Cycles are real but masked by esbuild bundling at build time. The longer-term goal is to wire `madge --circular` into `npm run check` so new cycles are caught in CI; that requires the existing `public/` cycles to be cleaned up first or grandfathered with an allow-list.

**How to apply:** When the user wants to tackle this, the cycle clusters break down into roughly 10 atomic groups (some 2-module, some up to 7-module chains around `dashboard-positions ↔ dashboard-data ↔ dashboard-events` and `dashboard-data-status ↔ throttle ↔ compound`). Standard tactics: extract a shared state/types module, invert one direction via callback/parameter, or (last resort) lazy `import()`. No automated tool recommends fixes — `madge` only diagnoses. Order of operations: trivial 2-module cycles first (`wallet ↔ wallet-import`, `data ↔ closed-pos`, `data-status ↔ alerts`), then the data-kpi cluster, then the load-bearing positions/data hubs, then the events chain, then throttle/compound chain. Manual UI verification after each cluster — no automated dashboard tests exist.

After cleanup is done, add `madge --circular --extensions js src/ bot.js server.js scripts/ eslint-rules/ test/ public/` as a step in `scripts/check.js` so future cycles are blocked.

## dashboard state cleanup — RESOLVED 2026-09-02

**Nothing left to do here; the other two sections of this file are
still live.** Re-checked all eight flagged caches against the tree:
`_historyPopulated` and `_configSynced` no longer exist at all;
`_lastStatus`, `_scanWasComplete` and `_lastEvents` are explicitly
reset on position switch; and `_lastData`, `_lastPrices` and
`_allPositionStates` are overwritten wholesale every poll, so none of
them can hold a previous pool's value the way `_poolFirstDate` did.
The one-poll window after a switch is closed by `_activateCore`
firing `pollNow()` immediately. Removed from the README's
Nice-to-Have list; do not re-add it.

Original note follows, for the triage rule, which is still worth
applying to caches added in future.

After fixing the `_poolFirstDate` sticking-across-pools bug (branch `fix-lifetime-days-sticking-across-pools`, 2026-04-28), the user noted there are likely more dashboard module-level caches that mirror per-poll data and could leak across position/pool switches the same way.

**Candidates flagged for later** (all in `public/`):
- `dashboard-data.js:105` — `_lastStatus`, `_historyPopulated`, `_configSynced`
- `dashboard-data.js:205` — `_scanWasComplete` (derivable from `data.rebalanceScanComplete`)
- `dashboard-il-debug.js:23` — `_lastData`
- `dashboard-history.js:32` — `_lastEvents`
- `dashboard-price-override.js:37` — `_lastPrices`
- `dashboard-positions-store.js:115` — `_allPositionStates`

DI slots (`let _pollNow = null` etc.) are a different pattern — leave them.

**Triage rule:** "Does this cache mirror what the next poll already carries, AND does it leak across position/pool switches?" — same test that nailed `_poolFirstDate`.

**Why:** Deferred during the burn-in/soft-launch phase (post-MVP, post-soft-launch-ready 2026-04-24). The codebase is well-tested and stable; speculative refactors risk introducing regressions before a production release. The single-bug fix already shipped covers the user-visible symptom.

**How to apply:** Don't proactively start this cleanup. Bring it up only when (a) the user signals burn-in is over, (b) a related bug surfaces, or (c) the user explicitly asks to revisit dashboard state hygiene.

## unused html ids audit

**One-shot HTML id audit** run 2026-07-23 found **47 provably-unused
ids** in `public/index.html` (plus zero orphan `data-tpl` slots — a
useful reassurance).  Same fingerprint as the dblWindowLabel bug that
motivated the audit — HTML subtrees gutted from the code but the
shell left behind.

**Cluster 1 (5 ids: `dbl*` doubling-mode detail panel)** was deleted
same day on branch `remove-dead-doubling-panel-html` (see git log for
merge PR).  Doubling status still surfaces via three live paths
(`throttleBadge`, `rangeBanner`, `kpiCountdown`) plus the help
paragraph — the deleted subtree was a supplemental detail view
nothing wrote to.

**~42 orphan ids remain catalogued** in [[docs/2026-07-23-unused-html-ids-audit.md]]
organised by cluster:
- **Cluster 2** — inline-edit dialogs Save/Cancel/Reset (~25 ids)
- **Cluster 3** — wallet-import validation shell (10 ids)
- **7 individual finds** — each near a different dashboard module

**Why:** The rejected DOM-id-orphan lint idea (task #47 in this
session) was too edge-case-fragile — dynamic ids and template slots
generate false positives.  A one-shot audit + opportunistic cleanup
is safer.  Follows [[feedback_fix_only_what_was_asked]] posture
(don't sweep unrelated areas mid-task) with a modification: when the
current task lands in one of the catalogued areas, do the local
hygiene pass while context is loaded.

**How to apply:**
- **At the start of any task** touching the areas listed under
  "trigger conditions" in the docs file, consult the docs entry
  and check whether the orphan id in that neighbourhood is still
  provably unused (grep current tree — the docs are point-in-time).
- Delete confirmed-still-unused ids + exclusively-orphaned CSS in
  the same commit as the primary task.  Same pattern as the
  Cluster 1 delete — HTML subtree + orphaned CSS + verifier grep
  in the commit message.
- Never bulk-delete across clusters in one PR — one cluster at a
  time, small blast radius.
- Do NOT propose these deletions at random turns — same posture as
  [[project_code_cleanup_nice_to_haves]]: only surface when the
  user opens the door or the current task already puts you in the
  neighbourhood.
- The audit itself can drift.  If the docs list an id as unused
  but it is now referenced by JS/CSS/aria/for, remove it from the
  docs entry in the same session.

---

**On the public list (2026-09-02).** The orphan-HTML-ids section is now published on the README's
Nice-to-Have list as "Remove Orphaned HTML Element IDs", detailed in
`docs/roadmap/clean-ups/project_orphan_html_ids.md`.
Keep the two in step, and do not add a second entry for it.
