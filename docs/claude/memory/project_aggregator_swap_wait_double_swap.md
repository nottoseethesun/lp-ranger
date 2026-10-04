---
name: project_aggregator_swap_wait_double_swap
description: "FIXED 2026-10-03: the aggregator's swap confirmation wait rethrew any endpoint failure unflagged, so no cancel was sent and the router fallback read it as 'no swap happened' and swapped the same balance again. Now waits through send-transaction's waitForReceipt, which re-asks across endpoints."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T18:37:43.200Z
---

Found 2026-10-03, auditing for the control-flow class that
[[project_speedup_phase_boundary_race]] belonged to. **Not fixed.** The
same mistake, in the one transaction path that fix does not cover, and
with a worse outcome.

## What happens

The aggregator broadcasts the swap itself — it does not go through
`sendTx.sendTransaction`, so it gets neither the four-phase speed-up
pipeline nor the receipt re-ask. It waits for confirmation with a bare
`tx.wait()` against the endpoint that broadcast it, raced against its
own timer (`src/rebalancer-aggregator.js`):

```js
const r = await Promise.race([
  tx.wait(),
  new Promise((_, rej) => setTimeout(() => rej(new Error("_AGG_TIMEOUT")), waitMs)),
]);
…
} catch (err) {
  if (err.message !== "_AGG_TIMEOUT" && err.code !== "CALL_EXCEPTION") throw err;
```

The catch recognises two things: its own timer, and an on-chain revert.
**An endpoint failure is neither.** A 502, a connection reset, a socket
timeout — `tx.wait()` rejects with `SERVER_ERROR`, `ECONNRESET`,
`TIMEOUT`, and every one of them is rethrown.

## Why that costs funds

Rethrowing skips the recovery this module exists to run. No cancel goes
out, so the nonce stays held by a swap still sitting in the mempool. And
the error leaves **unflagged** — it never reaches `settleNonce`, so it
carries no `nonceUnsettled`.

`swapIfNeeded` (`src/rebalancer-swap.js`) stops its fallback on exactly
one condition:

```js
if (err?.nonceUnsettled) throw err;
```

A flagless error is read as "no swap happened", so the V3-router
fallback **sends a second swap of the same balance**. The aggregator's
swap can still mine. Both landing means the balance is swapped twice:
the position is left on the wrong side of the pair, and the second swap
pays full price impact on tokens that had already moved.

This is the precise outcome the whole `settleNonce` /
`nonceUnsettled` design was built to prevent, bypassed because an
endpoint's error never reaches it.

## More reachable than the one already fixed

The phase-boundary race needed two deadlines of equal length to expire
in the same instant. This needs **one endpoint hiccup anywhere inside
the confirmation window** — there is no re-ask and no second chance.

It is also a failure already seen in Production.
[[project_tx_wait_not_failover_covered]] is `tx.wait()` dying on a 502
from the endpoint the failover had just left, 2026-09-30. That was fixed
for the `sendTransaction` path by re-asking across endpoints. **This
path was never fixed**, because it never calls that entry point.

## The fix, 2026-10-03

A receipt is a read, and the codebase already had the answer: ask
another endpoint. The swap's wait now goes through
`sendTx.waitForReceipt`, so an endpoint failure stops being an outcome
of the race at all and only the two things the catch already handles can
arrive — its own `_AGG_TIMEOUT`, or a revert.

The reuse is deliberately shaped so the next caller cannot repeat this.
`tx-speedup.js` exports `_waitOnePhase` (the first of its four phases,
on its own), and `send-transaction.js` wraps it as `waitForReceipt`
with the cross-endpoint re-ask **already attached** — the module that
owns endpoint selection also owns the only door to a receipt wait. A
caller handed the pieces is a caller that can forget one, which is how
this happened.

It composes with [[project_speedup_phase_boundary_race]] and only works
because of it: the re-ask no longer carries a deadline of its own, so
the phase's clock is the single bound. Wiring this up before that fix
would have reproduced the same race here.

Tests in `test/receipt-reask-bound.test.js`: the receipt is served from
another endpoint when `tx.wait()` fails; the caller's own sentinel still
arrives when nothing serves it, because the cancel-and-settle recovery
triggers on it; a revert passes through untouched. Plus a source-shape
case — behavioural coverage cannot catch a return to a bare `tx.wait()`,
since every behavioural case would still pass. It requires the gateway
call and requires any `.wait()` left in the module to have its rejection
neutralised, as the cancel's `.catch(() => null)` does. Verified to fail
with the bare race restored.

## Scope of the audit that found it

Exactly two places in the app race a rejecting timer against real work:
`tx-speedup.js` (fixed 2026-10-03) and this one. Inventory taken across
`src/`, `public/dashboard-*.js`, `server.js` and `bot.js`. The other
abort-signal users — the pool-creation finder, pool scanner, event
scanner and chunked log reader — use signals for cancellation and do not
race a rejecting timeout.
