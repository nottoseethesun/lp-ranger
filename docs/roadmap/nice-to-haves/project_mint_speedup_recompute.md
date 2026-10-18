# Mint Speed-Up Recompute

> **Status:** Nice-to-have / polish — not a bug. Funds are never at
> risk: a reverted mint costs only its gas and leaves the coins in the
> wallet for the next rebalance attempt. Seen only on extremely volatile
> pairs (fee tier 20000).

A mint that waits too long to be included can revert, because the
pool's price moved while it waited. When a mint is stuck, the speed-up
(`_waitOrSpeedUp`) resends the same transaction at higher gas, with the
amounts fitted to the price at the time it was first built. If the
price has drifted, those amounts fail the position manager's slippage
check on `amount{0,1}Min`, and the speed-up reverts too.

The fix: before resending, re-read the pool and recompute
`amount0Desired`, `amount1Desired`, `amount0Min` and `amount1Min` from
the fresh price. The aggregator swap already does the equivalent,
cancelling and re-quoting a stale swap (`_sendWithRetry` in
`rebalancer-aggregator.js`).

## Why

On super-volatile pairs (e.g. ICSA/eICSA, fee tier 20000), a mint can
sit about five minutes between submission and inclusion. A speed-up
that reverts this way gives no decoded reason: status 0, about 190,000
gas used, no logs.

## Observed example

NFT #159071, replacement TX
`0x10477f8833ce807f2f3f5ecd56031d4565da95b07b585ae9b413911b1e3f403f`,
block 26377316.

## Fix when prioritized

Use the swap path's `_sendWithRetry` cancel-and-requote pattern as
the model. Revisit if (a) a less-volatile pool starts hitting this,
or (b) we see a cluster of mint-revert reports.
