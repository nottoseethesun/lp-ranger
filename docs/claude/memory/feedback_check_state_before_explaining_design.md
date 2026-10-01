---
name: feedback_check_state_before_explaining_design
description: "Before explaining a code oddity as deliberate design, check PROJECT-STATE.md for an entry that already calls it a known duplication or deferred item. Answering from the code alone produces a defense of something already on the list."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-01T20:52:47.892Z
---

When the answer to "why does the code do X" is about to be
"deliberately", open [PROJECT-STATE.md](PROJECT-STATE.md) first. An
entry there may already call X a known duplication or a deferred
cleanup, which turns a defense into the accurate answer: yes, and it is
on the list.

**Why.** On 2026-10-01 the user asked why a `[pool-state]` failure
against one rpc endpoint had no success line after it. I read the code
and answered correctly on the facts — success logs nothing, and the walk
had stepped to another endpoint — then framed that private endpoint walk
as clean design, since it builds its own providers so process-wide
selection is not disturbed. The user pushed back: *"Doesn't make sense,
because we have one failoverToNextRPC."*

They were right. The app has one `failoverToNextRPC` and two private
walks that bypass it, and
[[project_consolidate_rpc_retry]] had named those exact two
orchestrators as a known duplication since June. **The answer was in
memory the whole time.** I had split the index minutes earlier and
written the instruction to open the state half before touching an area
it covers — then did not open it myself.

**How to apply.**

- A question of the form "how come the code does X" is a prompt to check
  the recorded items, not only the source. The source says what happens;
  the entry says whether anyone already decided it was wrong.
- "Deliberate" and "known duplication" are not alternatives. Both were
  true here: the walk is intentional *and* it is slated for
  consolidation. Say both.
- Do not grade the design in the answer. State what the code does, then
  what is recorded about it, and let the user draw the conclusion. The
  defense is what drew the pushback, not the facts.

## Name the property that is missing, not the mechanism

The second pushback followed from my wording: having said the walk does
not call `failoverToNextRPC`, the user read *"So you are telling me we
have no failover for `getPoolState`?"*

Fair reading of what I wrote, and wrong about the code. That walk **is**
failover for its own read — it tries every endpoint in order and gives up
only when all are spent. What it does not do is change the selection
every other concurrent read uses, which is the part that logs.

So when describing a mechanism a path skips, name the property it lacks
rather than the function it omits. Resilience and selection are separate
claims, and "does not call the failover function" collapses them
([[feedback_distinct_terms_for_distinct_things]]).

Related: [[feedback_verify_before_claiming]],
[[feedback_dont_invent_a_requirement]].
