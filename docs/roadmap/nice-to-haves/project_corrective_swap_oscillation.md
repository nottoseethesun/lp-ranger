# Corrective-Swap Oscillation Guard

Corrective-swap loop can oscillate on volatile swap paths: iter 1
overshoots, later iters fail to land below the dust threshold before
the 3-iteration cap exhausts. Residual tokens are safe in wallet and
recoverable via manual Rebalance — not a failure, but a UX papercut.

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

Funds are safe and the user can manually recover via the Rebalance
button in the meantime.
