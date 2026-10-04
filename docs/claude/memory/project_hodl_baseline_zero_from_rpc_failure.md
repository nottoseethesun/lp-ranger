---
name: project_hodl_baseline_zero_from_rpc_failure
description: "FIXED 2026-10-03: a failed mint read was recorded as 'opened with zero of both tokens' and looked complete, so it was never retried. The reachable trigger was not the receipt but the token-decimals read, whose failure a log-parse catch swallowed. Now every unreadable part returns null and nothing is published."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-04T02:52:37.195Z
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

## What was actually reachable, and the fix

**The receipt was not the trigger.** The operator's instinct was right:
receipts are not pruned state, so a full node keeps them even when it
drops old state, and a failing read is retried across endpoints rather
than returning zero. A node whose transaction index no longer covers an
old block does answer `null` rather than erroring — so that path is not
impossible — but it could not be shown reachable on this install.

**The decimals read was.** The deposit event states amounts in each
token's smallest unit, so converting them needs the token decimals, and
those come from `getPoolState` — a bounded read, six attempts on the
three-endpoint mainnet. That call sat *inside* the loop that walks the
receipt's logs, and that loop has a `try/catch` for an unrelated job:
most logs in a mint receipt belong to other contracts and decoding them
throws, so the catch skips them. A decimals failure was eaten by that
same catch, the loop treated our own log as foreign, and the function
returned zeros under a comment reading "Event not found but receipt was
readable." The event had been found.

Confirmed on Production hardware the same night: `getPoolState` exhausted
its six attempts twice in three hours. See
[[project_read_retry_never_probes_another_endpoint]] for why those six
attempts all went to the one endpoint that was refusing.

**The fix, as the operator specified it:** when a read yields nothing
usable, keep the saved value. `_readMintedAmounts` now returns `null`
from each of its three failure points, and the decimals read moved one
statement past the log loop so its error is no longer swallowed.
`initHodlBaseline` publishes nothing on a `null` — which stops the
overwrite outright where a baseline exists, and where none does leaves
the next start to try again. `getPositionBaseline` returns `null`, which
its caller already handles.

That overwrite is the half worth remembering: a baseline whose dollar
value never resolved is re-read at the next start to recover the price,
and that re-read fetches the amounts again. Before this, a decimals
failure during that retry replaced correct saved amounts with zeros — the
retry meant to recover a price destroyed what it was protecting.

## Tests

`test/hodl-baseline-unreadable-mint.test.js`, three cases: an absent
receipt, an unreadable decimals read, and a saved baseline surviving a
failed re-read. All three verified to fail with the fix reverted.

The old tests had been passing **because** of the bug. They asserted the
mint gas and never the amounts, and the decimals read was failing in
every one of them — the stub pool address was not a valid address shape,
`slot0` was returned as an array where the code reads named properties,
and `decimals` was a static where an instance method is called. Zeros
satisfied every assertion in the file. Stubs now live in
`test/helpers/hodl-baseline-stubs.js`, whose header states those three
details, because a second copy would drift the moment `getPoolState`
validated a new field.

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
