# Avoid Edge-Case, Temporary Lag in Rebalance Data

> **Status:** Nice-to-have / polish — not a bug. The app works
> correctly without this. Funds are never at risk. The condition
> below self-heals within 30 minutes.

## Plain language

A rebalance can take about half an hour to appear in the Rebalance
Events table. Nothing has gone wrong when this happens: the rebalance
itself completed normally and every figure that depends on it is
correct. The scanner simply could not pair the new position with its
predecessor on that pass, because the predecessor was already in the
disk cache rather than in the blocks it had just read. The next scan
pairs them and the row appears.

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

The scanner says so plainly in the log &mdash; informational, not a
failure:

```text
[event-scanner] WARN: N new mint(s) produced 0 rebalance pairs; tokenIds=...
```

## How long the gap lasts

After a rebalance the bot sets `_needsFullRescan`
(`src/bot-recorder.js`). That flag is acted on by `lifetimeRescanTimer`
in `src/bot-loop.js`, a `setInterval` running every **30 minutes**
(`LIFETIME_RESCAN_CHECK_MS`), which runs the event scan and the
lifetime scan together and repaints the missing pair.

So the gap closes on its own, but the window is up to half an hour
&mdash; not one poll cycle. The dashboard's 3-second poll does not
shorten it: that re-reads `/api/status` and re-renders what the server
already holds, it does not re-run the scanner.

What shapes a fix: the event cache is **not** invalidated on rebalance.
`clearPoolCache` runs only from `src/server-reload-position.js`, the
Reload Current Position handler. Invalidating it on a successful
rebalance would shorten the window considerably, so establishing
whether that invalidation was intended is worth doing
before picking a fix: restoring it would close the gap directly and is
a smaller change than the Pass&nbsp;2 work below.

## Fix when prioritized

When Pass 2 finds an unpaired new mint and `cachedEvents` is
non-empty, look up the latest cached mint for the same pool and use
it as the `mints[i-1]` predecessor. Pure additive — doesn't touch
happy-path code.
