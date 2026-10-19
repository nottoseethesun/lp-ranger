# Avoid Edge-Case, Temporary Lag in Rebalance Data

> **Status:** Nice-to-have / polish — not a bug. Funds are never at
> risk. When this was written the condition cleared by itself within
> half an hour; the scan's timing has changed since, so how it clears
> now is still to be measured (see "How long the gap lasts").

## Plain language

A rebalance could take up to half an hour to appear in the Rebalance
Events table. Nothing has gone wrong when this happens: the rebalance
itself completed normally and every figure that depends on it is
correct. The scanner simply could not pair the new position with its
predecessor on that pass, because the predecessor was already in the
disk cache rather than in the blocks it had just read. A later scan
paired them and the row appeared.

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

This section described the code before a change, and the gap has not
been re-measured since. It said: after a rebalance the bot sets
`_needsFullRescan` (`src/bot-recorder.js`), and `lifetimeRescanTimer`
in `src/bot-loop.js`, a `setInterval` running every **30 minutes**
(`LIFETIME_RESCAN_CHECK_MS`), acts on it by running the event scan and
the lifetime scan together, which repaints the missing pair. So the gap
closed by itself within half an hour.

Now a successful rebalance starts that scan at once (`_triggerScan` at
the end of `_handleRebalanceSuccess`, `src/bot-cycle.js`), and the
30-minute timer only retries a lifetime scan that has not finished. The
immediate scan is still incremental, so it can meet the same pairing
gap, and a lifetime scan that completes no longer leaves the timer
anything to retry. Whether, and when, the row now appears has to be
measured before this entry is acted on.

The dashboard's 3-second poll does not shorten the gap either way: it
re-reads `/api/status` and re-renders what the server already holds; it
does not re-run the scanner.

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
