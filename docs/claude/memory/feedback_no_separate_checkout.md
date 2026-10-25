---
name: feedback_no_separate_checkout
description: "Work in the user's own checkout; never a git worktree or another copy of the repo unless the user asks, since the user cannot see work done there"
metadata:
  type: feedback
---

Make every change in the user's checkout (`lp-ranger/`), on a branch
there when one is needed. Never make a git worktree or a second copy of
the repo unless the user asks for one.

**Why:** 2026-10-24, I built the folder split for the server and the bot
in a worktree (`../lp-ranger-folders`), so the main copy, which the
user's server ran from during their test of 0.9.11, stayed as it was.
The user, 2026-10-25: "I never asked you to go to a separate checkout;
don't do that and don't do git-worktree unless I tell you, because then
I can't see your work easily." When I began moving the work back: "Just
finish the work here."

**How to apply:** When a change would touch files the user's running
server uses, say so and let the user stop the server or decide; don't
route around them with another checkout. To read another revision, use
`git show <rev>:<path>` or `git diff <rev>`, never `git stash`
([[feedback_never_stash_to_compare]]).
