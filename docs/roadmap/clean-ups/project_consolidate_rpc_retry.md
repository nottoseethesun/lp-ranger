# Consolidate the RPC Retry Pattern

> **Status:** Done. Kept as the record of what was merged and of what
> deliberately stays separate.

## Plain language

Two blockchain reads used to carry their own copies of one retry rule:
the pool's state, which every poll needs, and the wallet's two coin
balances, which the check before re-opening a closed position reads.
Each tried every rpc endpoint in turn, pausing between attempts, and
neither logged which endpoint finally answered.

Both now go through one loop, `retryRead` (`src/rpc-read-retry.js`).
When a retried read succeeds, the loop logs one line naming the endpoint
that served it and whether that is the endpoint that had been failing.

## What each caller passes

`getPoolState` (`src/rebalancer-pools.js`) and
`_readBothBalancesWithRetry` (`src/server-can-reopen.js`) each hand the
loop their own read, as `run(provider)`, so a read made of several calls
keeps all of them on one endpoint. Each also passes its log tag and the
error to raise once every attempt has failed; callers check those errors
by class. The bound is shared: `boundedReadAttemptsPerEndpoint` tries
per endpoint, `boundedReadRetryDelayMs` apart, both in
`bot-config-defaults.json`.

## Still separate, deliberately

The write path in `src/send-transaction.js` carries nonce
considerations. The price-source cascade in `src/price-fetcher.js` falls
back between *data sources* rather than endpoints. Neither belongs in
this loop. A new read that needs a retry calls `retryRead` rather than
writing a third copy.
