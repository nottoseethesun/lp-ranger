---
name: feedback_dont_invent_a_requirement
description: "Before building a mechanism, find how the app already answers that class of problem. A stack of guards on top of a new mechanism means the first step was wrong."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-20T06:29:01.026Z
---

Before adding a mechanism, find out how this app already answers that
class of problem, and use that answer.

**LP Ranger's answer for every money figure is: store the coins, compute
the dollars where they are shown.** `src/coin-value.js` is the one place
that multiplication lives; `compoundedAmount0/1` are coins; the Current
panel's gas is `wei × today's price`; a closed period's gas is that
period's coins at that period's close day. CLAUDE.md says it outright:
nothing persists a USD total, because a saved dollar figure is true only
at the price that computed it. **A stored dollar total is the smell.**

**What it cost, 2026-09-19.** Asked to fix a double-counted mint charge,
I wrote a stored dollar figure onto the open period. It could not stand
alone, so each problem it created got its own fix:

1. The charge is re-offered every poll, and the write was `+=`, so it
   accumulated — add a boolean marking it already counted.
2. The boolean froze the figure, so a charge first valued at a fallback
   price could never be corrected — add a field recording how much of
   the total was the mint, so the portion could be rewritten.
3. Periods already on disk had the boolean but no such field, so the
   first offer would double the charge — add a seed to reconcile them.
4. The seed recorded the NEW figure as if it were the OLD one, freezing
   the stale value it was meant to release.

Four layers, each individually defensible, none needed. The whole
structure was deleted: `967ebcc` reduced it to reading a figure the chain
scan already produced, and the net diff across the episode was **−743
lines**.

**The recognition rule: when you reach for a second guard, stop.** One
guard can be a genuine invariant. A guard protecting a guard means the
thing being guarded should not exist. Ask what the app already does for
this class before writing the third line.

**The other tell is your own prose.** The user asked what the problem was
perhaps ten times — *"what in God's name are you talking about"*, *"gas
for what?"*, *"start over"* — and no answer landed, because the mechanism
being described did not fit the app's model, so it could not be described
in the app's terms. Their diagnosis: *"at the deepest root of things, it
flew against entirely how the app should be working."* **When an
explanation will not come out coherent, suspect the design, not the
wording.**

Related: [[feedback_no_extra_state]] (reuse existing state before adding
new), [[feedback_audit_program_state]] (audit for state that can be
derived), [[feedback_dont_persist_a_correction]] (before storing a
fix-up, ask whether the wrong value should be written at all),
[[feedback_kiss]], [[feedback_general_to_specific]].
