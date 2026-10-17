---
name: project_failed_aggregator_gas_dropped
description: "OPEN BUG (found 2026-10-17): gas a failed aggregator attempt spent — its approval, its cancels — is dropped from the record when the V3 router fallback then swaps"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T07:05:30.167Z
---

**Open bug, found 2026-10-17 in the branch audit, not fixed.** When the
aggregator path fails and `swapIfNeeded` falls back to the V3 router, the
gas the failed attempt already paid is not counted anywhere: the
aggregator's approval (`aggApprovalGas`) and any cancels it sent
(`err.cancelGasCostWei`). The router's result carries only its own gas.
`cancelGasCostWei` is read only when the whole rebalance fails
(`src/rebalancer.js`), never on a fallback that succeeds.

What an operator sees: the rebalance's gas, the open period's gas in the
Per-Day table and the lifetime gas all read low by that amount. The
coins were really spent.

**Why:** found while auditing the swap path's state. It is accounting,
not fund safety: no balance is swapped twice.

**How to apply:** the fix is to carry the failed attempt's gas on the
error and add it to whatever the fallback returns, in `swapIfNeeded`
(`src/rebalancer-swap.js`), the one place both are in hand. Ask the user
before fixing; it changes recorded gas. Related:
[[project_aggregator_swap_wait_double_swap]].
