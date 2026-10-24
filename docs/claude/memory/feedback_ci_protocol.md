---
name: Always follow full CI protocol
description: Never skip the local merge-to-main check before pushing a branch
type: feedback
originSessionId: 6410b15f-f74f-4f19-a2ae-51cdd70744eb
modified: 2026-10-22T01:24:07.962Z
---
Always follow ALL 8 steps of the CI protocol in `docs/claude/CLAUDE-CI.md` before pushing. Most critically: after checks pass on the feature branch, merge to main LOCALLY and run `npm run check` again to catch integration issues, then `git reset --hard origin/main` to undo the local merge before pushing the branch.

**Why:** The user has explicitly called this out. Skipping the local merge-to-main verification risks pushing broken code to the remote, which is a shared resource.

**How to apply:** Every single time before `git push`, do the local merge check. No exceptions. Verified path on 2026-05-04 (PR #123): branch → check → checkout main → merge feature branch → check → reset --hard origin/main → push branch → PR → watch checks → `gh pr merge --merge` → pull main → `gh run list -b main -L 2` to confirm post-merge CI green.

## Also (merged from feedback_ci_workflow)

ALWAYS read docs/CLAUDE-CI.md before starting ANY merge workflow. Every single time. Do not work from memory — open and read the file first.

**Why:** User corrected me for jumping straight to merging on main instead of following the documented protocol (push branch first, wait for CI green, then PR).

**How to apply:** Before any merge workflow, read docs/CLAUDE-CI.md and follow steps 1-7 in order. Key points: local check on branch (step 2), local merge-to-main check (step 3), undo local merge (step 4), push branch (step 5), wait for CI green, then PR (step 6).

## "Full c.i."

The user's "Do full c.i. to `main`" (2026-10-21) is the whole protocol: all eight steps of docs/claude/CLAUDE-CI.md, step 3's local merge check and step 6's PR merge included, each check on Node 24 and Node 22. Run that way for PR #232: branch check, commit, local merge check, push, PR checks watched, `gh pr merge --merge` with the branch kept, `main` pulled, and `main`'s CI, Security Audit and Pages runs watched to green. Step 4 used `git reset --keep origin/main` ([[reset-keep-not-hard]]).
