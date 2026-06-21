# Expand rebalance debounce so that all values survive bot restart

> **Status:** Nice-to-have — bot restarts are a major edge case (only
> for updates), not the normal flow. De-bounce surviving restart is
> polish. Daily-cap enforcement already survives via the dailyCount
> rehydrate — only the burst-protection (doubling-mode activation)
> resets across restarts.

`src/throttle.js#rehydrate(count)` (around line 259) takes only a
COUNT and sets `state.dailyCount = count`. It does NOT restore
`state.rebTimestamps`.

`_evaluateDoubling()` is the only consumer of `rebTimestamps` — it
filters for entries within `4 × minIntervalMs` to decide whether to
activate doubling. After a bot restart, `rebTimestamps = []`, so
`recent.length` is always 0 and doubling never activates from
historical events. The bot only enforces the bare `minIntervalMs`
floor until 3 NEW rebalances accumulate post-restart inside the
doubling window.

`dailyCount` IS correctly rehydrated, so the daily-max cap survives
restarts. Only the burst-protection / doubling mode resets.

## Fix sketch

- `src/throttle.js`: change `rehydrate(count)` →
  `rehydrate({ timestamps })`. Populate both
  `state.rebTimestamps = [...timestamps]` and
  `state.dailyCount = timestamps.length`. Call `_evaluateDoubling()`
  once at the end of `rehydrate` so the post-restart state correctly
  reflects any in-flight doubling activation.
- `src/bot-recorder.js` (around line 248–253): the caller already
  has the timestamps via `found.map((e) => e.timestamp * 1000)`;
  just thread them through.
- Do NOT remove the existing dailyCount-rehydration path — that
  part works correctly and must keep working.

## Context

Surfaced 2026-06-21 during a production rebalance-frequency
investigation.  The visible behaviour in that investigation turned
out to be operationally fine without this fix, because bot restarts
are infrequent in the normal flow — the throttle's
`recordRebalance()` path keeps both `dailyCount` and `rebTimestamps`
accurate in-memory through every rebalance during continuous
operation.  This issue only manifests after a bot restart, and even
then the daily cap is still enforced — only the adaptive
burst-protection (doubling mode) is silently disabled until three
new rebalances accumulate post-restart.
