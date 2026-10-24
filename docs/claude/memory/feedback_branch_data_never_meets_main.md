---
name: feedback_branch_data_never_meets_main
description: "The user's server never runs main's code on data a branch wrote, so never check whether main can read what a branch writes"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-10-22T18:23:08.675Z
---

The user's sequence for a branch: they try it on their live server, and
if it looks right, full CI follows (all eight steps, see
feedback_ci_protocol.md). They stop their server before CI starts, and
do not restart it until every step is done, the PR merge included. So
their server never runs `main`'s code on data the branch wrote, and
after the merge `main` is the branch.

**Why:** the user, 2026-10-22, after I checked whether the records the
`activity-log-upgrade` branch writes would stop `main` from starting:
"Why were you checking switching back to `main`? If this branch looks
okay to me, we are just going to run the full c.i. You will switch
branch to `main` briefly but I will have stopped my server before then,
so that tests can run. I would not restart until all c.i. is complete.
What part of that is confusing?"

**How to apply:** Don't check whether `main` can read what a branch
writes, and don't plan for the user running `main` partway through a
branch. Related: [[feedback_dont_invent_a_requirement]],
[[feedback_one_thing_at_a_time]].
