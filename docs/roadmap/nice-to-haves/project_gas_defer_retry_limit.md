# Gas-Defer Retry Limit

> **Status:** Nice-to-have / polish — not a bug. The app works
> correctly without this. Funds are never at risk. Strictly
> optional: the retry loop consumes no gas (RPC poll + price fetch
> only), and the user always has a clean halt path via the LP
> Browser.

When a managed position's estimated gas cost exceeds 0.5% of the
position's USD value, the bot defers the rebalance and reschedules
itself 1 hour later (`GAS_DEFER_MS = 3600_000` in `src/bot-loop.js`).
There is no cap on the number of retries — for very small
positions where gas cost will never drop below the 0.5% threshold,
the loop continues indefinitely, retrying once an hour forever.

## Why this is not required

- **No gas spent.** Each retry consists of a single `provider.getFeeData()`
  call plus a price fetch for the position's two tokens. No
  transactions are submitted to the chain, so the loop is effectively
  free.
- **User has a clean escape hatch.** The LP Browser → Remove flow
  (documented in the FAQ) terminates the bot loop for that position.
  Re-scan + double-click re-adds it when the user wants to manage
  it again — for example after the position grows in value or gas
  prices drop.
- **Symmetry with other deferral gates.** Throttle, daily cap, and
  out-of-range threshold gates also retry indefinitely — they're
  not "bugs that never give up," they're standard control-loop
  behavior.

## Possible design when prioritized

- Configurable retry cap (e.g. `MAX_GAS_DEFER_RETRIES = 24` for one
  day of attempts) read from `bot-config-defaults.json`.
- On cap reached: surface a one-time Telegram notification ("Position
  #X cannot rebalance under current gas conditions"), set a
  dashboard banner, and stop further polling. The user can manually
  re-arm via the Manage toggle or Rebalance Now button.
- Default value chosen to keep the loop forgiving — gas can swing
  significantly over a day, and an aggressive cap could prematurely
  give up on a position that would naturally clear the threshold.

## Why deferred

The behavior is benign and self-documenting in the server log
(`[bot] Gas too high: $X is Y% of position ($Z) — deferring` plus
`[bot] Next retry in 60m`). Adding a cap is purely a UX nicety for
operators who don't want to see the log churn indefinitely.
