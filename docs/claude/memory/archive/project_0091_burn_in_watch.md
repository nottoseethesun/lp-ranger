---
name: project_0091_burn_in_watch
description: "Release 0.9.1 (2026-09-02) entered Prod burn-in. Watch the first real ILG rejection, In/Out on a position with genuine deposits, and the fact that existing installs need a Reload before P&L is complete."
metadata: 
  node_type: memory
  type: project
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-02T07:47:56.925Z
---

Release **0.9.1** cut 2026-09-02 and installed on Prod the same day.
<https://github.com/nottoseethesun/lp-ranger/releases/tag/0.9.1>
Tag points at `996c97e`; PRs #190–#195.

## What to watch

1. **A first ILG rejection in the wild.** The alert modal, the Telegram
   message and the 4h→doubling→1-week backoff have only ever run in
   tests. No position has actually been refused on Prod.
2. **In/Out on a position with real deposits.** The sign was flipped so
   positive means value came back OUT to the wallet. Verified only
   against the HEX/eHEX position.
3. **Reload on a long history.** 132 `getPositionHistory` calls with
   price lookups is the heaviest path this release touches.

## Two things operators will hit

- **Existing installs need one Reload Current Position per affected
  position.** The epoch-completeness and cache-key fixes change what
  gets *collected*; they do not repair data already on disk. Symptom:
  thin Per-Day history, or a dash in the Profit column where the
  deposited amounts were never recorded.
- **Profit now differs sharply from Net P&L and that is the fix.** On
  2026-08-25 the reference position reads Profit −262.74 against Net
  P&L +1,397.85. Correct, and alarming to anyone who has not read the
  circle-i.

## Gotcha found during the release

Renaming a field in the `/api/status` payload (`residual` → `inOut`)
breaks silently in a half-updated environment: the browser picks up the
new bundle on reload and reads `d.inOut`, while an unrestarted server
still sends `residual`. The column rendered `0.00` on every row and
looked like a fresh bug. **A payload rename needs the server restarted,
not just the page reloaded** — say so in the handover.

## Open item

The query that found all four of this session's bugs was an ad-hoc
comparison of derived data against the chain, per pool: epochs vs
on-chain rebalance count, deposit amounts present, cache keys
well-formed. Worth a `util/diagnostic/` script so it is a command
rather than a lucky idea. See [[feedback_signal_substitution]] and
[[project_util_diagnostic_directory]].

---

**SUPERSEDED — archived 2026-09-03.** 0.9.2 shipped and is on
Production; see [[project_0092_burn_in_watch]]. The three watch items here
were resolved or overtaken: ILG still has no live rejection (carried
forward), In/Out was found to be wrong and fixed in #198, and the Reload
path was fixed in #196 so it re-derives instead of restoring.
