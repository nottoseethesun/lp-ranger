---
name: feedback_filing_a_nice_to_have
description: "'Add a nice-to-have' asks for the filing only: its page, README row and PROJECT-STATE pointer, written from the user's report in the operator's terms (the state the coins are in, not the code path); a long investigation reads as building it"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 67808dab-090d-4b12-aba7-71b304368cd3
  modified: 2026-11-03T20:45:52.300Z
---

When the user asks to add a nice-to-have, file it: its page in
`docs/roadmap/nice-to-haves/`, its row in the README's Nice to Have's
table, and its pointer in [PROJECT-STATE](PROJECT-STATE.md)'s Deferred
list. Write it from what the user reported, reading only the code its
claims need, and say in the first line that nothing is being built.

**Why:** 2026-11-03, asked to add "When prior rebalance failed, still
calculate the % loss correctly for the stats on the Activity Log
entry", I spent a long run of tool calls reading the rebalance code,
the server log and the rebalance log before writing anything. The user:
"No, don't build it. I am just saying, we need to add it to the roster
of nice-to-haves." The page then asked which step had stopped the
failed rebalance. The user: "It doesn't matter what stopped the
rebalance: All you need to know is that the coins were not managed."

**How to apply:** Name the plan first: "Filing it: the page, the README
row, the pointer." State the item in the operator's terms: what the
operator sees and the state the coins are in, not the code path that
led there. Read the code only to state the current behavior correctly.
Leave out a question whose answer would not change the item; one that
would goes in the page's "To settle first" list, unchased. Related:
[[feedback_one_thing_at_a_time]], [[feedback_general_to_specific]],
[[feedback_nice_to_haves_not_bugs]].
