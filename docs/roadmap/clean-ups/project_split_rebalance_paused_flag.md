# Split the Overloaded Rebalance-Paused Flag

> **Status:** Nice-to-have / internal clarity &mdash; not a bug. Both
> behaviours are correct today. Funds are never at risk.

## Plain language

One internal flag, `rebalancePaused`, is set by two situations that mean
different things to an operator: a rebalance the bot **abandoned** because
the swap would have cost too much, and a rebalance the bot **paused**
after retrying a volatile pool until it ran out of attempts. The first
needs a decision from you; the second may clear on its own.

## Detail

The abort path is `_handleError` in `src/bot-loop.js`, which fires when a
swap quote's price impact exceeds the configured slippage &mdash;
recovering almost always needs the operator to change something. The
pause path is `_activateSwapBackoff` in `src/bot-cycle-backoff.js`, which
backs off exponentially and only pauses after exhausting its retry
budget.

Both converge on the same downstream gate and the same "RETRYING" badge,
so the *behaviour* need not split &mdash; only the name, which currently
makes correct prose hard to write about either case.

## Fix when prioritized

Introduce `rebalanceAborted` for the swap-abort writer and leave
`rebalancePaused` to the backoff writer; make the gate check either;
clear both wherever one is cleared today, including the slippage-change
handler and the key-migration path; and give the dashboard badge distinct
wording per case. Roughly fifteen source files, several tests, and one
field in the `/api/status` payload &mdash; a coordinated server and
browser change, but they ship together. Worth its own pull request so the
rename is reviewable on its own rather than buried in a feature.
