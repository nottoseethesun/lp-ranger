# Expand rebalance debounce so that all values survive bot restart

> **Status:** Nice-to-have — not a bug. It matters only after a restart,
> which in normal running happens only for an update. The daily cap
> already survives one.

After a restart the throttle remembers how many rebalances happened
today, but not when. Doubling mode, the burst protection that lengthens
the wait between rebalances when they come close together, needs the
times, so it cannot switch on again until enough new rebalances have
happened since the restart. Until then only the plain Min Time Between
Rebalances holds.

## Detail

`rehydrate(count)` in `src/lib/throttle.js` takes only a count and sets
`state.dailyCount = count`. It does not restore `state.rebTimestamps`.

`_evaluateDoubling()` is the only reader of `rebTimestamps`. It counts
the entries inside the trigger window
(`throttleDoubling.triggerWindowMultiple` × the minimum interval) and
switches doubling on at `throttleDoubling.triggerCount` of them (four
and three as shipped). After a restart `rebTimestamps` is empty, so
doubling cannot activate from the day's earlier rebalances.

During continuous running nothing is lost: `recordRebalance()` keeps
both `dailyCount` and `rebTimestamps` current at every rebalance.

## Fix sketch

- `src/lib/throttle.js`: change `rehydrate(count)` →
  `rehydrate({ timestamps })`. Set both
  `state.rebTimestamps = [...timestamps]` and
  `state.dailyCount = timestamps.length`, then call
  `_evaluateDoubling()` once, so the state after a restart reflects any
  doubling the day's rebalances had already triggered.
- `src/lib/bot-recorder.js`, where it calls `throttle.rehydrate`: it
  already filters the found events to today's; map those to
  `e.timestamp * 1000` and pass the list.
- Keep the daily-count rehydration working; that part is correct.

## Context

Surfaced 2026-06-21 during a production rebalance-frequency
investigation, where the behaviour turned out to be fine in practice,
because restarts are rare.
