---
name: project_read_retry_never_probes_another_endpoint
description: "LOW PRIORITY (operator assessment 2026-10-03: acceptable in practice — the endpoint came back and the rate gate correctly declined to retire it). A bounded read spends every attempt on the endpoint that is refusing, because its only source of a provider is process-wide selection and that moves only when the failure rate retires the endpoint. Healthy endpoints sit idle and the read fails outright. The write path already solves this."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-04T02:06:28.108Z
---

Found 2026-10-03 by the user, reading a burn-in log: *"Why wasn't there a
failover here?"* Pre-dates the
`rpc-recovery-log-and-pool-state-failover` branch, which only made it
visible.

**Low priority, by the operator's own assessment** once they read further
in the same log: *"things are fine with that; I can see later in the log
that g4mm4.io did come back."* That is the point — the endpoint recovered,
so the rate gate was right to leave it in service, and the whole cost was
one poll cycle on a read that another endpoint could have served. Filed
here rather than among the open bugs so it does not lead a status report
it does not deserve to lead.

## What the log showed

Six consecutive attempts, three to four seconds apart, every one against
the same endpoint, then the read gave up:

```text
[pool-state] read retry #1/6 on getPoolState failed: rpc=…g4mm4.io 502
[pool-state] read retry #2/6 … rpc=…g4mm4.io 502
…
[pool-state] read retry #6/6 … rpc=…g4mm4.io 502
[bot] Pool state error: getPoolState: exhausted 6 RPC attempt(s)
```

Two other endpoints were configured and healthy throughout. Neither was
asked. It happened twice in three hours.

## Why

`retryRead` (`src/rpc-read-retry.js`) takes its provider from one place:
`current()`, which is `sendTx.getCurrentRPC()`. Selection is
process-wide, and it advances only when `failoverToNextRPC` agrees to
move — which requires `decideIfCurrentRPCIsOutOfService` to find the
endpoint failing more than `rpcFailoverRatePercentage` (50) of what it
was asked inside `rpcFailoverRateDurationMinutes` (5).

Six failures did not reach that share, because ten positions polling put
a great many successful reads in the same denominator. So selection
stayed put, `current()` returned the same provider on every attempt, and
the budget was spent on the one endpoint that was refusing.

## The rate gate is not the bug

It is doing its job. One bounded read can report six failures by itself,
and before the rate existed that burst would retire an endpoint in
seconds — the reason the decider was introduced
(`0d7cbee` on main). Lowering the threshold trades this fault for that
one.

The actual defect is that **two decisions are collapsed into one.**
"Retire this endpoint for the whole process" and "ask a different
endpoint for this one read" are independent, and the read path only has
the first.

## The fix already exists on the write path

`_estimateWithFailover` (`src/send-transaction.js`) walks each remaining
endpoint in turn and **commits the selection change only on success**, so
a total outage leaves the bot on its preferred endpoint rather than
pinned to whichever it tried last. That is exactly the shape the read
loop needs: probe the next endpoint for this read, and leave
process-wide selection to the rate.

Note the asymmetry worth preserving — an unbounded read (one whose answer
nobody waits on) is fine as it stands, because the endpoint list comes
round again and it will be served eventually. The gap only bites a
**bounded** read, which gives up.

## Why it matters beyond a failed poll

A pool-state exhaustion surfaces to the operator as
`pool-info-unavailable` and to the bot as a `pollError` — recoverable,
one cycle lost. But it is also the trigger for the first item in
[[project_false_zeroes_for_price_and_amounts]]: the token-decimals read
inside the HODL baseline is a `getPoolState` call, and its exhaustion is
what writes a baseline of zeros. Fixing this would make that far rarer,
and is not a substitute for fixing it.
