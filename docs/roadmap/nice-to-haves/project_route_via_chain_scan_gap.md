# Show Swap Route Even If Only Blockchain Data Available

## Plain language

When the bot rebalances live, it knows which router did the swap
(9mm Aggregator, V3 Router, etc.) and stores it. But when the
scanner reconstructs old rebalances from the blockchain — say on a
fresh install or a second machine — it only sees the Transfer logs,
which don't say which router was used. So the "Routed Via" column
shows an em-dash (—) for those rows.

## Detail

Rebalance events reconstructed by `src/event-scanner.js ::
scanRebalanceHistory` lack a `swapSources` field — on-chain Transfer
logs don't carry route info. `public/dashboard-history.js` renders
these as em-dash in the "Routed Via" column. Same gap when a
rebalance doesn't show up in the GUI log at all on a fresh install /
second machine, because the live `appendToPoolCache` path only runs
on the install that executed the rebalance.

## Status

Pre-existing behavior, not a bug. Production install (where
rebalances actually happen) always shows correct route info via the
live path. Only dev-mirror or fresh-install views see the gap.

## Fix when prioritized

Fetch the receipt for each scanned tx and decode which
router/aggregator contract was called. Adds RPC load to the 5-year
scan — weigh cost vs UX value.
