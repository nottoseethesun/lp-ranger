---
name: feedback-audit-program-state
description: "After any non-trivial feature, audit every change for unnecessary program state — derive from existing state where possible instead of stashing flags / refs / DOM attributes."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-11-28T02:37:06.635Z
---

After completing any non-trivial feature, **proactively audit the full diff for unnecessary program state**. Walk file-by-file: every new module-level variable, every new field stamped onto an existing object, every DOM data-attribute, every cache. For each one, ask: "Can this be DERIVED from existing state at the point of use instead?" Default to derived; only keep stashed state when there is a concrete reason (cost of recompute, action-at-distance, etc.).

**Why:** State is the most expensive thing in a codebase. Every flag becomes a source of drift, a thing reviewers must trace, an edge case that fires when stash and reality disagree. The user explicitly validated this pattern after seeing the closed-position-reopen PR pass an audit that caught a `data-reopen` DOM attribute on the rebalance modal — derivable from `isPositionClosed(active) && !isPositionManaged(active.tokenId)` at confirm time, with the bonus that the derived form correctly handles the "position auto-retired while modal was open" edge case the stashed flag would have missed.

**How to apply:**

- Run the audit BEFORE asking the user to test — don't wait for them to request it. A built-in self-review step at the end of each implementation pass.
- For each new piece of state, write down one sentence answering "what specifically forces this to be stashed rather than derived?" If the sentence reads weak, refactor.
- Report the audit as a per-file table (no state added / state added → justified / state added → removed) — same format used in the closed-position-reopen turn. Makes the user's verification cheap.
- Same rigor for client-side DOM data-attributes as for server-side module-scoped `let` variables — they're both program state with the same drift risk.
- When the same condition is checked at multiple call sites, derive it inline at each site rather than stashing it. Duplicated derivation is fine; stashed state behind a single derivation is not (the stash becomes the load-bearing thing).
- Stashing IS justified when: (a) computing the value would re-do an expensive RPC / DB call, (b) the source state has already mutated by the time the consumer runs (then the stash IS the load-bearing source-of-truth), or (c) the consumer literally cannot reach the source (cross-module without an existing import path). Reaches for any of these should still be explicit, with the reason in a code comment.
- For a dashboard module-level cache, ask: does it mirror what the next poll already carries, and can it leak across a position or pool switch? Both yes means derive it, or reset it on the switch. It is the test that found `_poolFirstDate` carrying one pool's first date to another (2026-04-28), and the sweep of the other caches it prompted found none left by 2026-09-02.
