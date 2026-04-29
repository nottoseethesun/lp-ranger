# Historical Compound Log Backfill

Currently, compound events appear in the Activity Log **only when
the app is running at the time of the compound** (live-runtime path:
`bot-cycle-compound` writes `lastCompoundAt`, dashboard's
`_logCompound` in `dashboard-data-events.js` fires the entry).

Historical compounds that pre-date the running session land in
`state.compoundHistory` (via `bot-recorder._classifyAllCompounds`)
but **never show in the Activity Log**. They are still counted in
P&L and the "Fees Earned" KPI.

**Why:** No `_populateCompoundHistoryOnce` equivalent to
`_populateHistoryOnce` (which backfills rebalance events from
`data.rebalanceEvents` once `rebalanceScanComplete === true`).

## Proposed approach

Read each compound's blockchain transaction directly to
detect/classify, rather than mirroring the rebalance scanner
pattern. Likely easier than re-using the IncreaseLiquidity/Collect
inference pattern.

## Where to add

`dashboard-data.js` near `_populateHistoryOnce`, with a parallel
one-shot latch keyed on `compoundHistory.length > 0` and the same
sync-complete gate.
