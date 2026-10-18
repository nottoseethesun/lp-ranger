# Show Swap Route Even If Only Blockchain Data Available

> **Status:** Nice-to-have / polish — not a bug. The app works
> correctly without this. Funds are never at risk. Production
> installs always show the route correctly via the live path; the
> em-dash only appears in dev-mirror or fresh-install views.

## Plain language

When the bot rebalances live, it knows which router did the swap
(Watergun Aggregator, V3 Router, etc.) and stores it. But when the
scanner reconstructs old rebalances from the blockchain — say on a
fresh install or a second machine — it only sees the Transfer logs,
which don't say which router was used. So the "Routed Via" column
shows an em-dash (—) for those rows.

## Detail

Rebalance events reconstructed by `src/event-scanner.js ::
scanRebalanceHistory` lack a `swapSources` field — on-chain Transfer
logs don't carry route info. `public/dashboard-history.js` renders
these as em-dash in the "Routed Via" column. The live path that does
record the route, `appendToPoolCache`, runs only on the install that
made the rebalance, so another machine, or a fresh install, gets every
earlier row from the scanner, with an em-dash in each.

## Fix when prioritized

Fetch the receipt for each scanned tx and decode which
router/aggregator contract was called. Adds RPC load to the 5-year
scan — weigh cost vs UX value.
