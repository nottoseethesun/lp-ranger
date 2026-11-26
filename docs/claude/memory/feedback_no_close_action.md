---
name: feedback-no-close-action
description: "LP Ranger never closes a position: no close button, no api call to close, and there should not be; a closed one leaves the Managed list at once at start-up, after the drained wait while running"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-26T06:23:54.256Z
---

LP Ranger has no button and no api call that closes a position, that is,
removes its liquidity without minting a new one. There should not be
one. A position is closed outside LP Ranger, on 9mm. A position LP Ranger
finds closed comes off the Managed list: at once when the app starts,
and after the drained-position wait (`retire.drainedAfterMs`) while it
runs. That wait runs from the first check that finds the position
drained with no rebalance under way or asked for and no mint retry
coming: it is the owner's time to rescue a stopped rebalance, which
rests on state only the running bot holds.

**Why:** the user, 2026-11-25, on a closed saved position that held its
pool for 30 minutes after a start, blocking the pool's open position:
"Actually there isn't a close button nor an api call to close, and there
should not be, but what we should do to fix this, is simply on start-up
of the app, clean the Managed list of any closed positions."

**How to apply:** don't propose a Close Position feature or an api to
close one. "Confirmed closed" is the chain answering zero liquidity at a
start, or the drained wait running out while the app runs; never a user
action inside LP Ranger. Related:
[[feedback-one-active-position-per-pool]].
