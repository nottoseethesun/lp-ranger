---
name: feedback_dead_code_removed
description: "Code that can never run is removed, whoever wrote it and whenever; a fallback made unreachable by a startup check goes in the same change"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-11-27T21:08:12.935Z
---

# Dead code is removed

The user's words, 2026-10-17: "remember the dead code rule; if those can
never fire, then they get removed; remove them." Said about four
`displayName ?? "?"` fallbacks that a startup check had made unreachable,
and about the same class still in the code: the aggregator's
`|| "(empty)"` log label and two `_attemptLabel ||` fallbacks.

**What counts.** A branch, fallback or guard that no input can reach,
proven from the code: its only caller always supplies the value, an
earlier check in the same path already rejected the case, or startup
refuses to run without what it guards against.

**What does not.** A branch reached by data from outside the process —
an api answer, a receipt, a chain read, a user's file — even if it has
never been seen to fire. "Unreachable in practice" is not "can never
fire".

**Why:** dead code is read, maintained and tested as if it mattered, and
it hides what the code really guarantees. A fallback that cannot fire
also tells the next reader the value can be missing, which is false.

**How to apply:**

- Remove it in the change that finds it, pre-existing or not; this is
  not a sweep to ask about. Report what was removed and why it could
  not fire.
- A test that exists only to reach the dead branch goes with it.
- Prove the claim before deleting: name the caller, the check or the
  startup refusal that makes it unreachable. If the proof needs "in
  practice", it is not dead.
- A coverage list that excuses a branch as "unreachable" is a list of
  candidates for this rule, not a place to leave them.
- **A replaced mechanism takes its own parts with it** (the user,
  2026-11-27, when a Clear or an import changed from waiting for a
  rebalance or compound to refusing at once: "we can't leave unused
  subsystems in the code"; "If anything else needs that system, it
  stays, of course"). Before building the new way, list every caller of
  the old one: what only the old way used goes in the same change, its
  texts and docs included, and what another caller needs stays. Tell
  the user which is which, naming the callers. The callers being moved
  to the new way stop calling the old one: I first described the Clear
  and the import as still calling the waiting stop, and the user had to
  point out that removing that was the change ("please be more
  careful").

Related: [[feedback_never_hard_code_a_chain]],
[[feedback_one_literal_per_shipped_default]],
[[feedback_no_finding_without_a_failure]].
