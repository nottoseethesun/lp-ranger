---
name: project_nft_gas_zero_from_rpc_failure
description: "FIXED 2026-10-04: a refused receipt read was recorded as 'this transaction cost no gas', persisted, and then accepted on presence forever. Now an unreadable receipt makes the whole NFT total null and nothing is saved, so the next scan can answer properly."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-04T03:44:02.410Z
---

Found 2026-10-03 auditing for the same conflation as
[[project_speedup_phase_boundary_race]]. **Not fixed.** Sibling of
[[project_hodl_baseline_zero_from_rpc_failure]] — same mistake, second
subsystem.

## What happens

What a transaction cost is `gasUsed × gasPrice` off its receipt. Three
readers fetch those receipts, and all three answer an endpoint failure
with zero:

- `_fetchMintGasWei` (`src/compounder.js`) — `catch { return 0n; }`,
  and `if (!rcpt) return 0n` for a null receipt
- `_fetchCompoundGas` (`src/compounder.js`) —
  `catch { /* receipt fetch failed — gas stays 0 */ }`
- `_fetchReceiptGasWei` (`src/position-history.js`) — same two returns

A null receipt is not a smaller charge. It means the endpoint does not
know the transaction, which for a hash taken out of an event log means
the endpoint is behind or has pruned it.

**The enclosing scan does not throw**, which is what makes this stick.
Each failure is swallowed inside the helper, so
`detectCompoundsOnChain` returns normally with a wrong
`totalNftGasWei`, and the caller persists it:

```js
nftGasWeiByTokenId[String(tid)] = String(r.totalNftGasWei || "0");
```

Then `applyCurrentNftFigures` (`src/bot-pnl-current-nft.js`) gates the
re-read on presence alone:

```js
const cachedGas = deps._botState?.nftGasWeiByTokenId?.[tid];
if (cachedGas !== undefined) { …use it; return; }
```

`"0"` is present, so it is a cache hit on every poll from then on. The
outer `catch` that returns `empty` without persisting only fires when
the whole scan throws — the dangerous path is the one that succeeds.

## What it costs

The mint transaction is the largest single gas charge against an NFT, so
the common case loses the biggest component. Gas understated means
profit overstated, in the Current panel and in lifetime P&L, silently
and permanently. Per CLAUDE.md gas is deliberately stored as coins and
priced where it is shown, so the error is carried at whatever the
native token is worth at display time — it does not even stay a fixed
dollar amount.

Nothing surfaces it. There is no "gas unknown" state to render, and a
plausible-looking small number is indistinguishable from a correct one.

## The fix, 2026-10-04

Same shape as [[project_hodl_baseline_zero_from_rpc_failure]]: zero is
reserved for an answer actually given, and null means unknown.

Three readers changed. `_fetchMintGasWei` and
`position-history._fetchReceiptGasWei` return `null` on a throw and on a
`null` receipt, while still returning `0n` when there is **no hash to ask
about** — no transaction there means nothing to have cost anything, and
that has to stay distinguishable from a read that failed.
`_fetchCompoundGas` reads many receipts, so it reports `gasComplete`
alongside its running total, false the moment one is missing.

An NFT's whole gas is the mint plus every later charge, so one unreadable
receipt anywhere makes `totalNftGasWei` null rather than smaller. Both
callers that save it then write nothing: `bot-pnl-current-nft` returns
early without touching either per-NFT map, and `bot-recorder-lifetime`
omits that NFT's key. `position-history._supplementGasFromChain` likewise
leaves `gasCostWei` unset. Each says so in a warning naming the NFT or
the hash.

**Why nothing is saved rather than saved-and-marked.** The maps are read
by presence (`cachedGas !== undefined`), so any figure written is
accepted on every later poll. Leaving the key absent costs a re-scan next
poll and keeps the door open for one that succeeds — and that cost is not
new: the scan's outer catch already declined to persist and so already
re-scanned on failure.

**One consequence taken deliberately.** `position-details-compound`
values an unknown total at `$0` for the unmanaged Current panel, where it
previously showed a partial. Nothing is persisted on that path, and an
obvious zero beats a plausible number that is quietly missing a charge.
The display layer coerces an absent gas figure to zero in two places
(`dashboard-data-kpi.js:458`, `position-details.js:175`) while a third
correctly falls back on `undefined` — pre-existing, and not touched here.

Tests: `test/nft-gas-unknown.test.js`, six cases driving
`classifyCompounds` and `_fetchCompoundGas` directly — a readable set, an
absent mint receipt, a throwing mint receipt, one absent compound receipt
out of two, no hash at all, and the completeness flag itself. Four fail
with the fix reverted.

## The shape the fix took

Same as its sibling: stop spelling two answers with one value. A
receipt that could not be read is not a charge of zero, so these helpers
should return `null` for "could not read" and `0n` only for a receipt
that genuinely carried no cost.

A partial read then has somewhere to go. The honest options are to let
the scan fail so the existing outer `catch` declines to persist, or to
persist what was read and mark the entry incomplete so the next poll
re-reads it — the first is simpler and matches how chunked log queries
already behave, propagating by default rather than returning short.

What must not happen is a repair pass over already-persisted zeros
([[feedback_no_junk_repair_code]]). A zero written by this bug is
indistinguishable from a true zero after the fact, and Reload Position
already re-derives an NFT's gas from the chain.
