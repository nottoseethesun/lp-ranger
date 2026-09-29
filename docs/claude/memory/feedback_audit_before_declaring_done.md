---
name: feedback_audit_before_declaring_done
description: "Before saying work is done, re-read the written rules and audit the change against them — and separately audit it for state and for sequence. Both passes find real bugs in work already called finished; the user should not have to ask for them."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-28T23:59:23.018Z
---

Two passes belong at the end of any non-trivial change, and neither is
optional because the tests pass. Run them before saying the work is
done.

**Pass one — against the written rules.** Re-read the relevant memory
files and `docs/claude/CLAUDE-BEST-PRACTICES.md`, then walk the diff
against them. Not from recall: open them.

**Pass two — state and sequence.** For each piece of state the change
reads or writes: who else touches it, and what happens if a step
in between fails? For each `await`: what can interleave there, and is
the mutation it guards atomic?

**Why:** on 2026-09-28 I called an RPC-failover fix finished, with a
green check and ten passing tests. The user asked for each pass in turn.
Together they found five real defects in work already declared done:

1. A guard written `failedProvider !== undefined` let `null` through as
   a real provider, which can never match the selected one — so every
   call returned false and **that caller's failover was dead for the
   life of the process, silently.** The first rule I re-read names this
   exact idiom ([[feedback_explicit_null_undefined_checks]]).
2. A dated incident recounted in JSDoc — the thing
   [[feedback_jsdoc_style]] forbids, which I had fixed elsewhere in the
   same session and then repeated.
3. `CLAUDE.md` asserting the return value meant something it no longer
   meant, and `docs/security.md` describing the old signature.
4. A diagnostic leaking `Cannot read properties of undefined` into a
   table whose whole job is telling an operator what is wrong — state
   one step sets and two later ones read, with no guard for the step
   having failed.
5. A pre-existing flaky test racing a shared cache file, which would
   have reddened CI on the push and looked like mine.

**How to apply:**

- Treat "the check is green" as necessary, not sufficient. Every one of
  those five passed the full gate.
- Grep the docs for claims the change falsifies. A return value whose
  meaning widens, a signature that gains a parameter, a count in a
  sentence — all of these are documented somewhere, and a doc that lies
  is worse than one that is missing ([[feedback_verify_symbols_a_comment_names]]).
- Run the failing case rather than reasoning about it. The null hole and
  the leaked internal were both confirmed in one command each.
- Prove a concurrency claim with concurrency. The test that matters ran
  eight reads through the real code path, interleaving at a real
  `await` — not a hand-driven sequence of calls.
- A pre-existing defect that your push would surface is yours to fix or
  to name, not to leave for CI to blame on you
  ([[feedback_no_flaky_push]]).

Related: [[feedback_verify_before_claiming]], [[feedback_finish_logic]],
[[feedback_no_extra_state]].
