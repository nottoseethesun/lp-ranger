---
name: feedback_ask_what_withholding_costs
description: "When a fix stops writing a value, check what happens to the value that was already there — a withheld key in a container that gets replaced wholesale is a deletion, not an abstention."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-04T04:47:26.298Z
---

A fix that stops recording a wrong value has two halves, and the second
one is easy to miss. The first is that the new behaviour is right. The
second is **what happens to what was already saved.**

**Why:** 2026-10-04, the per-NFT gas fix. An unreadable receipt had been
recorded as "cost no gas", so the fix withheld the figure instead. The
value withheld was a key in a map, and the lifetime scan writes that map
**whole** — so an NFT left out of the rebuilt map lost the figure an
earlier scan had read correctly. Withholding and deleting were the same
act. That is the failure the previous day's fix had been written to
prevent, reproduced one commit later in a different container.

The same commit also returned an "empty" result to signal unknown, and
the caller took it literally: it displayed $0 gas — the exact figure the
fix existed to stop showing — and $0 compounded fees, a number read
correctly and unrelated to gas.

**How to apply:**

1. **Find the container.** A value is rarely written alone. If it lives in
   a map, an object or a record that is assigned whole, withholding one
   key removes it. Seed from what is saved, or merge; never start empty
   and assign over.
2. **Ask what the absence displays as.** An "empty" or "default" return
   is read literally by callers. Trace it to the screen: a sentinel that
   coerces to `0` is a false zero, which is the thing most of these fixes
   are about.
3. **Withhold the one value, not its neighbours.** Returning early past a
   whole result discards everything computed alongside it. Compute what is
   known first and refuse only the part that is not.
4. **Write the test for the value you did not write.** "Keeps the saved
   figure when this read fails" is the assertion that catches this class;
   asserting only that the new path returns null does not.

Related: [[feedback_dont_persist_a_correction]],
[[feedback_never_clear_to_force_a_recompute]],
[[feedback_no_finding_without_a_failure]].
