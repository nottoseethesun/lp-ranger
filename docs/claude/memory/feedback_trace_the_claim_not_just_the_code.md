---
name: feedback_trace_the_claim_not_just_the_code
description: "Before writing a consequence into a commit message or a memory, follow the value to the screen or the condition to every caller that raises it — three audit passes in four found a claim stated more broadly than the code supports."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-04T07:01:27.080Z
---

A fix has two artefacts: the code, and what gets written about it. The
second outlives the first and is trusted without re-checking, so a claim
stated more broadly than the code supports is worse than a bug — nobody
goes back to verify it.

**Why:** three of four audit passes on 2026-10-03/04 found exactly that,
each time in a commit message *and* a memory file:

1. "A zeroed baseline makes IL/G report the whole position as a gain." It
   does not. The caller guards zero amounts and the figure comes back
   absent, so the dashboard shows dashes. Reached by reading one
   function's guard and stopping before its caller.
2. "Leaving the gas figure unset makes the dashboard fall back to the
   running epoch's gas." One of its two gas displays does that. The other
   coerces an absent figure to zero and renders $0.
3. "The scan now carries *the operator asked for a repair*." It carried
   "recompute or re-value", and a rebalance asks for a recompute — so the
   re-read fired after every rebalance, spending quota on a price that
   cannot change.

Each was a claim about a *consequence*, and each was wrong in the same
way: the mechanism was traced one step and the step after it decided the
outcome.

**How to apply:**

1. **For a value, follow it to the screen.** Not to its first consumer —
   to what the operator sees. A guard, a coercion or a fallback two
   layers on is what decides whether the harm you are describing exists.
2. **For a condition, find every writer.** "This fires when X asks" is a
   claim about every caller that raises the flag, not about the one you
   had in mind. Grep for the assignment, not the read.
3. **Write the consequence last.** If the sentence names a figure, a
   panel or a cost, it is a claim that needs the trace above before it is
   committed — and a commit message cannot be corrected later.
4. **A corrected claim is worth a line saying it was corrected.** The
   next reader has no way to know which sentences were checked.

Related: [[feedback_verify_before_claiming]],
[[feedback_ask_what_withholding_costs]],
[[feedback_explain_behavior_not_call_sites]].
