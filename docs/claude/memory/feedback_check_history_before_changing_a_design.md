---
name: feedback_check_history_before_changing_a_design
description: "Before changing behavior that tests pin as a fix, read the commit that introduced it; a design the user specified waits for the user's word even when a newer rule of theirs seems to cover it"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-18T09:10:39.548Z
---

Before changing behavior that existing tests pin, especially a test whose
name says it guards a fix, read the commit that introduced the behavior
(`git log -S<symbol> -- <file>`, then `git log -1 <hash>`). If the user
specified that design, the change is theirs to make: describe it and ask,
even when a newer rule of theirs seems to cover it.

**Why:** in the 2026-10-18 state-and-sequence audit I removed the Min Time
Between Rebalances optimistic Save apply and its one-shot `skipNextPoll`
marker as a #14 violation ("must only read from what the server
provides"). The tests then pinned it as a regression fix, and a92ac14's
message called the marker a "user-specified design" (2026-07-23). I put it
back and asked instead. A newer general rule and an older specific design
can disagree; which one wins is the user's call, not an audit's.

**How to apply:** when a fix would undo something a test calls a fix,
stop and read its history first. A user-specified design goes in the
report as a question, with what each choice would show on screen.
Related: [[feedback_wait_for_signoff]],
[[feedback_check_state_before_explaining_design]],
[[feedback_fix_only_what_was_asked]].
