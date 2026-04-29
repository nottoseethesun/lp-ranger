# Dashboard State Cleanup

After fixing the `_poolFirstDate` sticking-across-pools bug, there
are likely more dashboard module-level caches that mirror per-poll
data and could leak across position/pool switches the same way.

## Candidates flagged for later

All in `public/`:

- `dashboard-data.js` — `_lastStatus`, `_historyPopulated`,
  `_configSynced`
- `dashboard-data.js` — `_scanWasComplete` (derivable from
  `data.rebalanceScanComplete`)
- `dashboard-il-debug.js` — `_lastData`
- `dashboard-history.js` — `_lastEvents`
- `dashboard-price-override.js` — `_lastPrices`
- `dashboard-positions-store.js` — `_allPositionStates`

DI slots (`let _pollNow = null` etc.) are a different pattern —
leave them.

## Triage rule

"Does this cache mirror what the next poll already carries, AND does
it leak across position/pool switches?" — same test that nailed
`_poolFirstDate`.
