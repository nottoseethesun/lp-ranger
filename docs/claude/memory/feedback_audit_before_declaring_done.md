---
name: feedback_audit_before_declaring_done
description: "Before saying work is done, re-read the written rules and audit the change against them — and separately audit it for state and for sequence. Both passes find real bugs in work already called finished; the user should not have to ask for them."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-01T05:32:43.638Z
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

## The audit comes before any merge step, including the local one (2026-10-01)

Both passes run **before** step 3 of the eight-step protocol, not after.
Leave local `main` sitting at `origin/main` until the branch has been
audited.

**Why:** on 2026-10-01 I finished a transaction-logic fix, ran the gate,
then did the step-3 `git checkout main && git merge <branch>` check, and
only then would have audited. The user stopped the next command: *"I
wanted you to do more checks before you merged to main — wtf?"* Nothing
had reached the remote and step 4 would have reset it, but that is not
the point. From the outside, `git checkout main && git merge` **is**
merging to main; a protocol step that is only safe because of the step
that follows it looks identical to the unsafe thing until that step runs.

**How to apply:** finish the audit, fix what it finds, re-run the gate,
and only then touch `main` at all. If an audit is requested after the
local merge has happened, say plainly what is on the remote versus local
before anything else — the distinction is invisible to someone reading
the commands.

The interrupted call also left `wipe-settings` outstanding. Restoring it
first was right — and worth being accurate about why: the server was
**down**, so nothing could write into the emptied directory and no data
was at risk. `wipe-settings` moves files rather than deleting them, and
an outstanding wipe is only dangerous while a server is running, which is
the condition [[feedback_test_commands]] actually names. Restore it
because leaving state displaced compounds if the next call is interrupted
too, not because something is burning.

Related: [[feedback_verify_before_claiming]], [[feedback_finish_logic]],
[[feedback_no_extra_state]], [[feedback_ci_protocol]].
