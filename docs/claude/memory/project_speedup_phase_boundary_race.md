---
name: project_speedup_phase_boundary_race
description: "OPEN, reproducible: at a speed-up phase boundary the receipt wait's own rejection can win the race against the phase timer, so `_waitOrSpeedUp` rethrows it and the move fails outright instead of proceeding to the speed-up. Microtask ordering decides which."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T00:21:42.996Z
---

Found 2026-10-02 while making
[[project_receipt_rewait_test_flake]] reproducible. **Not fixed** — it
changes control flow in the pipeline that recovers stuck transactions,
and it was found at the end of a long session.

## What happens

`_waitOrSpeedUp` (`src/tx-speedup.js`) runs each phase as a
`Promise.race` between the receipt wait and a phase timer. Phase 1:

```js
const receipt = await Promise.race([
  _settled(_tolerantWait(tx, label, onWaitError, speedupPhase.budget)),
  speedupPhase.timer,
]);
…
} catch (err) {
  if (err.message !== "_SPEEDUP") throw err;   // ← here
}
```

When the endpoint keeps refusing, `_tolerantWait` hands the failure to
the re-ask, and the re-ask gives up on the SAME deadline the phase timer
uses — `_receiptAcrossEndpoints` rethrows the original error once
`budget.signal.aborted` or `Date.now() >= until`
(`src/send-transaction.js`). So at the boundary two promises settle at
once: the timer with `_SPEEDUP`, and the wait with the endpoint's error.

Whichever lands first wins. Timer first: the catch recognises
`_SPEEDUP`, falls through, and the transaction is sped up as designed.
Wait first: the catch does not recognise the error and **rethrows**, so
the whole move fails rather than being sped up.

## Why it matters

The speed-up exists because a transaction is sitting unconfirmed. Losing
the race means the bot abandons the move instead of replacing it at
higher gas — and it abandons it precisely when the endpoint has been
failing for the whole phase, which is when a speed-up is most wanted.
At the shipped `TX_SPEEDUP_SEC` of 120 the boundary is rare, but an
endpoint failing continuously for two minutes arrives there exactly.

## How to reproduce

Twenty copies of `test/receipt-wait-failover.test.js` run at once,
with the phase shortened so the boundary comes quickly:

```bash
for i in $(seq 1 20); do (node --test test/receipt-wait-failover.test.js &) ; done
```

With `config.TX_SPEEDUP_SEC = 0.6` in that file's `beforeEach`, roughly
one run in sixteen failed with the endpoint's 502 escaping through
`_waitOrSpeedUp`. The test no longer asserts a successful move, so it
will not show this any more — reproduce by asserting one.

## The shape a fix probably takes

A wait that failed *because its phase ran out* is the phase ending, not
the move failing. Either the re-ask reports that distinction instead of
rethrowing the original error, or phase 1's catch treats any wait
failure arriving at or after its own deadline the way it treats the
sentinel. The second is local — `startTime` and `speedupMs` are both in
scope — and the first is cleaner but couples the read layer to this
module's sentinel.

Phase 3 races three promises and guarantees a loser, since only one of
the two transactions can mine, so check it with the same eye.

Related: [[project_tx_wait_not_failover_covered]] — the same function,
the same class of fault, found the same way.
