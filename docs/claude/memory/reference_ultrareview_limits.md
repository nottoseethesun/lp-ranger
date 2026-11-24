---
name: reference_ultrareview_limits
description: "ultrareview (/code-review ultra) refuses a diff past 500 files or 8,000 changed lines; uncommitted tracked changes count"
metadata:
  node_type: memory
  type: reference
  originSessionId: 54faebf5-9812-48c8-8743-e2dde6ca5007
  modified: 2026-11-24T06:39:20.726Z
---

`/ultrareview`, an alias of `/code-review ultra`, refuses a diff past 500
files or 8,000 changed lines. With no argument it diffs the local branch
against `main`, counting uncommitted changes to tracked files but not
untracked files. To narrow it, pass a closer base branch
(`/ultrareview <branch>`) or split the change.

2026-11-24: branch `improve-separation-of-concerns-re-server-and-bot`,
all uncommitted, was refused at 890 files and 12,116 lines (my own count
was 895 and about 12,400 with five untracked files). The user dropped the
review: "Actually, go ahead and commit and push everything to branch,
but don't run c.i. Forget about `ultrareview` then."

**How to apply:** before a refactor that will touch hundreds of files,
ask whether the user wants ultrareview on it. If so, plan the pieces
under the limits up front, each committed with a branch to review it
against, since one working tree mixing everything cannot be split by
file afterwards without breaking the commits in between.
