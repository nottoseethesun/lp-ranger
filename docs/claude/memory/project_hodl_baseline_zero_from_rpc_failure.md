---
name: project_hodl_baseline_zero_from_rpc_failure
description: "OPEN: an endpoint that will not serve the mint receipt is recorded as 'this position was opened with zero of both tokens'. The baseline looks complete, so it is never retried — IL/G then reports a gain the size of the whole position, and the Impermanent Loss Guard stops evaluating for that position permanently."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T17:28:19.704Z
---

Found 2026-10-03 auditing for the same conflation as
[[project_speedup_phase_boundary_race]]: an rpc-level failure recorded
as a blockchain-level fact. **Not fixed.**

## What happens

`_readMintedAmounts` (`src/hodl-baseline.js`) reads the mint
transaction's receipt to learn how much of each token the position was
opened with. On an endpoint failure, and equally on a `null` receipt
from an endpoint that is behind or pruned, it returns

```js
{ hodlAmount0: 0, hodlAmount1: 0, mintGasWei: "0" }
```

The caller does not treat that as a failure, because it does not look
like one. It builds a complete baseline around it — `mintDate` and
`mintTimestamp` come from the event log rather than the receipt, so they
are correct — and persists it. Nothing distinguishes "opened with
nothing", which is impossible, from "the endpoint would not say".

**And it is never retried.** `initHodlBaseline` returns early unless the
baseline needs a mint timestamp or needs a price:

```js
const needsPrice =
  botState.hodlBaseline &&
  !(botState.hodlBaseline.entryValue > 0) &&
  (botState.hodlBaseline.hodlAmount0 > 0 ||
    botState.hodlBaseline.hodlAmount1 > 0);
```

That retry exists for the case where the amounts read fine and the
historical price lookup failed, and it requires one amount to be
positive — which is exactly what the receipt failure does not leave
behind. So the zero case is excluded from the one path that would fix
it, on every restart, indefinitely. Only a manual Reload Position
clears it.

## What it costs

**IL/G reports a gain the size of the entire position.**
`computeHodlIL` (`src/il-calculator.js`) guards `hodlAmount0` and
`hodlAmount1` against `null` and `undefined` but not against both being
zero, so `hodlValue` is 0 and `IL = lpValue + residual − 0`. On a
$5,000 position the operator is shown roughly +$5,000 of impermanent
gain, in a panel they use to decide whether to stay in the pool.

**The Impermanent Loss Guard stops guarding that position.**
`evaluateIlGuard` correctly refuses a non-positive baseline
(`originalValueUsd <= 0` → `allow("no-original-value")`), so it is not
computing anything wrong — it simply never evaluates. Fail-open is the
right behaviour for a baseline that has not resolved, but this one has
resolved, to a lie, so the guard is off for the life of the position
rather than until the next scan. The only sign is one
`ILG not evaluated (no-original-value) — allowing rebalance` line per
poll cycle. The guard exists to stop the bot crystallizing a loss by
re-minting around a collapsed price, so what is lost is the protection,
not a number on a screen.

## The shape a fix takes

The two answers have to stop being the same value. A receipt that could
not be read is not an amount of zero, so `_readMintedAmounts` should say
which it is — returning `null` for "could not read", keeping the zero
return for "the receipt was readable and held no `IncreaseLiquidity` for
this tokenId", which is a real answer about the chain.

Then the caller has something to branch on: no baseline is persisted
when the receipt could not be read, and `initHodlBaseline` tries again
next cycle, which is what the existing `needsPrice` retry already does
for the price half. Per [[feedback_dont_persist_a_correction]], the
question is whether the wrong value should be written at all, and here
it should not.

Note that `mintGasWei: "0"` rides the same return, so the same failure
also understates that NFT's gas — see
[[project_nft_gas_zero_from_rpc_failure]], which is the same conflation
in a second place.
