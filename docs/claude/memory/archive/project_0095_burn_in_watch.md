---
name: project_0095_burn_in_watch
description: "Release 0.9.5 ('Cole Younger - 5') cut and deployed to Production 2026-09-28. Two things to watch: the Impermanent Loss Guard default dropping 50 → 15 changes behavior on every position that never set it, and the RPC-outage fix has not yet met a real outage."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-28T19:40:32.752Z
---

Release **0.9.5** cut and deployed to Production 2026-09-28.
<https://github.com/nottoseethesun/lp-ranger/releases/tag/0.9.5>
PR #210, merged as `c468af9`. Operator confirmed the local run good
before the merge.

Two changes, one of which alters behavior on an install that does
nothing.

## 1. The Impermanent Loss Guard now defaults to 15%, from 50%

**This is the one to watch.** `impermanentLossGuardPct` is a per-position
setting, and a position that never saved one takes the shipped default.
On the operator's own install, none of the sixteen positions in
`bot-config.json` had it saved as of 0.9.4 — so **all of them moved to
15 on update**.

Expect rejections that 0.9.4 would not have produced. The worked case,
pinned in both `test/il-guard.test.js` and `test/il-guard-gate.test.js`,
is position #164418 on 2026-09-01: $3,947.23 at mint, $2,788.65 then,
29.4% down. It rebalanced under 50 and is refused under 15.

The rationale is the operator's: rebalancing **crystallizes** the loss,
since the position is re-minted around the current price and a paper
loss a recovery would have undone becomes permanent. Declining forgoes
fees the position is largely not earning, because the guard is only
consulted when a rebalance was due and that usually means out of range —
and fees are the only thing that earns such a loss back, which a
low-volume pool may never produce fast enough.

**What to watch:** whether 15 is too tight in practice. The cost is
real and asymmetric — a rejection clears only when price recovers,
because a blocked position cannot mint a new NFT and so cannot take a
new baseline. A position that sits rejected for weeks while its pair
drifts sideways is the failure mode. If that happens, the number wants
to be somewhere above 30, and it is one literal in
`bot-config-defaults.json`.

Retries back off 4 h → doubling → one week, and the `ilGuardRejected`
Telegram alert rides the same stamp, so a long block reports on a
widening interval rather than every poll.

## 2. The total-RPC-outage fix has not met a real outage

See [[project_total_rpc_outage_oom]] for the mechanism. The fix is
`staticNetwork` in `buildProvider`, verified by reproduction and by
`test/rpc-outage-no-unpaced-detection.test.js`, but no production
outage has exercised it since.

**The tell if it regresses:** the all-endpoints-down banner repeating
faster than once an hour. Correct behavior is three failover lines, one
banner, then silence for the hour. Cheap to grep the log for.

**Also unconfirmed in production:** reads should now cost about half the
RPC requests they did, since network detection no longer fires on every
one. A five-year event scan should finish in roughly half the wall-clock
time. Worth confirming on the ~133-NFT chain, which is the install's
heaviest scan — see [[project_test_wallet_is_atypical]].

## How to check, concretely

The operator runs Production with log-to-file on, so both tells are in
one place: `logs/lp-ranger.log` under the install root, appended across
runs. (The shipped default in `logging.json` is off; this install opts
in.)

```bash
grep -c 'ILG rejected' logs/lp-ranger.log     # the Guard change showing up
grep 'ALL 3 RPC ENDPOINT' logs/lp-ranger.log  # want: one banner, then an hour's silence
```

Each `ILG rejected` line carries the position, the projected value, the
floor, the percent and — as of 0.9.5 — the name of the setting that
produced it. File size is itself a signal: the 0.9.4 log reached 113 MB
and roughly 90% of that was the runaway loop, so a quiet week should
stay far smaller.

The standing bar is [[project_maturity_staircase]]: stability outranks
features, and the operator's own read since 0.9.2 is that the app may be
done — if it holds through burn-in and some months of use, it becomes
1.0. Watches for 0.9.2 and earlier are in `archive/`, which is resolved
history and deliberately unindexed.
