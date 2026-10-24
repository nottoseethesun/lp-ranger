---
name: feedback_never_stash_to_compare
description: "Never `git stash` to peek at another ref — a clean tree saves nothing and the pop grabs ANOTHER branch's stash; use a worktree"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-10-24T05:23:58.381Z
---

# Never use `git stash` to compare against another ref

To measure something on `main` (or any other ref) while on a branch, use
a throwaway worktree. Never `git stash` / switch / `git stash pop`.

**Why:** On 2026-08-05, comparing import-cycle counts against `main`, I
ran `git stash -q -u`, switched, measured, and `git stash pop`. Two
things went wrong at once:

1. The tree was already clean (everything committed), so the stash saved
   **nothing** — no stash was created, and the command exited quietly.
2. `git stash pop` therefore popped the **top of the existing stash
   stack**, which was a months-old WIP from a completely different
   branch. It conflicted on `src/client/web/index.html` and left the working tree
   in a `UU` unmerged state with another branch's changes half-applied.

Worse, the measurement was silently garbage: because the stash saved
nothing, both "before" and "after" runs measured the same tree, and the
numbers matched for the wrong reason. I reported "no new cycles" on the
strength of a comparison that never happened.

Recovered with `git reset --hard HEAD` (commits were safe, and the other
branch's stash was preserved because the failed pop keeps it), then redid
the comparison properly.

**How to apply:**

- To read or measure another ref: `git worktree add --detach <tmpdir> main`,
  run the tool against that path, then `git worktree remove --force <tmpdir>`.
  Scratch dir, never inside the repo.
- To read a single file from another ref: `git show main:path/to/file`.
- If `git stash` ever seems necessary, check `git status --porcelain` first —
  a clean tree means the stash is a no-op and the pop is dangerous.
- Any comparison whose two sides come out identical deserves suspicion
  before it is reported: confirm the two sides really were different
  trees. See [[feedback_verify_runtime_before_rediagnosing]] — same
  failure shape, measuring something other than what I claimed.

This repo carries many long-lived stashes from other branches, so the
blast radius of a stray `pop` is real, not theoretical.
