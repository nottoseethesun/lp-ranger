---
name: feedback_verify_before_claiming
description: "Run the falsifying check before any claim; follow a value to the screen and a condition to every writer; audit against the rules and for state and sequence before the gate; grep every symbol a comment names; prove a verification revert applied; check what is running before rediagnosing"
metadata:
  type: feedback
---

# Checking work before claiming it

Merged from: feedback_trace_the_claim_not_just_the_code, feedback_audit_before_declaring_done, feedback_verify_symbols_a_comment_names, feedback_prove_the_revert_applied, feedback_verify_runtime_before_rediagnosing — those slugs no longer exist
separately; search this one.

## verify before claiming

Do not assert what the code or the running app did until the specific
check that could prove it wrong has been run. When the evidence on hand
is partial — a truncated log paste, a grep over a subset of the tree, a
sampled output — say "I can't tell from this" and name the check that
would settle it. Absence from a sample is not absence in fact.

**Why:** every wrong claim costs the user a round trip to correct, and
that is their time and energy, not the assistant's. In one session four
claims were stated confidently and each was wrong: "nothing server-side
reads this setting" (the grep excluded the repo root, where `server.js`
read it); "a second request started" (built on a line missing from a
partial paste, which the user then had to explain was truncated); "the
done log fires before the work finishes" (never checked where the
returned value was assigned — it was settled before the log); and
"the two phases issue duplicate queries" (conflated the RPC call with
the question being asked). Being fast and wrong is slower than being
slow and right, because the user pays the difference.

**An explanation read backwards off the observation cannot be wrong, and
that is what makes it worthless.** On 2026-09-30 a failover took eleven
seconds and the account given was: the rule needs failures to outnumber
recent successes, so there must have been about twenty-seven successes
banked. The successes were never counted. They were inferred FROM the
twenty-eight failures — which means the same account fits any number at
all, and it was duly reused when the number turned out to be 678. The
user said something felt fishy about it and was right: 678 requests in
one second is impossible against a 222 ms pacer, a contradiction sitting
in arithmetic already to hand. The real cause was a cached rejected
promise, and one measurement found it.

Two habits come out of that, both cheap:

- **State what the explanation implies, then check the implication.**
  "Twenty-eight failures crossed, so roughly twenty-seven successes were
  in the window" is a countable claim about a log that was already open.
- **Test the explanation against the system's known constants before
  offering it.** A pacing interval, a poll period, a chunk size: if the
  story needs one of them violated, the story is wrong.

When neither is available, the honest answer is the observation without
the mechanism — "it crossed after twenty-eight failures; I have not
verified why the denominator was what it was" — and never a mechanism
delivered in the voice of a finding.

**A grep proves the presence of a pattern, never the absence of a
behavior.** On 2026-09-28 the question was which ethers reads carry an
extra `eth_chainId`. A grep for `#checkNetwork(` found two call sites,
so the answer given was "`call()` and account reads only — not
`getLogs`." Wrong: most methods call `getNetwork()` directly rather than
through that wrapper, `getLogs` among them. A stub node counting real
requests had the answer in one run — `getLogs` cost two HTTP posts per
read, exactly like `call`. The pattern searched for was real; it just
was not the only way to reach the behavior. When the question is "what
does it actually do at runtime", measure it; a grep only narrows where
to look.

**An audit plan presents verified items only (2026-10-19).** I put
"`npm run clean -- --help` runs the full reset" to the user marked "not
yet verified". The user: "Why wouldn't you verify that before presenting
it? It small code and should be easy to verify." Reading the script took
one minute and showed it was worse than reported. Verify each item
before it reaches the user; an item that truly cannot be checked cheaply
says why, in one line.

**How to apply:** before writing a conclusion, name the one check that
would falsify it and run that first — the whole-repo grep, the line
where the variable is assigned, the actual Node semantics rather than
the comment claiming them. Prefer "here is what I verified, here is what
I did not" over a clean narrative that outruns the evidence. When
corrected, fix the claim and move on rather than defending the framing.
Related: [[feedback_no_finding_without_a_failure]],
[[feedback_instrument_before_inferring]], [[feedback_full_repo_grep]],
[[feedback_signal_substitution]].

## trace the claim, not just the code

A fix has two artefacts: the code, and what gets written about it. The
second outlives the first and is trusted without re-checking, so a claim
stated more broadly than the code supports is worse than a bug — nobody
goes back to verify it.

**Why:** three of four audit passes on 2026-10-03/04 found exactly that,
each time in a commit message *and* a memory file:

1. "A zeroed baseline makes IL/G report the whole position as a gain." It
   does not. The caller guards zero amounts and the figure comes back
   absent, so the dashboard shows dashes. Reached by reading one
   function's guard and stopping before its caller.
2. "Leaving the gas figure unset makes the dashboard fall back to the
   running epoch's gas." One of its two gas displays does that. The other
   coerces an absent figure to zero and renders $0.
3. "The scan now carries *the operator asked for a repair*." It carried
   "recompute or re-value", and a rebalance asks for a recompute — so the
   re-read fired after every rebalance, spending quota on a price that
   cannot change.

Each was a claim about a *consequence*, and each was wrong in the same
way: the mechanism was traced one step and the step after it decided the
outcome.

**How to apply:**

1. **For a value, follow it to the screen.** Not to its first consumer —
   to what the operator sees. A guard, a coercion or a fallback two
   layers on is what decides whether the harm you are describing exists.
2. **For a condition, find every writer.** "This fires when X asks" is a
   claim about every caller that raises the flag, not about the one you
   had in mind. Grep for the assignment, not the read.
3. **Write the consequence last.** If the sentence names a figure, a
   panel or a cost, it is a claim that needs the trace above before it is
   committed — and a commit message cannot be corrected later.
4. **A corrected claim is worth a line saying it was corrected.** The
   next reader has no way to know which sentences were checked.

Related: [[feedback_verify_before_claiming]],
[[feedback_ask_what_withholding_costs]],
[[feedback_explain_behavior_not_call_sites]].

## audit before declaring done

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

## The audit runs before the gate, and the report names what it checked (2026-10-24)

**Why:** on 2026-10-24 I finished Bug #11 (a compound's fees worked out
from the chain), passed the Node 24 gate, started the Node 22 one, and
was about to report it done. The user stopped it: *"double-check that
this is a clean, correct fix."* Pass two found a real bug with a few
searches. #11 wrote fee fields onto compound-list entries that had never
had them, and that list holds every addition after the mint, another
wallet's included. Two readers of those fields (Initial Deposit for This
LP, and the split of a waiting deposit between positions) then counted
another wallet's addition as the wallet's own coins, the first of them
twice. Every test passed: they checked what I designed, and the bug was
in code that reads what I wrote. Then the user: *"I shouldn't always have
to tell you to go back and check your work, but somehow, I still have to
do that."*

This file already said the user should not have to ask. Knowing the rule
was not the problem: a green gate felt like the end, so the audit never
ran.

**How to apply:**

- **Order:** code and tests, then both passes, then fixes for what they
  find, then the gate, once. The gate is the last step, not the sign the
  work is done, and the user does not want it run twice for nothing
  ([[feedback_check_before_push]]).
- **Pass two for a change that writes data:** grep every reader of each
  field or function whose values change, old records that newly gain a
  field included, and say what each reader now does with them. Ask too
  which records the list holds: here "every addition after the mint",
  not "every compound".
- **The report of a finished fix carries a short "Checked" list:** the
  readers swept, the docs grepped, the state and sequence questions
  answered. A skipped audit then shows in the report, instead of being
  found by the user.

Related: [[feedback_verify_before_claiming]], [[feedback_finish_logic]],
[[feedback_no_extra_state]], [[feedback_ci_protocol]].

## verify every symbol a comment names

**A comment that names a symbol — a function, module, flag or config key — is a claim, and it must be checked like one.** Before leaving any comment you edited, grep every name in it. If the symbol does not exist, or does not do what the sentence says, fix the sentence.

**Why:** these are the only defects that no gate catches. Lint, tests, coverage, and the type of review that reads a diff all pass a comment describing behaviour the code has never had. A reader then trusts it, greps for a function that is not there, and loses the time the comment was supposed to save.

**How often it actually happens:** four times on one branch (2026-09-21), all of them found by audit rather than by any gate:

- `docs/engineering.md` pointed at `timerSecProblem()`, which existed nowhere — the function is `_timerKeyProblem`.
- `rebalancer-execute.js` said the resolver "returns the legacy single slippagePct" as a fallback. It returns the shipped default; that fallback did not exist.
- Three places — a code comment, CLAUDE.md, and the operator docs — said a retired config key is dropped "on load". It is dropped on **save**.
- `bot-config-keys.js` credited `bot-pnl-updater._currentNftGasUsd` for populating a cache. That symbol's only occurrence in the entire repo was the comment naming it.

The fourth is the instructive one: it was found immediately after *editing that exact line* to change one word, without checking the symbol sitting beside it. Touching a comment is precisely when its claims are cheapest to verify and most likely to be stale.

## Re-pointing a sentence at a different file makes every number in it a new claim (2026-09-30)

Correcting "`_waitOrSpeedUp()` in `src/bot/rebalancer.js`" to
`src/bot/tx-speedup.js` across three docs looked like relocating a pointer.
It is not. **The rest of the sentence was written about a different
implementation, and each of its claims has to be re-checked against the
new one.** Two were wrong once re-pointed:

- "bump by 1.5×" — hard-coded in the copy being left behind; in
  `tx-speedup.js:185` it is `config.CHAIN?.speedUpGasBump ?? 1.5`, a
  per-chain setting. Both shipped chains happen to say 1.5, so this one
  survived on luck, not on checking.
- "stuck nonces **always** free themselves" / "never permanently
  blocked" — both cancel paths are best-effort and say so in their own
  logs (`tx-speedup.js` logs "nonce %d may still be stuck"; the
  aggregator's cancel races `wait()` against a timer and cannot tell an
  unconfirmed cancel from a landed one). Worse, having found a *second*
  route I asserted the same guarantee of both — turning one file's
  overstatement into a claim about two.

**How to apply:** when a doc edit changes which file a sentence is about,
treat the whole sentence as newly written. Grep every constant in it
against the new file, and check every "always", "never" and "ensures"
against the error branch. A guarantee is only as strong as the path that
fails: if the code logs "may still be stuck", the doc may not say
"always freed".

And **never widen a claim because you found another thing it seems to
cover.** Extending an existing absolute to a second path is not
housekeeping — it is a new, stronger assertion, and it needs more
evidence than the sentence you copied it from.

Related: [[feedback_verify_before_claiming]], [[feedback_trace_semantic_coherence]],
[[feedback_no_finding_without_a_failure]].

## prove the revert applied

The habit of confirming a regression test by reverting the fix and
watching it go red is only worth anything if the revert **actually
landed**. A string-replace that matches nothing changes no file, the
suite passes, and that passing run looks exactly like "the test does not
catch it" — or worse, gets misread as "verified."

This happened on `needsEntryFromChain` (2026-09-02): the replacement
text was written before `npm run format` re-indented the continuation
lines, so the pattern no longer matched. The revert was a no-op, the
tests passed, and the next step would have been to report the test as
proven when nothing had been tested.

**How to apply:**

- Put an `assert`/`raise` on every patch used for verification —
  `assert old in s, "PATCH DID NOT MATCH"` — so a missed match is loud.
- Prefer index-based slicing (`s.index(start) … s.index(end)`) over
  matching a long literal block, since Prettier reflows whitespace and
  line breaks inside a block after you have copied it.
- Confirm the mutation independently before running the suite: a
  `grep -c` for the removed token, or a diff line count.
- A verification run that comes back green is a result to be suspicious
  of, not a result to report.

Related: [[feedback_instrument_before_inferring]],
[[feedback_use_the_path_being_tested]].

## verify the runtime before rediagnosing

On 2026-07-23 a one-line UI fix spiraled: the fix was correct and
green in tests, but the user's browser was executing a stale
immutable-cached bundle (because I kept reverting the cache-bust
stamps).  I mis-read each "still broken" report as a logic bug and
added MORE code (server-side emit, client seed) under wrong
diagnoses.  The user called it "hazardous to my app code" — correct.

**Hard rules:**

1. Before reporting a user-facing fix as done, verify it through the
   REAL serving path, not only unit tests: for this app that means
   `npm run build` ran, the `?v=` stamp in the COMMITTED index.html
   moved, and the user knows a reload is needed.  Related:
   [[feedback_never_revert_cache_bust_stamps]],
   [[feedback_use_the_path_being_tested]].
2. When the user reports "still broken" and the source + tests are
   verifiably correct: the FIRST check is runtime-vs-source, in this
   order — (a) committed stamp vs latest build stamp, (b) which
   branch/commit the running server's working tree is on, (c) was the
   server restarted since the change, (d) live-inspect the running
   system (curl /api/status) — BEFORE re-opening the logic.
3. Never add a second fix while the first is unconfirmed-delivered.
   One diagnosis, one change, one verified delivery, then reassess.
4. Every extra fix layered under a wrong diagnosis is real code the
   user must now carry.  When a wrong-diagnosis layer is discovered,
   explicitly re-justify it on its own merits or propose removing it.
