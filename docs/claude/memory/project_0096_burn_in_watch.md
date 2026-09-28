---
name: project_0096_burn_in_watch
description: "Release 0.9.6 ('Cole Younger - 6') deployed to Production 2026-09-28. Watch the all-endpoints-down banner: it must now appear only when all three endpoints really are down, and at most once an hour. Carries forward 0.9.5's two open items — the Impermanent Loss Guard at 15%, and the outage fix that no real outage has exercised."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-28T23:51:35.948Z
---

Release **0.9.6** cut and deployed to Production 2026-09-28, hours after
0.9.5 the same day.
<https://github.com/nottoseethesun/lp-ranger/releases/tag/0.9.6>
PR #212, merged as `0587078`.

Two releases in one day because 0.9.5 shipped a fix that exposed a
second defect — see [[project_total_rpc_outage_oom]] and
[[project_failover_exhausts_on_concurrent_errors]]. Both are now on
Production, and neither has met a real outage.

## 1. The banner is now the instrument

`ALL 3 RPC ENDPOINT(S) FAILED` used to fire when **one** endpoint had
failed, because concurrent reads each advanced selection. It now
requires three endpoints genuinely refusing.

**What correct looks like:** three `RPC failover engaged` lines, one
banner, then an hour of silence, then the list restarting at `g4mm4`.

**The tell, and it is cheap:**

```bash
grep 'ALL 3 RPC ENDPOINT' logs/lp-ranger.log
```

Two banners closer together than an hour means something reopened a path
around the guard. One banner with fewer than three preceding failover
lines means an endpoint was skipped rather than asked — the original
defect, back.

## 2. Carried forward from 0.9.5, still unresolved

**The Impermanent Loss Guard at 15%** (was 50). None of the sixteen
positions had a saved value, so all of them moved. Expect rejections
0.9.4 would not have produced. The cost is asymmetric: a rejection
clears only when price recovers, because a blocked position cannot mint
a new NFT and so cannot take a new baseline. A position sitting rejected
for weeks on a sideways pair is the failure mode; if it shows up, the
number wants to be above 30, and it is one literal in
`bot-config-defaults.json`. Count them with
`grep -c 'ILG rejected' logs/lp-ranger.log`.

**Reads should cost about half the RPC requests** they did before 0.9.5,
since network detection no longer fires on every one. A five-year event
scan should finish in roughly half the wall-clock time — worth
confirming on the ~133-NFT chain, the install's heaviest scan
([[project_test_wallet_is_atypical]]).

## 3. New in 0.9.6, low risk

`util/diagnostic/check-rpc-health.js` — probes one endpoint and prints
seven timed checks. Defaults to `g4mm4`, `--rpc-endpoint <url>` points
it elsewhere, and it imports nothing from `src/`, so it is safe to run
while Production is up. Every `util/` CLI now parses with `commander`,
and a file nothing reaches fails the build.

The standing bar is [[project_maturity_staircase]]: stability outranks
features, and the operator's read since 0.9.2 is that the app may be
done — if it holds through burn-in and some months of use, it becomes
1.0. Watches for 0.9.5 and earlier are in `archive/`.
