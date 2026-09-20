---
name: feedback_signal_substitution
description: "A condition must test the thing it is actually asking about, not a cheaper nearby signal that usually agrees. Four bugs in one day (2026-09-01/02) all had this shape and all hid on the subset where the two diverge."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-17T06:55:20.366Z
---

When writing a condition, ask: **is this testing the thing I actually
care about, or something cheaper that usually agrees with it?**

Four bugs found in a single session, all the same shape:

| The signal used | The question it was really answering | Where |
| --- | --- | --- |
| `!!cachedHodl` | has the compound scan already run? | `bot-recorder-lifetime.js` |
| `closedEpochs.length > 0` | is the epoch history complete? | `epoch-reconstructor.js` |
| `!entryValueUsd` | are the deposited token amounts present? | `position-history.js` |
| `priceChangePnl` | what is the impermanent loss? | `dashboard-history.js` |

**Why they survive review and tests.** The substitute is correct *most*
of the time. It only diverges on a subset — and in this codebase the
subset was consistently "the positions this bot rebalanced itself,"
because that is the only case where a value is already known from
`rebalance_log.json`. Five of six pools looked perfect; the sixth read
8 epochs against 132 on-chain rebalances. Two of the four were also
actively **asserted** by tests, one literally checking
`key.contract === ""`. A green suite was camouflage, not protection.

**How to apply:**

- Write the condition in terms of the thing itself. "Do I have ALL of
  them?" not "do I have ANY?". "Are the amounts present?" not "is the
  value known?".
- When two needs are bundled behind one flag, split them. Both
  `lifetimeFiguresSaved` and `needsEntryFromChain` exist because the
  original single condition answered two questions at once.
- Name the derived column after what it holds. `IL/G` displaying
  `priceChangePnl` is the same error in the UI layer.
- Cross-check derived data against its source, per entity, and look for
  the row that does not match — that one query found all of these. See
  [[project_0091_burn_in_watch]] for the diagnostic script this argues
  for.

Related: [[feedback_engineering_invariants]] (a second *reader* of a
value is not the same problem as a second *resolution path*), and
[[feedback_no_heuristic_thresholds]].
