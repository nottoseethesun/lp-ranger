# Mint Speed-Up Recompute

When `_waitOrSpeedUp` bumps gas on a stuck mint TX, also re-snapshot
the pool and recompute
`amount0Desired/amount1Desired/amount0Min/amount1Min` from the fresh
sqrt price before resubmitting. Today the mint speedup only bumps
gas; the swap path already does cancel-and-requote on staleness
(`_sendWithRetry` in `rebalancer-aggregator.js`).

## Why

On super-volatile pairs (e.g. ICSA/eICSA, fee tier 20000), a mint
can sit ~5 min between submission and inclusion. If the pool drifts
during that window, the originally-fitted amounts violate the
manager's slippage check on `amount{0,1}Min` and the speedup TX
reverts with no decoded reason (status=0, ~190k gasUsed, empty
logs).

## Observed example

NFT #159071, replacement TX
`0x10477f8833ce807f2f3f5ecd56031d4565da95b07b585ae9b413911b1e3f403f`,
block 26377316.

## Fix when prioritized

Use the swap path's `_sendWithRetry` cancel-and-requote pattern as
the model. Revisit if (a) a less-volatile pool starts hitting this,
or (b) we see a cluster of mint-revert reports.
