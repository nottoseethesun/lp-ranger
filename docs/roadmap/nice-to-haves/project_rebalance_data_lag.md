# Avoid Edge-Case, Temporary Lag in Rebalance Data

## Plain language

When a rebalance happens, the scanner sometimes fails to record it
because the previous position it needs to pair with is sitting in
the disk cache.

## Mechanics

Edge case in the rebalance event scanner during *incremental*
(cache-warm) scans, self-documented at `src/event-scanner.js`.

`pairTransfers()` has two passes:

- **Pass 1:** classic burn+mint pairing (out-transfer followed by
  in-transfer within a 5-min window).
- **Pass 2:** consecutive-mint pairing for the rebalancer's
  drain-old / mint-new flow — pairs `mints[i-1]` (drained old) with
  `mints[i]` (fresh new).

On an incremental scan, only new blocks since the last cache write
are fetched. If a new rebalance mint lands but its predecessor mint
lives only in `cachedEvents` (from a prior scan window), Pass 2 has
no `mints[i-1]` to pair against — so the new rebalance produces zero
pairs.

**Visible symptom:** the diagnostic log fires:

```text
[event-scanner] WARN: N new mint(s) produced 0 rebalance pairs; tokenIds=...
```

## Current mitigation

Event cache is invalidated after every successful rebalance
(`clearPoolCache` in `bot-loop.js`), forcing a full re-scan that
paints the gap. So in normal bot operation it self-heals next cycle.
The gap only matters in edge timing where the table is read before
the next scan completes — hence "temporary lag".

## Fix when prioritized

When Pass 2 finds an unpaired new mint and `cachedEvents` is
non-empty, look up the latest cached mint for the same pool and use
it as the `mints[i-1]` predecessor. Pure additive — doesn't touch
happy-path code.
