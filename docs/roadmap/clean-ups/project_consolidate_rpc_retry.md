# Consolidate the RPC Retry Pattern

> **Status:** Nice-to-have / internal cleanup &mdash; not a bug. Both
> retry paths work correctly. Funds are never at risk.

## Plain language

Two places in the code retry a blockchain read the same way &mdash; try
each configured RPC endpoint twice in turn, pausing between attempts
&mdash; and each has its own copy of that logic. They differ only in what
they call and which error they raise when everything fails.

One visible consequence today: when these retries move to another
endpoint, nothing says so in the log. The app's other endpoint changes
announce themselves, so a log can show a failed read with no sign of what
served it afterward. The read is never lost; it is only harder to follow
after the fact.

## Detail

The duplicated shape is in `src/rebalancer-pools.js` (`getPoolState`) and
`src/server-can-reopen.js` (`_readBothBalancesWithRetry`). As of
2026-10-01 the two are the same line for line: same rotated endpoint
list, same two attempts per endpoint, same three-second delay, same
paced provider construction, same reporting of every outcome &mdash;
success included &mdash; to the failover rate, same test override hook.

They differ in exactly four things, which are therefore the whole
parameter list of a shared `withRpcRetry` helper:

1. the read being performed,
2. the log tag it writes under,
3. the error class raised once every endpoint is spent,
4. the provider to fall back to when the test mock has no constructor.

Both call sites then collapse to a few lines. The work is finished when
both copies are gone, the two error classes keep their names and
signatures (callers check them by instance), the existing tests for both
paths pass unchanged, and the success path logs the endpoint and attempt
that served the read.

Deliberately out of scope: the write path in `src/send-transaction.js`,
which carries nonce considerations, and the price-source cascade in
`src/price-fetcher.js`, which falls back between *data sources* rather
than endpoints. Those are different concerns and should stay separate.

## Fix when prioritized

Deferred by the project owner until the current round of transaction-path
fixes is confirmed stable in the field. Until then the rule is: when a new
feature needs RPC retry, copy the closer of the two existing orchestrators
rather than inventing a third variant &mdash; that keeps the eventual
consolidation a two-file change.

The shared helper is also the right home for a line naming the endpoint
and attempt that succeeded, rather than adding one to each copy now.
