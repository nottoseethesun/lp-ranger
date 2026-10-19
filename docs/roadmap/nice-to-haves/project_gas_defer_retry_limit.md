# Gas-Defer Retry Limit

> **Status:** Nice-to-have / polish — not a bug. Funds are never at
> risk, and the waiting costs no gas.

When a rebalance's estimated gas would cost more than
`rebalanceGasDeferPct` of the position's value (0.5% as shipped), the
bot waits `gasDeferRetrySec` (one hour as shipped) and looks again
(`nextCheckDelayMs`, `src/bot-loop-scheduler.js`). Nothing caps the
number of looks. A position too small for gas ever to fall under the
threshold is looked at once an hour, forever.

## Why this is not required

- **No gas spent.** Each look is one `getFeeData()` call and price
  lookups for the native token and the position's two tokens. No
  transaction is sent.
- **The operator has a clean way out.** LP Browser → Remove (described
  in the FAQ) ends the bot loop for that position. To manage it again
  later, for example once it has grown or gas has dropped, scan the
  wallet, select the position and click Manage.
- **Symmetry with other deferral gates.** Throttle, daily cap, and
  out-of-range threshold gates also retry indefinitely — they're
  not "bugs that never give up," they're standard control-loop
  behavior.

## Possible design when prioritized

- A configurable cap on the looks, for example `gasDeferMaxRetries: 24`
  (a day of hourly looks) in `bot-config-defaults.json`, with its range
  in `setting-bounds.json`.
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
