---
name: project_pnl_accounting_model
description: "Settled definitions for Fees, IL/G, Profit and Net P&L, agreed with the user on 2026-09-03 and shipped in 0.9.2. IL/G is divergence only; fee earnings are counted once, in Profit."
metadata:
  node_type: memory
  type: project
---

Four figures, settled after a long back-and-forth. Do not re-derive
these from scratch; check code against them.

## The invariant

**IL/G contains no fees.** It is a difference:

```text
IL = (LP value − compounded fees + wallet residual)
     − (deposited amounts × today's prices)
```

Compounding calls `increaseLiquidity`, so compounded fees become part of
the liquidity the LP-value term measures, while the deposited amounts
never grow. Leaving them in reports reinvested earnings as LP
outperformance. This matches the standard definition — the closed form
`2·√r/(1+r) − 1` has no fee term, which is why the usual phrasing is
"impermanent loss is offset by fees."

## The four figures

- **Fees** — everything the position earned, whether compounded away or
  still unclaimed. Per NFT that is `Σ(Collect) − Σ(drained principal)`;
  `lifetimeFeeAmounts` in src/compounder.js is the single definition.
- **IL/G** — as above. Two variants: lifetime removes
  `totalCompoundedUsd`; current-NFT removes only that NFT's share, since
  its mint value already contained the earlier ones.
- **Profit** — `unclaimed + compounded − gas ± IL/G`. Both fee figures
  are *added*, and land exactly once because IL/G holds neither. Per-Day
  is the closed-epoch form: `fees − gas ± IL`, where the epoch's IL is
  `(exitValue − fees) − hodlAtExit`.
- **Net P&L** — reduces to `exit − entry − gas` per period. Fees are
  already inside `exitValue`; the `+fees` and the `−fees` inside
  `priceChangePnl` cancel. It must not move when a fee figure is
  corrected — a useful control.

## Two traps

- `exitValue` is the NFT's final **Collect**, which returns principal
  *plus* accrued fees. It is not the drained principal. Proof from
  chain: one position's principal side was 0 and Collect still returned
  45,039,018,382 units of token0, all of it fee.
- Per-day columns do not sum to their Lifetime counterparts, and that is
  not a bug. `Σ(exit − entry)` telescopes only if each period starts
  where the last ended; value moves to and from the wallet between them,
  which is exactly what the **In/Out** column measures.

Shipped in 0.9.2 across PRs #196, #198, #199. See
[[project_0092_burn_in_watch]].
