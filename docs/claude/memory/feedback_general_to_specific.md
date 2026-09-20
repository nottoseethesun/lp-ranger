---
name: feedback_general_to_specific
description: "Open every explanation at the highest level — name the thing and the situation in the operator's terms — then descend to mechanism and evidence. Never start mid-explanation."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-20T02:00:55.373Z
---

Start at the top and work down. The first sentence names **what is being
discussed**, in the terms the user sees it — the position, the panel, the
figure, the transaction — before any mechanism, file, field or function
appears.

**Why:** the reader does not hold the frame the answer was written
inside. An opener like *"it's real, and here's the trace: exactly three
things can write the open period's gas coins"* is unreadable, because
every noun in it depends on a paragraph that was never written. The user,
repeatedly, on exactly this: *"you are starting in the middle, making it
unintelligible"*, *"what in God's name are you talking about"*, *"you
always omit the context"*, and *"start with what you are talking about:
E.g., the P&L Table at the bottom"*.

**The order:**

1. **The subject and the scenario.** "Your position #164418 was minted on
   2026-08-25, and that mint cost 3,069 PLS in gas."
2. **What is wrong or being asked, in operator terms.** Which number, on
   which screen, reading what.
3. **The mechanism.** Now names may appear — the field, the function, the
   file and line.
4. **The evidence.** The measurement, the trace, the log line.

**Tells that it is starting in the middle:** the first sentence contains
a code identifier; it opens with "it" or "that" referring to something
unnamed; it answers a question the reader has not been given yet; it
leads with a verdict ("it's real", "confirmed", "nothing to fix") before
saying what "it" is.

**The user's own drill for this is the word-budget tiers** — "40/100/200,
general to specific" — where each tier must stand alone and each must
open by naming the subject. Practice the 40 first: if the subject is not
in it, the longer versions will start in the middle too.

Related: [[feedback_operator_sees_ui_not_logs]] (answer in badge and
dialog terms, not log terms), [[feedback_no_internal_constants_in_design_talk]]
(describe operator-facing behavior, not implementation constants),
[[feedback_distinct_terms_for_distinct_things]] (one word per entity),
[[feedback_prose_style]].
