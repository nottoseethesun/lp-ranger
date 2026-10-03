---
name: project_initial_residual_zero_price_persisted
description: "OPEN: when the historical price API fails, the initial-mint residual is persisted with both prices at $0 and never re-fetched. The subtraction that excludes the initial leftover from Lifetime Net P&L then removes nothing, so the leftover is counted as LP profit."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T17:33:08.108Z
---

Found 2026-10-03 in the whole-app audit for the conflation behind
[[project_speedup_phase_boundary_race]]. **Not fixed.** Third instance,
with [[project_hodl_baseline_zero_from_rpc_failure]] and
[[project_nft_gas_zero_from_rpc_failure]].

## What happens

`ensureInitialResidualData` (`src/liquidity-pair-details.js`) records
what the wallet still held right after the position's very first
deposit. It reads two things: the balances at that block from the chain,
and their USD prices at that block from GeckoTerminal.

The two halves handle failure in opposite ways, which is what marks this
as an oversight rather than a decision:

```js
const balances = await _fetchInitialBalances({…});
if (!balances) return null;              // correct: nothing is persisted
const prices = await _fetchInitialPrices({…});   // returns {0, 0} on failure
…
_cache[scopeKey].initialResidualData = data;      // zeros written
_persist();
```

`_fetchInitialBalances` returns `null` and the function aborts, so a
chain read that failed leaves no record. `_fetchInitialPrices` returns
`{ token0Price: 0, token1Price: 0 }` — its own JSDoc says "degrades to
zeros on failure" — and those zeros go straight into the persisted
entry, unchecked.

**And it is never re-fetched.** The function is documented as
idempotent: a populated cache entry is returned untouched. So one
GeckoTerminal failure, on one call, fixes a price of zero for the life
of the install. Nothing distinguishes it from a token that was genuinely
worthless.

## What it costs

Per CLAUDE.md this figure is "subtracted from the live Wallet Residual
figure so Lifetime Net P&L reflects only residuals produced by
subsequent rebalances/compounds, not the unavoidable leftover from the
initial mint." With both prices at zero the subtraction removes nothing,
so the initial-mint leftover is counted as though the LP earned it.
Lifetime Net P&L is overstated by its value, permanently.

The error is largest exactly where the figure was introduced to help:
low-liquidity pairs, whose rebalance swaps leave material residuals. On
a high-liquidity pair the leftover is near nothing and so is the error.

The dashboard also surfaces the initial residual as its own Lifetime line
item, which reads $0.00 beside non-zero amounts — visible, if anyone
looks for it.

## The shape a fix takes

Make the price half behave like the balance half. `_fetchInitialPrices`
returns `null` when the lookup failed, the caller declines to persist,
and the next call tries again — which is all the existing early-return
already does for balances.

A zero price that the API genuinely reported is a different answer and
may be recorded, so the distinction has to come from the fetch, not from
testing the number afterwards.

[[feedback_dont_persist_a_correction]]: the question is whether the
wrong value should be written at all. Here it should not. And no repair
pass over entries already on disk — a persisted zero is indistinguishable
from a true one after the fact, and the cache is rebuilt from chain when
deleted.
