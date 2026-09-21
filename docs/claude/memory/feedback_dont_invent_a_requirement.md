---
name: feedback_dont_invent_a_requirement
description: "Before building a mechanism, find how the app already answers that class of problem. A stack of guards on top of a new mechanism means the first step was wrong."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-20T21:06:56.716Z
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

## An audit finding is a report, not a work order

**2026-09-20, same session, second occurrence.** Auditing the RPC
outage pause, I found that an operator adding an RPC endpoint during the
pause would have it accepted and then not called until the pause lapsed
— and `docs/configuration.md` promises an addition "is applied to the
running process the moment you save it". I built the fix: a `resume()`
on the request queue, called from `setRpcUrls`.

The user had already settled that question one instruction earlier:
*"The yellow rpc pause is absolute."* Their response: *"I didn't ask you
to clear the wait for anything"*, *"You added a bunch of excess
complexity there"*, *"Don't add functionality requirements without
asking me."* Backed out to the committed state, no trace.

**Two rules from it.**

**A rule the user calls absolute has no exceptions you get to discover.**
"Absolute" was said about this exact mechanism, in this session, after
they had already reversed one proposed exemption for rebalances and
compounds. A later finding that seems to justify an exemption is a thing
to report, not a licence to build one.

**Audits produce findings, and findings go to the user.** Every audit
item lands in one of two piles: a defect in the thing just built, which
is fixed; or a design question about behaviour the user specified, which
is reported with the concrete consequence and left to them. Building
from the second pile is inventing a requirement, however well the audit
justified it.

The user's own summary, and it is fair: this should not need saying —
*"it should be something you know by default."*

Related: [[feedback_no_extra_state]] (reuse existing state before adding
new), [[feedback_audit_program_state]] (audit for state that can be
derived), [[feedback_dont_persist_a_correction]] (before storing a
fix-up, ask whether the wrong value should be written at all),
[[feedback_fix_only_what_was_asked]], [[feedback_no_finding_without_a_failure]],
[[feedback_kiss]], [[feedback_general_to_specific]].
