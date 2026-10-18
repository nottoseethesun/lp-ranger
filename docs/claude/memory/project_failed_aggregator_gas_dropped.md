---
name: project_failed_aggregator_gas_dropped
description: "FIXED 2026-10-17 (uncommitted): gas a failed aggregator attempt paid — approvals, reverted swaps, cancels — was dropped from the record when a fallback swapped or the move failed"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T19:49:16.123Z
---

**Fixed 2026-10-17, uncommitted.** Was: a failed aggregator attempt can
pay for an approval, a swap that reverts on chain, and a cancel, and none
of it reached the record. The approval was added only to a swap that
landed, a reverted swap counted as nothing, the cancels rode an error
that the switch to the V3 router discarded, and a failed rebalance
recorded gas only when the failure was a cancel. The rebalance's gas, the
open period's gas in the Per-Day table and the lifetime gas all read low.

**The user's ruling, 2026-10-17:** "of course, all gas spent needs to be
added in." Earlier the same day they had disputed the finding as the
aggregator swapping; it never claimed that, and the explanation that
settled it named the three transactions and why each is paid for.

**What changed:**
- One field, `gasCostWei`, on whatever an attempt ends with: the result,
  or the thrown error. `src/spent-gas.js` holds the add and read helpers
  and `recordSpentGas`. The cancel error from `tx-speedup.js` uses the
  same field, which replaced `cancelGasCostWei`.
- Each layer adds only what it paid: the retry loop its reverted swaps
  and cancels (including a cancel whose own wait gave up but which the
  chain shows mined, via `settleNonce`'s `spentGasWei`), the aggregator
  its approvals, the chunked swap its earlier chunks, and `swapIfNeeded`
  the routes it gave up on.
- A failed rebalance records the figure whether or not anything was
  cancelled (`bot-cycle.js`), and so does a failed compound
  (`bot-cycle-compound.js`), which recorded nothing before.

Tests: `test/failed-attempt-gas.test.js` and `test/spent-gas.test.js`;
19 mutations each failed a test.

**Not covered, open as a question:** the V3 router's own approval when
its quote then fails, a transaction that reverts through
`sendTx.sendTransaction`, and a swap that landed before a later step
failed (PROJECT-STATE). Related: [[project_aggregator_swap_wait_double_swap]],
[[project_reverted_receipt_reads_as_confirmed]].
