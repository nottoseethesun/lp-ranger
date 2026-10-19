---
name: feedback-take-up-minor-cleanups
description: "When you notice minor cleanup opportunities during review (dead variables, redundant parameters, stale comments, leftover state from refactor in progress), fix them yourself — don't ask."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-19T16:48:47.368Z
---

When auditing your own work or surrounding code and you notice a minor cleanup opportunity — dead variables, redundant function parameters, stale comments referencing the old design, leftover state from a refactor-in-progress, unused imports — **take it up yourself**. Don't surface it as a question or summary item for the user to approve.

**Why:** Asking interrupts the user's flow and forces them to context-switch to evaluate something they already trust your judgment on. The cost of asking is higher than the cost of a small contained fix. If a cleanup is genuinely risky (changes behavior, crosses module boundaries, affects public API), that's different — ask. But "this variable can be eliminated" or "this parameter is now redundant" is in your bailiwick.

**How to apply:** While reviewing diff for an audit (or after fixing one bug, before reporting), do one final pass: is anything left over that the user would also clean up if they were reviewing? If yes and it's low-risk, just apply it. Then report what you found + fixed in the summary, rather than reporting "I noticed X, want me to fix it?"

**Concrete instance (2026-06-18):** During a `closed-position-reopen-via-manage` audit, I fixed the LP-Browser's `mgd`/`managed` confusion by replacing call sites but left a redundant `mgd` local variable and a redundant `_fillIdxCell` parameter. User had to follow up with "Were you able to clear out all use of `mgd`?" to prompt the full cleanup. I should have done it in the first pass.

**Counter-example (don't apply):** Module-boundary changes, deletion of public exports, renames that touch many files, anything where the user might have a reason for the current shape that I can't see. Those go through the user.

Cross-links: [[feedback_audit_program_state]] (post-feature program-state audit), [[feedback_basic_fix_first]] (favor simple fixes), [[feedback_finish_logic]] (trace paths to completion before reporting done).

**Suspended for audits from 2026-10-19:** the user asked that reviews avoid minor issues and leave them for a later release; see [[feedback_no_finding_without_a_failure]] § "Minor issues wait for a later release".
