---
name: Show swap route even if only blockchain data available
description: Nice-to-have — chain-scanned events have no swapSources so "Routed Via" shows em-dash; fetch tx receipts to recover the route from on-chain data alone
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-24T05:24:12.741Z
---
## Plain language

When the bot rebalances live, it knows which router did the swap
(9mm Aggregator, V3 Router, etc.) and stores it. But when the
scanner reconstructs old rebalances from the blockchain — say on a
fresh install or a second machine — it only sees the Transfer logs,
which don't say which router was used. So the "Routed Via" column
shows an em-dash (—) for those rows.

Renamed from "Route Via column empty for chain-scanned rebalance
events" on 2026-04-29 to make the goal (recovery from blockchain
data alone) the title.

## Detail


Rebalance events reconstructed by `src/lib/event-scanner.js :: scanRebalanceHistory` lack a `swapSources` field — on-chain Transfer logs don't carry route info. `src/client/web/dashboard-history.js` renders these as em-dash in the "Routed Via" column. Same gap when a rebalance doesn't show up in the gui log at all on a fresh install / second machine, because the live `appendToPoolCache` path only runs on the install that executed the rebalance.

**Why:** Pre-existing behavior, not a bug. Production install (where rebalances actually happen) always shows correct route info via the live path. Only dev-mirror or fresh-install views see the gap.

**How to apply:** Do not fix preemptively. If the user asks about empty "Routed Via" cells, missing entries across machines, or wants richer historical display, the path is to fetch the receipt for each scanned tx and decode which router/aggregator contract was called. Adds RPC load to the 5-year scan — weigh cost vs UX value.
