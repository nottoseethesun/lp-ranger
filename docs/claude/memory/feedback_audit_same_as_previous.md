---
name: feedback_audit_same_as_previous
description: "How to run 'an audit, the same as the previous one' after a fix round: three read-only auditors in parallel, verify each finding, record it, report open bugs first, then wait"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-28T07:15:01.956Z
---

When the user asks for "an audit, done the same as the previous one",
usually once a fix round's changes are done and the checks pass:

1. Only after the round passes `npm run check` on Node 24 and Node 26.
2. Three read-only auditors in parallel (the Agent tool, background):
   the server and bot code (src/ outside src/client/web, scripts/,
   shipped settings); the tests and the web client; the docs and every
   text an operator reads. Each audits the round's changes and the code
   two steps out (callers and callees). Brief each fully: the round's
   changes by file, the rules (no finding without a failure, a bad
   operator is not a bug, nice-to-haves are not bugs), and strictly
   read-only: no edits, no git state changes, no server, no npm scripts
   or tests (a test run wipes the operator's settings and would collide).
3. Verify every finding against the code yourself before reporting it;
   drop what does not hold.
4. Record the verified findings in PROJECT-STATE.md at once, as the
   n-th audit's entry: bugs `[An-k]` with severity and fix, test gaps
   `[Ck]`, texts `[Dk]`, marked OPEN.
5. Report with open bugs first, in operator terms (setting, what goes
   wrong, fix), then test gaps, then texts; then wait for the user's
   word on each.

**Why:** the user has asked for exactly this after every fix round
since the twenty-fifth (2026-11-27: *"when all changes are done and all
checks pass, then next, do an audit, done the same as the previous
one"*; 2026-11-28: *"run another audit, just the same as the previous
one"*). Running the tests while auditors read the repo moved the
operator's settings under them, so tests wait until the auditors finish.

**How to apply:** follow the steps above; a round's fixes come only from
the user's rulings on the reported findings. Related:
[[feedback_no_finding_without_a_failure]],
[[feedback_bad_operator_not_a_bug]], [[feedback_lead_with_open_bugs]],
[[feedback_wait_for_signoff]].
