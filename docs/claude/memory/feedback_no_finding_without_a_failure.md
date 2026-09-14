---
name: feedback-no-finding-without-a-failure
description: "Never list something as a finding unless you can state what breaks; \"it's inert\" means delete the item, not soften it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-14T04:29:16.572Z
---

An item earns a place in a findings/review/audit list only if you can
finish the sentence "this breaks X for Y". If you cannot, take it out of
the list entirely. Do not demote it to a gentler bullet, and do not pad
it with accurate mechanism description — correct detail does not convert
a non-finding into a finding.

**Why:** On 2026-09-13, reviewing a server log, I listed a config slot
holding settings with no `status` field as finding #4 alongside four real
problems. It was normal Save-before-Manage behavior with no consequence
at all. Having framed it as a finding, I needed a harm, so I invented
one — "can be neither started nor stopped" — without checking.
`addManagedPosition` assigns `status` unconditionally; its own log line
prints `(was undefined → running)`. The fabrication was structural, not
incidental: the framing demanded a consequence and I produced one.

The user's verdict: "you slopped me hard, like a water-cannon of slop."

**How to apply:**

- Decide whether something is a finding BEFORE writing the entry. Writing
  the entry first commits you to the framing and recruits every later
  sentence to defend it.
- Watch for the self-contradiction tell. I wrote "it is inert" inside the
  item asserting it mattered. **"Inert", "benign", "harmless", "worth
  noting" are delete signals.** If the item's own text concedes nothing
  happens, nothing happens.
- When challenged on a weak item, the answer is "none — I was wrong to
  list it", not more detail. I escalated to four headings and code
  references; volume rose as substance fell. Rising volume under
  challenge is diagnostic of an empty item.
- A consequence you have not traced in the code is not a consequence.
  See [[feedback_instrument_before_inferring]].

Related: [[feedback_bug_only_if_current_stack_breaks]],
[[feedback_nice_to_haves_not_bugs]], [[feedback_prose_style]].
