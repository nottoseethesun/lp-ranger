---
name: feedback-no-classlist-for-state
description: Never read DOM classList (or any rendered DOM property) to determine program state; violates separation of concerns between UI and app state
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-24T05:24:12.666Z
---

Never read `element.classList`, `element.textContent`, `element.dataset`,
`getComputedStyle(...)`, or any other rendered DOM property to make app-
state decisions. The DOM is a one-way **projection** of state — logic
reads from the source-of-truth JS state (a variable, a store, a
poll-result object), never back from what the DOM happens to look like.

**Why:** Two reasons, both load-bearing:

1. **Separation of concerns** between UI rendering and app state.  When
   logic reads the DOM, every styling change, every paint-order quirk,
   every race between "state mutated" and "DOM rendered" can silently
   flip business logic. Worse, the violation hides — the DOM read
   looks like just another lookup, so the dependency is invisible at
   review time and only fails when something paints out of expected
   order.

2. **It IS adding excess program state** (per [[feedback-no-extra-state]]
   and [[feedback-audit-program-state]]).  A DOM read for logic
   purposes treats the DOM as a state store — so the system now has
   two stores for the same fact: the real one (a variable, a store,
   a poll result) and the shadow one (the DOM's rendered class /
   text / attribute).  Even though no `let` was added, the *effective*
   state count went up, and now the two have to be kept in sync.  The
   DOM is supposed to be a one-way PROJECTION of state, never a
   parallel record of it.  "I'm just reading what's already there"
   is the trap — every DOM read for logic invents a second source
   of truth.

**How to apply:**
- For "is sync complete?" → read the cached poll result (e.g.
  `getLastStatus()`), NOT `syncBadge.classList.contains("done")`.
- For "is the modal open?" → check the JS flag you set when you opened
  it, NOT `modal.classList.contains("visible")`.
- For "is this position selected?" → read the store
  (`posStore.getActive()`), NOT `.selected` class on a row.
- If the DOM is the only place a piece of state exists, that itself is
  the bug — promote it to a real variable/store first, then both the
  DOM render AND the logic read from the variable.
- Even "defense-in-depth" DOM reads are forbidden. They look harmless
  but lock in the wrong invariant: the UI becomes upstream of the
  business decision instead of downstream of it.

**Concrete example from this codebase (the bug that taught the rule):**
`src/client/web/dashboard-events-manage.js`'s `_runClosedPositionFlow` checked
`g("syncBadge")?.classList.contains("done")` to gate a re-open click.
When a separate bug left the badge stuck on "Syncing…", the click was
silently ignored — even though the underlying app state had a perfectly
clear answer. The fix: derive `syncComplete` from the poll-result
object (the same object `_updateSyncBadge` already consumes to set the
class), so render and logic share one source of truth.
