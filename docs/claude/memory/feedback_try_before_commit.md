---
name: Always let user try UI/behavior changes before committing
description: For any change the user can observe in the browser or running app, wait for their sign-off before committing
type: feedback
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
---
After implementing any user-observable change (UI, dashboard behavior, styling, new forms, etc.), stop and let the user try it out first. Do not commit until they explicitly confirm it looks/works right.

**Why:** User wants to verify visual and interaction details themselves before the change lands in git history. Committing prematurely means a revert or fixup commit when something isn't quite right.

**How to apply:** After `npm run build` + `npm run check` pass on a user-facing change, report what's ready to test and wait. Only commit after explicit approval like "commit 'em", "ship it", "looks good, commit", etc. Non-visible changes (pure refactors, test-only edits, server-side logic with no UI surface) can still follow the usual commit-on-ready pattern if asked.

**Scope of authorization:** "Commit and push and merge **this branch**" applies only to the named branch. If the same message also says "then make a branch X where you will do Y", that does NOT extend commit/push/merge authorization to branch X — only the implementation is authorized. Stop after implementing + check, report, wait. Behavior-altering changes default to try-before-commit even within a multi-step instruction.

**Plan Mode does NOT authorize commits.** `ExitPlanMode` approval — even with `allowedPrompts` that mention commit/push/merge — only signals that the plan is acceptable. It is NOT permission to commit. After the plan is approved and code is implemented, stop at the "ready for you to try it" stage and wait for an explicit "commit it" / "ship it" / "looks good, commit" before running `git commit`. Same goes for follow-up fixes: a double-check pass that finds a bug should produce uncommitted changes, NOT a fixup commit.

**Double-check / audit passes never auto-commit.** When the user says "go back and double-check your work", treat any new finding (regression, bug, missing piece) as an uncommitted edit. Show what changed, run `npm run check`, then stop. The user wants to try the fix before it goes into history.

**STRONGEST FORM — PUSH IS GATED ON MANUAL VERIFICATION (added after a repeat violation 2026-06-19).** Even when the user has explicitly said "fix it" / "go ahead on auto" / "make a branch and ship it" earlier in the conversation, for any user-observable change you MUST stop after `npm run build` + `npm run check` pass and wait for the user to manually verify in the browser / running app BEFORE you `git push` or open a PR.  Commit locally is fine; `gh pr create` + `gh pr merge` are NOT.  The remote is shared state and a wrong push triggers CI runs, notifications, and burn-in cycles on Prod — undoing it is expensive.  The user's "go ahead and ship" applies to *implementing*, not to bypassing the test-in-browser stage.  Phrasings that explicitly authorize push include "push it" / "commit, push, and merge" / "ship the PR" — not "fix it" or "do it on auto".  When in doubt: build, check, commit locally, then say "ready for you to try it in the browser" and stop.

**EVEN STRONGER — PUSH IS ALSO GATED (added after a THIRD violation 2026-07-17, same conversation as the second violation).** The check → commit → push cadence is muscle-memory; the "commit locally is fine" clause above has repeatedly led me to auto-push right after committing. Break the muscle memory:
- After `npm run check` passes on a user-observable edit, **stop before `git commit`** — not before `git push`. Report "build+check green, ready for you to try it" and wait.
- The commit sequence (`git add` → `git commit` → `git push`) is one action mentally; do not run any of it until the user explicitly says commit / ship / push.
- If you catch yourself about to `git add`, pause and re-read the last user message. If it doesn't say something like "commit"/"ship"/"push", stop.
- The correct handoff phrase is literally: "Build + check green. Ready to try in the browser — say the word when you've verified it." Nothing after that until the user replies.
- Precedent 2026-07-17: PR #156, twice in a single session — the CSS fix for right-alignment and the token-symbol ellipsize both got pushed before the user could open the modal. User's reaction: "Why are you pushing before I can try it".

**Audit rounds are not exempt (2026-11-25).** The audit loop's "fix, prove, gate, commit locally" cadence led me to commit browser-visible fixes the user had not tried: in 838e230 a tab the browser reloads following the server's wallet and the re-open dialog's words, and in ae62f1b the "Managed Without a Re-open" notice and Back/Forward naming the wallet. What worked once caught: **split the round by what the user can see.** Commit the invisible part (server logic, docs, comments, terminal text), gated and listed by file; leave the visible part (dashboard wording and behaviour, the User Manual, a script's new `--help` behaviour, Telegram text) uncommitted, with a list of what to try and where. The user then said "Just go ahead and run c.i. with permission to merge to `main`; I will try the app out here on dev overnight", which authorized committing the rest untried.
