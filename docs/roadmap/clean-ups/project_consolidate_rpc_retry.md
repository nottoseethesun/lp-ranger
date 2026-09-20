# Consolidate the RPC Retry Pattern

> **Status:** Nice-to-have / internal cleanup &mdash; not a bug. Both
> retry paths work correctly. Funds are never at risk.

## Plain language

Two places in the code retry a blockchain read the same way &mdash; try
the primary RPC endpoint twice, then the fallback twice, pausing between
attempts &mdash; and each has its own copy of that logic. They differ
only in what they call and which error they raise when everything fails.

## Detail

The duplicated shape is in `src/rebalancer-pools.js` (`getPoolState`) and
`src/server-can-reopen.js` (`_readBothBalancesWithRetry`): same endpoint
list, same attempts-per-endpoint, same delay, same fresh-provider
construction, same test override hook.

A shared `withRpcRetry({ fn, ErrorClass })` helper would reduce both call
sites to a few lines. Deliberately out of scope: the write path in
`src/send-transaction.js`, which carries nonce considerations, and the
price-source cascade in `src/price-fetcher.js`, which falls back between
*data sources* rather than endpoints. Those are different concerns and
should stay separate.

## Fix when prioritized

Deferred by the project owner, who does not want a broad refactor for
some time. Until then the rule is: when a new feature needs RPC retry,
copy the closer of the two existing orchestrators rather than inventing a
third variant &mdash; that keeps the eventual consolidation a two-file
change.
