---
name: feedback_branching
description: "Where work goes: NOTHING is pushed directly to main — push-to-main is blocked universally, so every change goes via a branch + PR. ONE branch at a time; stack follow-ups on the open branch."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fbb9ad2b-bfb6-4113-a2f4-fcb15a7900da
  modified: 2026-10-01T05:41:29.778Z
---

# Branching — where work goes

## SUPERSEDING RULE: no direct push to main (2026-08-08)

**Push-to-main is blocked universally.** Every change — code, config,
docs, marcom, memory, a one-line typo — goes through a branch and a PR,
per the eight steps in `docs/claude/CLAUDE-CI.md`. There is no longer an
admin-bypass path.

This OVERRIDES the "default to main", "config changes main" and "marcom
on main" sections below, which describe how the project worked earlier.
They are kept for history; where they say "commit directly to main and
push", read "branch, PR, merge". Committing locally on main is still
fine — it just cannot be pushed from there, so the commit has to be moved
onto a branch before it can go anywhere.

**Why:** user, 2026-08-08, declining a push of a docs-only memory commit:
"we have direct push-to-main blocked universally."

### Check the branch out before the first edit (2026-10-01)

The paragraph above says committing locally on main is fine so long as the
commit moves to a branch before it is pushed. **Narrow that: do not edit
files with `main` checked out at all.** User, 2026-10-01: *"You should be
doing this work on a branch."*

**Why:** that session had already gone wrong once at the same seam. After
an interrupted step-3 merge check, local `main` was sitting at the branch
commit, and the next thing I did was edit a memory file — with `main`
checked out. The edit reached the branch only because it was still
uncommitted when I switched; one `git commit` in between and it would have
been a commit on `main` that then had to be moved. "Allowed if you move it
later" is a rule that depends on remembering to move it.

**How to apply:** the branch is the first step of the work, before the
first `Edit`, not something arranged once the change is written. If an edit
has already been made on `main`, switch branches before committing —
uncommitted changes carry across — and say so rather than letting it look
deliberate.


## one branch at a time

**Keep changes on a single branch unless the user says otherwise. Never create a second branch off main while one is already open.**

**Why:** user, 2026-08-08. Work for PR #186 was started on top of `memory-burn-in-lessons`, which had open PR #185. Cutting a new branch from that HEAD carried #185's commit along, so the new PR would merge someone else's open PR as a side effect — and I spent a round trip presenting base-branch options instead of just working. The user: *"why in the world would you have made things so complicated in the first place: Just keep changes on a single branch unless I tell you differently. Don't try to make more than one branch from main at a time unless I tell you."*

**How to apply:**

- Before creating any branch, check for an open one (`gh pr list`, `git branch`). If work is already in flight, put the new work there.
- A branch name supplied by the user is a name, not an instruction to fork a second line of work off main. Rename or keep using the current branch as appropriate.
- Do not present "which base should this branch from?" as a question. There is one branch; use it.
- Multiple concurrent branches happen only when the user explicitly asks for them.

Merged from: feedback_default_to_main, feedback_config_changes_main, feedback_stack_related_work_on_current_branch, feedback_marcom_on_main — those slugs no longer exist as
separate files; search this one.

## default to main

Default workflow: commit changes directly to main after `npm run check` passes. Only create a feature branch when the change is large, risky, or clearly benefits from being isolated in a PR for review.

**Why:** User stated "For now, we can make changes on main and if it comes to pass that we see a need for a branch, then we'll do that." Broader than the config-only guidance — applies to general work during this phase (incl. debugging, small features, refactors).

**How to apply:** When a task wraps up, don't reflexively propose a branch. Default to `git commit` on main + push. Raise the branch option only when the change is clearly substantial (e.g. multi-file feature, risky refactor, ongoing WIP the user might want to revert). Still follow the full CI protocol (run check pre- and post-commit, etc.) — the only thing that changes is the branching default.

**Confirm before committing non-trivial behavior changes to main.** The signal isn't file count — it's whether the diff introduces real new behavior on a critical path (e.g. nonce/TX recovery, rebalance pipeline, fund-handling logic, new state machines). Cosmetic sweeps (log color tweaks, prefix renames, JSDoc) can still go straight to main even when they touch many files. Branch-worthy = something that changes how the bot behaves under failure or on-chain.

The user noted on 2026-04-28 (after a commit that bundled logger cleanup with nonce-too-low recovery): "Oh, whoops, I had meant to do this on a branch... Because recovering from nonce-too-low is a non-trivial change." Ask "branch or main?" before committing whenever a non-trivial behavior change is in the staged set — even if it's mixed in with cosmetic work.

## config changes main

Simple config value changes (bumping a multiplier, changing a default) can go directly on main after running `npm run check`. Don't create a branch and PR for a one-line config tweak — that's overhead for no benefit. Reserve branches for code changes that need review.

**Why:** User pointed out that bumping `gasPriceMultiplier` from 4.5 to 7 in chains.json didn't need a branch/PR workflow.

**How to apply:** If the change is a single config value with no code logic changes, ask whether to commit directly to main or create a branch. Default to main for trivial changes.

## stack related work on current branch

If a bugfix or polish item is closely related to work already in flight on an open branch (typo, missed edge case, cosmetic follow-up, quick UX tweak the user requested during test), **stack it on that same branch** — don't spin up a new feature branch and a new PR.

**Why:** The user explicitly called out (2026-07-17 during PR #156 testing) that spawning a separate branch for a cosmetic fix "avoids the CI overhead" — every branch triggers 6 CI jobs (ESLint, tests × 2 Node versions, security lint, deps audit, secret scan) which is real time and noise. Piggy-backing on an existing branch amortizes the CI cost across related work.

**How to apply:**
- Before creating a new branch, ask: is this change related to an already-open branch, likely to land in that same PR anyway?
  - **Yes** (cosmetic follow-up, bug the user found while testing that feature, polish on a component just added) → commit on the current branch.
  - **No** (unrelated area of the codebase, different feature, will not naturally merge with the open work) → new branch is warranted.
- The `feedback_default_to_main` rule still applies for stand-alone config-only edits (those go to main). This rule is about the middle case: "this belongs *somewhere else* but that somewhere else is the current branch."
- If you've already spawned the wrong branch, the recovery is: cherry-pick onto the intended branch, delete the throwaway (that's the one explicit case where deleting a branch is fine even under `feedback_never_delete_branches` — the branch never existed on the user's radar, has no PR, and only exists because you mis-scoped).

Related:
- [[feedback-default-to-main]] — simple config tweaks go directly to main.
- [[feedback-config-changes-main]] — same, for value-only changes.
- [[feedback-never-delete-branches]] — general rule; a self-inflicted throwaway is the narrow exception.

## marcom on main

The user confirmed marcom (Marketing and Communications) changes "can usually
just be done on main." Observed across this session: README banner, tagline
Markdown conversion, project rename, LICENSE copyright, and social-preview
image all went as direct commits to `main`, each followed by watching
`CI on main` + `Security Audit` (and sometimes `Deploy GitHub Pages`) to green.
Direct pushes bypass branch protection's 5 required checks via the user's admin
bypass.

**Why:** marcom/docs/chore changes are low-risk and don't need PR isolation.

**How to apply:**
- Marcom, docs, and chore changes → commit directly to `main`, push, watch CI.
- Substantive feature/code changes still go via feature branch + PR (the full
  8-step protocol in docs/claude/CLAUDE-CI.md).
- Pushing can trigger `Deploy GitHub Pages` — flag that live-deploy side effect.
- Related: [[feedback_default_to_main]], [[feedback_config_changes_main]].

## Never reuse a branch name

Each attempt gets a fresh name, even after the previous one is abandoned
and deleted locally.

**Why:** User, 2026-08-05, after a discarded attempt was restarted from
scratch: "And do not re-use the old branch names." The old branch usually
still exists on the remote (see below), so a reused name collides with
history that has different content — and a PR under a familiar name
invites the assumption that it is the same work.

**How to apply:** check `git branch -a` before naming. When work is
thrown away and restarted, name the new branch for the NEW approach
(`decimals-gate-on-synced`), not the old one (`decimals-fields-await-sync`).

**Abandoned branches:** the user's preference on 2026-08-05 was to delete
the dead branch locally and leave it on the remote, so the work stays
recoverable without cluttering local tab-completion.

