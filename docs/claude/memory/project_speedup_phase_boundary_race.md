---
name: project_speedup_phase_boundary_race
description: "FIXED 2026-10-03: a receipt re-ask inside a speed-up phase carried a deadline of the phase's own length, so the two could expire together and conclude opposite things — speed the transaction up, or give up on the move. The fix removed the second deadline rather than teaching the code to tell them apart."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T17:19:27.065Z
---

Found 2026-10-02 while making
[[project_receipt_rewait_test_flake]] reproducible. **Fixed
2026-10-03.**

## What was wrong

When an endpoint refuses to say whether a transaction confirmed, the bot
asks a different endpoint the same question. That re-ask was given two
independent ways to stop, both the length of the speed-up phase it ran
inside: the phase's abort signal, and a deadline of its own.

Under an endpoint already down when the transaction was broadcast, the
first refusal arrived immediately, so both were armed at the same moment
with the same duration and expired together. They concluded opposite
things about the same silence — the phase's clock means "go on to the
next phase and re-send at higher gas", while the re-ask giving up
rethrows the endpoint's error, which phase one does not recognise and so
treats as the move having failed.

Whichever settled first decided. The speed-up's clock is a
`setTimeout`; the re-ask's was a time comparison reached only after a
poll returned, paced by the shared request queue. So the bot abandoned a
stuck transaction instead of pushing it through, and what chose was the
order the event loop happened to run two callbacks.

It cost the move at the worst moment: an endpoint refusing for the whole
phase is exactly the condition the speed-up exists for.

## What the fix was, and what it was not

**An endpoint that will not answer is never the move's failure.** The
transaction is on chain or it is not, and a refusal says nothing about
which, so the only thing to do about one is ask again. The user's
framing, and it is the whole fix: *"The two requests should be handled
entirely separately."*

So the redundant deadline is gone. `_phase` (`src/tx-speedup.js`) hands
down the abort signal and nothing else, and
`_receiptAcrossEndpoints` (`src/send-transaction.js`) computes no
deadline of its own when it is given a signal. One authority per
re-ask, so there is no tiebreak left to lose.

What it is **not**: the two fixes this file previously proposed — have
the re-ask report "my time ran out" distinctly from "the endpoint
failed", or have the phase treat a late wait failure like its own
sentinel — both accept the ambiguity and then work around it. A guard
protecting a guard means step one was wrong
([[feedback_dont_invent_a_requirement]]). Also rejected: waiting ~50 ms
to infer whether a failure really means a dead endpoint, to save a
needless retry. That is an optimisation, and optimisations are not done
unless asked for.

Phase three needed no separate fix. It races two waits and always leaves
a loser, but both now get the same signal-only budget, so the same rule
covers it.

One deadline stays, deliberately: the fallback wait after a speed-up
could not be sent has no phase around it, so its own deadline is the
only bound it has.

## Where it came from

`743aad7`, 2026-09-30, "poll for the receipt, and let a finished phase
actually finish" — already on `main` via a different branch. That commit
added both stopping conditions in one breath. The signal was correct and
sufficient; the deadline was redundant the moment it was written, and
expressing "stop" as *rethrow the endpoint's error* is what coupled the
two requests.

## Tests

`test/receipt-reask-bound.test.js` states the rule in five cases, driving
the re-ask directly — a race between two equal deadlines reproduces
through the pipeline only as a coin flip, and a coin flip does not prove
a fix. The load-bearing one is "keeps asking under a phase signal,
however stale its own deadline": it passes a 1 ms deadline with a signal
and requires the asking to continue. Verified to fail with the old line
restored and pass with the fix.

`test/receipt-wait-failover.test.js` also got back the assertion this
fault had forced out of it — that the move SUCCEEDS when every receipt
wait is refused. It had been tolerating a failure because of this race.
Twenty concurrent copies pass, where one run in sixteen failed before.

Related: [[project_tx_wait_not_failover_covered]] — the same function,
found the same way.
