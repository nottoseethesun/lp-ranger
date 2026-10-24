---
name: feedback_reset_keep_not_hard
description: "CI protocol step 4 says `git reset --hard origin/main`, which also destroys uncommitted work in the tree — use `--keep` whenever anything is dirty"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-24T05:23:58.424Z
---

Step 4 of the CI protocol undoes the local merge-to-main check with
`git reset --hard origin/main`. That command moves the branch pointer
**and** overwrites the working tree, so it discards every uncommitted
change, including files that have nothing to do with the merge.

Use `git reset --keep origin/main` instead whenever the tree is dirty.
It rewinds the same way but refuses to clobber local modifications to
files that do not differ between the two commits — so the merge is
undone and unrelated work survives.

**Why:** on 2026-10-04 the tree carried two uncommitted files,
`src/client/web/9mm-pos-mgr.css` and `src/client/web/index.html`, holding nothing but
cache-bust stamps from the operator's own build. A `--hard` would have
reverted them silently, and
[[feedback_never_revert_cache_bust_stamps]] exists precisely because
that stamp IS the invalidation. Nothing would have errored; the loss
would have surfaced later as a browser serving stale assets.

**How to apply:** before step 4, run `git status --porcelain`. Clean
tree, `--hard` is fine and matches the written protocol. Anything
listed, use `--keep`, then verify afterwards that the files are still
listed as modified. Say which one was used and why, since the written
step says `--hard` and a reader will otherwise think it was ignored.

The protocol doc still prescribes `--hard`
([[feedback_ci_protocol]]); this is the exception it does not mention,
not a disagreement with it.
