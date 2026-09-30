---
name: project_0097_burn_in_watch
description: "Release 0.9.7 ('Cole Younger - 7') deployed to Production 2026-09-29 as an Update. Rate-based rpc failover had fourteen hours of Dev burn-in on the same commit and met five real outages, all on the read path. The write path under failover, and the 429 backoff, have never run."
metadata: 
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-29T22:24:56.116Z
---

Release **0.9.7** cut and deployed to Production 2026-09-29, as an
Update rather than a fresh install.
<https://github.com/nottoseethesun/lp-ranger/releases/tag/0.9.7>
Tag points at `4992368` — PRs #213 and #214.

Unusually for this project, the release shipped **after** its burn-in
rather than before: Dev ran that exact commit for fourteen hours
(08:10:45Z to a clean shutdown at 22:23:42Z, one session, no restarts)
and met five real endpoint outages in that window.
Supersedes [[project_0096_burn_in_watch]], now in `archive/`.

## What the Dev run already proved

Five `g4mm4` outages — 12:52, 16:56, 18:06, 19:54, 22:09 — every one an
HTTP 502 burst. Each ran the same shape and none needed intervention:

- two pool-state failures, then the read-retry loop, then one
  `RPC failover engaged` line about **eleven seconds** after the first
  failure
- one endpoint spent, never the list
- zero `ALL 3 RPC ENDPOINT` banners
- selection returned to `g4mm4` an hour later each time, which is how it
  was in service to fail again

Final tally over the fourteen hours: five failovers, 125 read retries,
ten pool-state failures, zero banners, zero 429s, zero ILG rejections.

The eleven seconds is the rate crossing, not a shortcut. It took about
twenty-eight consecutive failures to outvote the roughly twenty-seven
successes already banked in the five-minute window. A hard outage
always crosses fast, because failures arrive at the pacing rate while
the denominator is whatever light traffic had accumulated — the window
is what makes the bot tolerant of *intermittent* flakiness, and it does
not slow detection of a dead endpoint. See
[[project_failover_exhausts_on_concurrent_errors]] for the defect this
replaced.

## 0. Several failovers a day is the baseline, not a regression

`g4mm4` flapped all through 2026-09-29, and the sticky window turns that
into a repeating cycle: fail, move, wait an hour, selection returns to
it, fail again. Clean time on `g4mm4` between cycles ran about three
hours, then nine minutes, then forty-eight, then seventy-five. Five
failovers in fourteen hours was that day's normal.

Do not read a handful of daily failovers as the fix having broken.
Read the *shape* instead — section 3 below. Production runs the same
endpoint list, so expect the same beat there.

## 1. The write path under failover has never run

**This is the top open risk.** Not one rebalance and not one compound
fired in the whole thirteen hours — the position stayed in range
throughout. So the nonce path, the rebalance lock and the TX
speed-up/cancel pipeline have never been exercised while selection was
moving underneath them.

Watch for the first rebalance that coincides with a failover. What
correct looks like: the move completes on whichever endpoint selection
landed on, with one nonce. What would be wrong: a nonce gap, a
duplicate submission, or a rebalance that aborts because its provider
changed mid-flight.

## 2. The 429 backoff has never fired

Zero rate-limited responses in thirteen hours, so
`rpcRetryOn429DelaysMs` and `rpcMax429PenaltyMs` are untested in the
field. `rpc.pulsechain.box` is the free-tier endpoint (50 requests per
10 seconds per IP) and the likeliest source. The tell:

```bash
grep -c 'rpc-429' logs/lp-ranger.log
```

A 429 should produce a wait and a retry, **not** a failover — moving
carries our own request rate to the next endpoint.

## 3. The failover shape is the instrument

```bash
grep -E 'failover engaged|ALL [0-9]+ RPC ENDPOINT' logs/lp-ranger.log
```

**Correct:** a run of `read retry` lines, then one failover line naming
the endpoint it left.

**Wrong two ways.** A failover after only a handful of failures means
the rate threshold stopped applying and one error is moving selection
again. A banner with fewer than three preceding failover lines means an
endpoint was skipped rather than asked.

## 4. Carried forward from 0.9.6, still unresolved

**The Impermanent Loss Guard at 15%** (was 50). Zero rejections in the
Dev run, but that run never rebalanced, so it proves nothing. The cost
is asymmetric: a rejection clears only when price recovers, since a
blocked position cannot mint a new NFT and so cannot take a new
baseline. A position sitting rejected for weeks on a sideways pair is
the failure mode; if it shows, the number wants to be above 30, and it
is one literal in `bot-config-defaults.json`. Count with
`grep -c 'ILG rejected' logs/lp-ranger.log`.

**Reads should cost about half the rpc requests** they did before
0.9.5. A five-year event scan should finish in roughly half the
wall-clock time, worth confirming on the ~133-NFT chain
([[project_test_wallet_is_atypical]]).

The standing bar is [[project_maturity_staircase]]: stability outranks
features, and the operator's read since 0.9.2 is that the app may be
done — if it holds through burn-in and some months of use, it becomes
1.0.
