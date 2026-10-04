---
name: project_initial_residual_zero_price_persisted
description: "FIXED 2026-10-04: a failed historical-price lookup left the first-deposit leftover valued at $0 with no way back, so the subtraction that excludes it from Lifetime Net P&L removed nothing. Reload Position and Re-scan Prices now re-read and overwrite it. The bad write itself is deliberately left in place — the operator's two repair actions are the cure."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-04T07:01:09.302Z
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

## The fix, 2026-10-04 — and what it deliberately is not

**Operator decision: the bad write stays.** A failed lookup still stores
$0. What was missing was any way back, and the operator named the two
actions that should provide it — Reload Position and Re-scan Prices — and
scoped the fix to exactly that.

The scan carries "fresh prices were asked for" down to this figure, which
re-reads and **overwrites** it.

**Which request it keys off is the whole correctness of this.** Two
different things reach the scan. "Recompute the saved figures" is what a
rebalance asks for, and it must — a new NFT means those figures no longer
describe the chain. "Re-value them at fresh prices" is what only a repair
asks for. The first version keyed the re-read to either, which fired it
after every rebalance: a cache-bypassing lookup, against a quota-limited
service, for a price that cannot change — the leftover and the day it was
left on are fixed history, which is why that price is cached with no
expiry in the first place. Up to fifty needless lookups a day across ten
positions.

So it keys off the fresh-prices request alone, and **Reload Position now
raises that too.** Reload already meant it: every figure it rebuilds is an
amount times a price. It simply never said so, and this is the one figure
that reads the saying rather than the rebuilding.

Pinned by two cases in `test/bot-recorder-scan-and-reconstruct.test.js` —
a recompute must not bypass the price cache, a repair must. The first
fails with the over-broad condition restored.

**Overwrite, never clear — and this was got wrong first.** The first
attempt added a cache-clearing function and called it from both routes.
That breaks [[feedback_never_clear_to_force_a_recompute]], and the sibling
route's own file header says why in terms of this very system: a figure
cleared to force a rebuild is absent while the rebuild runs, and something
reads that gap as settled. Overwriting leaves the old value standing until
its replacement exists, so a failed re-read costs nothing. The clearing
version was reverted before it was committed.

**The refresh reaches the price lookup too.** Dropping or ignoring the
cached entry alone would not have been enough: a historical price is
cached with no expiry, so the re-read would be served the same wrong
number and the figure would be "reloaded" and unchanged. The missing-price
case would have worked either way, because a zero is never cached — but
the wrong-price case is the one Re-scan Prices exists for.

## One consequence, accepted

Issue 2 was left alone because a restart fixes it with nothing asked of
the operator. This one heals only if someone notices and acts, so a first
failed lookup on a fresh install is silently wrong until then. Raised
once, scoped out, recorded here so it is not rediscovered as a finding.

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
