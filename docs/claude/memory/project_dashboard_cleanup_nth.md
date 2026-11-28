---
name: project_dashboard_cleanup_nth
description: "NTH (polish, not bugs) — dashboard import cycles, orphan HTML ids"
metadata: 
  node_type: memory
  type: project
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-11-28T02:36:54.187Z
---

# Dashboard cleanup — nice-to-haves

Polish, not bugs. Merged from: project_dashboard_cycle_cleanup, project_unused_html_ids_audit. (A third part, the sweep of the dashboard's module-level caches, was finished and taken out on 2026-11-27; its triage rule is in [[feedback-audit-program-state]].)

## dashboard cycle cleanup

`npm run show-dependency-cycles` (added 2026-05-03 on `add-madge-cycle-check`) reports 31 circular dependencies, all in `src/client/web/js/dashboard-*.js`. None in the CJS server-side code.

**Why:** Cycles are real but masked by esbuild bundling at build time. The longer-term goal is to wire `madge --circular` into `npm run check` so new cycles are caught in CI; that requires the existing `src/client/web/` cycles to be cleaned up first or grandfathered with an allow-list.

**How to apply:** When the user wants to tackle this, the cycle clusters break down into roughly 10 atomic groups (some 2-module, some up to 7-module chains around `dashboard-positions ↔ dashboard-data ↔ dashboard-events` and `dashboard-data-status ↔ throttle ↔ compound`). Standard tactics: extract a shared state/types module, invert one direction via callback/parameter, or (last resort) lazy `import()`. No automated tool recommends fixes — `madge` only diagnoses. Order of operations: trivial 2-module cycles first (`wallet ↔ wallet-import`, `data ↔ closed-pos`, `data-status ↔ alerts`), then the data-kpi cluster, then the load-bearing positions/data hubs, then the events chain, then throttle/compound chain. Manual UI verification after each cluster — no automated dashboard tests exist.

After cleanup is done, add `madge --circular --extensions js src/ scripts/ eslint-rules/ test/ src/client/web/` as a step in `scripts/check.js` so future cycles are blocked.

## unused html ids audit

**One-shot HTML id audit** run 2026-07-23 found **47 provably-unused
ids** in `src/client/web/index.html` (plus zero orphan `data-tpl` slots — a
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
