---
name: project_0092_burn_in_watch
description: "Release 0.9.2 (2026-09-03) is on Production. The user considers the app feature-complete; if it holds through burn-in and some months of use it becomes 1.0. Watch the corrected P&L figures on positions other than the HEX pool."
metadata:
  node_type: memory
  type: project
---

Release **0.9.2** cut and deployed to Production 2026-09-03.
<https://github.com/nottoseethesun/lp-ranger/releases/tag/0.9.2>
PRs #196–#199.

**The user's read: the app may be done.** *"I think that perhaps, this
app is done. If it stands up for burn-in and some more months of use, it
will be ready to be Version 1.0."* So the bar has shifted — from
shipping features to not disturbing something that works. See
[[project_maturity_staircase]].

## What to watch

1. **The corrected P&L figures on other pools.** Every number in 0.9.2
   was verified against the HEX/eHEX position, which has 132 rebalances
   and heavy auto-compounding. Pools with few rebalances, or none, are
   less exercised.
2. **Positions whose HODL baseline has not resolved.** A live epoch then
   falls back to the position's current value, so In/Out still drifts
   across restarts until the mint receipt is read. Self-corrects, but
   looks like the old bug while it lasts.
3. **Reload Current Position under real use.** It now discards the
   tracker's closed epochs before rebuilding. If a rebuild fails, the
   Per-Day table is briefly empty until the next scan retries.

## Operator step that is easy to miss

Updating from 0.9.1 or earlier needs **one Reload Current Position per
managed position** — the fixes change how figures are *derived*, and do
nothing to numbers already on disk. It is Step Ten of the README's
Update section, and the user added a note about it to the release body.

## Numbers that should still hold

On the HEX pool at the time of release: Per-Day column totals of
Fees 615.95, Gas 8.82, Price P&L 1353.38, Net P&L 1960.50, In/Out
−1680.68, IL −1624.81, Profit −1017.69 across 132 epochs. Net P&L is
the control — it must not move when a fee or IL figure is corrected.

Definitions behind those figures: [[project_pnl_accounting_model]].
