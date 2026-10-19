# Corrective-Swap Oscillation Guard

> **Status:** Nice-to-have / polish — not a bug. Funds are never at
> risk: any leftover coins stay in the wallet.

After a rebalance's main swap, the bot runs up to
`correctiveSwapMaxRounds` corrective swaps (three as shipped) to bring
the coins to the new range's ratio, stopping once the imbalance is below
the dust threshold. On a volatile swap path the rounds can oscillate:
the first overshoots, and the later ones fail to get under the dust
threshold before the rounds run out. The leftover stays in the wallet
as a residual. If it is over five percent of the position and residual
combined, the automatic residual cleanup rebalances once more ten
minutes later (both figures as shipped); Rebalance Now sweeps it at
once. A papercut, not a failure.

## Observed example

Rebalance #159045 → #159049:

- Main swap: aggregator aborted (2.12% > 1.75% slip), V3 router
  fallback succeeded at 0.92%.
- Corrective iter 1 overshot to ~$170 imbalance.
- Iter 2 recovered.
- Iter 3: aggregator aborted again (2.34% > slip), V3 fallback →
  $2.71 residual above $0.99 dust threshold → 3 iterations
  exhausted, residual left.

## Possible angles

- Shrink corrective-swap size when prior iter overshot.
- Widen the tolerance band as iterations progress.
