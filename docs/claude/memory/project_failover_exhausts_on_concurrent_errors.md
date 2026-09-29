---
name: project_failover_exhausts_on_concurrent_errors
description: "Hit Production 0.9.5: 'ALL 3 RPC ENDPOINT(S) FAILED' fired when only one endpoint had failed, because failoverToNextRPC() advanced a shared index from wherever it was and concurrent failures each advanced it. Fixed by naming the failed endpoint; shipped in 0.9.6."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-28T23:47:40.653Z
---

**Fixed, shipped in release 0.9.6** (PR #212, merged as `0587078`).
Hit Production on 0.9.5 (`commit=c468af9`), 2026-09-28, where it stopped
the initial sync from finishing. Evidence:
`troubleshooting-work/lp-ranger.log`, 125 lines.

**The fix:** the caller names the endpoint it saw fail, and selection
advances only while it is still on that one — an identity check against
`_activeIdx`, no new state, no timer. Ten failures against the first
endpoint advance once; the rest return `false` and their callers retry
on whatever the first moved to. Pinned by
`test/rpc-failover-idempotent-per-endpoint.test.js`, four of whose ten
cases fail against the unfixed tree, including eight concurrent reads
driven through the real proxy and retry loop.

**No two-strike rule.** It was considered and rejected: the evidence
says one endpoint really was refusing, and the damage came from that one
failure being counted three times. Requiring two consecutive failures
would let a genuinely dead endpoint waste another read for a benefit
this fix already delivers. Revisit only if burn-in shows single blips
still rotating endpoints needlessly.

The banner says every endpoint failed. **It is false.** At 19:34:25,
inside one second:

```text
101  RPC failover engaged: g4mm4 → pulsechain.com
102  [pool-state] rpc=g4mm4 attempt=1/2 failed: 502
103  RPC failover engaged: pulsechain.com → pulsechain.box
104  read retry #1 on call failed: 502   requestUrl = pulsechain.box
105  ALL 3 RPC ENDPOINT(S) FAILED … PAUSING ALL RPC REQUESTS FOR 1 HOUR
```

**`rpc.pulsechain.com` was never asked.** No failure is logged against
it, and the first attempt of that retry loop — `read retry #1` — already
reports `pulsechain.box`, the *third* endpoint. Selection moved twice
before one read got to try once. The operator's own
`util/diagnostic/check-rpc-health_g4mm4-io.js` passed against g4mm4 four
seconds later.

## Cause

`failoverToNextRPC()` (`src/send-transaction.js`) takes no argument
saying **which** endpoint failed. It reads the shared `_activeIdx`,
advances one, and returns. Nothing ties the advance to the endpoint the
error came from, so every concurrent failing read advances it again.

Ten positions start on a stagger and poll; `getPoolState` runs its own
per-URL loop beside them. One transient blip therefore produces several
simultaneous failures, each stepping the index. Three endpoints are
consumed by **two or three concurrent errors**, not by three proven-bad
endpoints, and whichever caller steps off the end trips the hour-long
halt for the whole process.

## Not a 0.9.5 regression

The 0.9.4 log shows the identical shape at 07:07:23–25: two failovers
back to back, no failure logged for the middle endpoint, then the
banner. What 0.9.5 changed is that the halt now actually holds — see
[[project_total_rpc_outage_oom]]. Before, the process spun and died, so
nobody noticed the list had been exhausted spuriously. A working halt
made a pre-existing false positive expensive: one blip on one endpoint
now freezes every RPC request for an hour.

## Shape of a fix (not yet agreed)

Make the advance **idempotent per endpoint**: pass the provider (or
index) the error came from, and advance only while selection is still on
it. N concurrent failures against endpoint 0 then advance exactly once,
and the list is spent only by endpoints that genuinely refused. The
callers already hold that value — the proxy's `get` trap in
`getManagedReadProvider` closes over the `current` provider it called,
and `retryRead`'s loop holds `next`.

Worth deciding at the same time: whether one 502 should retire an
endpoint at all, or whether it needs two consecutive failures. These
public endpoints 502 transiently often enough that the operator's health
check passes seconds later.

Related: [[project_0095_burn_in_watch]], [[project_consolidate_rpc_retry]],
[[feedback_defense_in_depth_must_be_slower]].
