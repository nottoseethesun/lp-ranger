---
name: feedback_git_workflow
description: Git workflow rules: never push/merge/rebase/squash/delete-branches/cut-releases without explicit instruction
metadata:
  type: feedback
---

# Git workflow — things never done without an explicit instruction

Merged from: feedback_no_auto_push, feedback_no_auto_merge, feedback_never_delete_branches, feedback_never_rebase, feedback_no_squash_merge, feedback_never_cut_release — those slugs no longer exist as
separate files; search this one.

## no auto push

Never run `git push` for code or config changes unless the user has explicitly told me to push in the current turn or ongoing task. Committing locally is fine; pushing code without authorization is not.

**Exception:** Pure documentation commits (READMEs, FAQs, comments, nice-to-have docs in `docs/roadmap/`) can be pushed without re-asking. Per 2026-05-16 feedback: "docs don't hurt". Don't gate the user behind explicit push authorization for harmless doc-only changes.

**Why:** User wants control over when functional changes leave their machine. Auto-pushing after every small code tweak floods the branch history and reaches CI/remote before they're ready. But forcing them to authorize every doc push is busywork — docs have no runtime impact, no CI failure risk, no rollback cost.

**How to apply:** After `git commit` of a code or config change, stop. Do not chain `&& git push`. If an earlier instruction said "commit and push," that authorization covers only that one functional commit. For doc-only commits (no `.js`/`.json`/`.css`/`.html` runtime files touched, only `.md` / nice-to-have / README / comment changes), push without re-asking.

## no auto merge

Never run `gh pr merge` (or commit + push + open PR + merge as a bundled flow) unless the user has said the word "merge" for the current change.

**Why:** User needs a chance to test user-observable changes between the last code edit and the merge. Bundled changes that include unverified pieces (e.g. a bug fix that was written but never tested by the user) must not land on main just because the last piece was signed off. "yes, good" on one aspect is NOT authorization to merge the whole branch.

**How to apply:** After CI passes and the PR is open, STOP. Tell the user the PR is ready and wait for them to explicitly say "merge". Sign-off on one specific change (layout, copy, etc.) does not extend to other changes bundled in the same branch. When in doubt, name each change and confirm before merging.

**Per-branch scope:** "merge" applies only to the named branch in that instruction. A multi-step message like "merge branch A, then make branch B and do X" authorizes merge ONLY for A — branch B requires its own explicit "merge" once it's ready. Never carry merge authorization forward across branches.

## never delete branches

**Always leave the branches.** Never delete one after merging, and do not offer to. Do NOT pass `--delete-branch` to `gh pr merge`, and do NOT run `git branch -d`/`-D` or `git push origin --delete <branch>`.

**Why:** User keeps merged branches around for history, bisecting, and reference. Auto-deleting destroys that audit trail. I deleted `fix-full-range-recovery-modal` after merging PR #71 without authorization and had to restore it via `git push origin <commit>:refs/heads/<branch>`.

**How to apply:**
- `gh pr merge <n> --merge` with NO `--delete-branch` flag
- Leave both local and remote branches intact after merge
- Only delete a branch if the user says so in the imperative ("delete the branch")
- Do not raise branch deletion as a loose end, a question, or an option. Stated as a standing rule on 2026-09-15: "Always leave the branches." Merged branches simply stay.

## never rebase

Never use `git rebase` in any form on this project. Always integrate with `git merge`.

**Why:** User preference: rebasing rewrites history and loses the audit trail of how a branch evolved. Merge commits preserve the full development sequence and make `git log --graph` legible. Consistent with [[feedback-no-squash-merge]] (also history-preserving).

**How to apply:**
- Use `git merge <branch>` to bring changes from one branch into another.
- Use `git pull` (default merge, not `--rebase`) when updating local branches.
- Use `gh pr merge --merge` for PRs (already the rule per [[feedback-no-squash-merge]] and the project's CI protocol). Never `--rebase` or `--squash`.
- To bring a stale feature branch up to date with main: `git checkout <branch> && git merge main` (creates a merge commit). Never `git rebase main`.
- Never propose interactive rebase, `--autosquash`, fixup, etc.

## no squash merge

Never use `--squash` when merging PRs. Use `gh pr merge --merge` — with NO `--delete-branch`, per "never delete branches" above. (This line previously read `--merge --delete-branch`, contradicting that rule.)

**Why:** User wants the full commit history preserved on main, not compressed into a single commit.

**How to apply:** Always use `--merge` flag with `gh pr merge`.

## never cut release

Never create, publish, re-publish, or delete a GitHub release. The user
cuts every release personally — Claude's role is at most to prep (run
`npm run check`, summarize commits, draft notes for review) and stop.

**Why:**
- First incident (2026-04 or earlier): user said "use `gh` to do, 'Actions
  → Create Release → Run workflow'" intending Claude set up the workflow
  infrastructure. Claude misread it as authorization and published 0.4.6.
  Rebuke: "Yo, I didn't ask you to actually cut the release!"
- Second incident (2026-05-16): user said "I'm ready to cut a Release for
  more Production burn-in time." Claude prepped a proposal and asked
  "Cut release 0.7.7?". User answered: **"No, I do that only."** — i.e.
  "I'm ready" means the user is ready to do it themselves, NOT a request
  for Claude to do it.

**How to apply:**
- Phrases like "I'm ready to cut a release", "let's release", "time to
  ship" → the user is the one shipping. Offer to prep + draft notes, but
  do NOT propose to run `gh release create` and do NOT include it as the
  "Yes, ship it" option in any AskUserQuestion. The only valid options
  are "draft notes for you", "run check / summarize commits", or "hold".
- Same rule applies to `gh release edit`, `gh release delete`, and any
  REST-API equivalent. Public release surface is user-only.
- Infrastructure work on `.github/workflows/release.yml` etc. is fine —
  that's plumbing, not publishing. The trigger to avoid is the actual
  `gh release create` / publish call.
- If the user explicitly says "you cut it" or "go ahead and publish",
  that overrides — but require that level of unambiguity, and confirm
  the version + tag + title back to the user before invoking `gh`.
