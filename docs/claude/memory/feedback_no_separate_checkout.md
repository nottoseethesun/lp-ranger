---
name: feedback_no_separate_checkout
description: "Never change the workflow on my own: every change in the user's own checkout, the CI protocol as written; never a git worktree or another copy of the repo unless the user asks"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-10-25T07:42:04.589Z
---

Never change how the work is done without the user's word. Make every
change in the user's checkout (`lp-ranger/`), on a branch there when one
is needed, and run the CI protocol's steps as docs/claude/CLAUDE-CI.md
writes them. Never make a git worktree or a second copy of the repo
unless the user asks for one.

**Why:** 2026-10-24, I built the folder split for the server and the bot
in a worktree (`../lp-ranger-folders`), so the main copy, which the
user's server ran from during their test of 0.9.11, stayed as it was;
on 2026-10-25 I also ran the CI's local merge check there, on a detached
copy of `origin/main`, instead of on `main` in the user's checkout. The
user, 2026-10-25: "I never asked you to go to a separate checkout; don't
do that and don't do git-worktree unless I tell you, because then I
can't see your work easily." When I began moving the work back: "Just
finish the work here." After the merge: "never make changes to the
workflow like you did with the worktree and entire extra checkout.
Delete that extra checkout now." (It was already removed.)

**How to apply:** When a change would touch files the user's running
server uses, say so and let the user stop the server or decide; don't
route around them with another checkout, another place or another
order of steps. A new tool, step or place to work is the user's to
choose. To read another revision, use `git show <rev>:<path>` or
`git diff <rev>`, never `git stash` ([[feedback_never_stash_to_compare]]).
