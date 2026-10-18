---
name: feedback_word_budget_keeps_every_step
description: "A word limit is met by dropping whole points, never by dropping steps of the argument or the context a reader needs first; a compressed explanation that skips a step is unreadable"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T18:48:49.901Z
---

When an answer has a word budget, meet it by leaving out whole points.
Never meet it by deleting the steps that connect cause to consequence,
or the context that says when and why the thing happens.

**Why:** the user, 2026-10-17, on a report written to tight budgets:
"you skipped some key logic in there so that I can't understand what
you are saying"; "you save a few words - congrats! - but now, no one
can know what you mean"; and "Do you see how incredibly confusing it is
to read your explanations?!!" Three failures, all compression:

- "`.env` values skip their ranges" meant "skip their range checks".
  Dropping one word changed the claim.
- The failed-aggregator gas item jumped from "it spends gas anyway" to
  "the figures read low", with nothing in between: not which
  transactions, not why the router's result leaves them out.
- The gas-figures answer said one figure "prices a swap before any
  quote exists" without first saying what the check is for, when it
  runs, or why no quote exists yet, so the reader asked how that was
  even possible.

**How to apply:**

- Open with what the thing is and when it happens, in operator terms
  ([[feedback_general_to_specific]]), then each step in order: what
  happens, why, what that leads to, what the reader would see.
- Before sending a compressed paragraph, read it as someone who has not
  seen the code. Any step they would have to guess goes back in, and
  something else comes out to make room.
- A shorter sentence that changes the meaning ("ranges" for "range
  checks") is not a saving. Name the thing exactly
  ([[feedback_distinct_terms_for_distinct_things]]).
- If the budget cannot hold the whole argument, say less, not
  everything faster: drop a lesser point, a qualifier or a detail.

Related: [[feedback_prose_style]], [[feedback_explain_behavior_not_call_sites]].
