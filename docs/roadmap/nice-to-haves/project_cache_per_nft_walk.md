# Batch And Cache The Per-NFT History Walk

> **Status:** Nice-to-have / optimization — not a bug. Every figure the
> walk produces is correct today. This is about how long it takes to
> produce them, and it is the largest repeated cost in the app.

## Plain language

When LP Ranger starts, it reads a position's whole history back from
the blockchain. A position that has rebalanced many times is not one
NFT but a chain of them — each rebalance mints a new one — and the app
walks every NFT in that chain to work out deposits, compounds, fees and
lifetime profit.

It walks them **one at a time**, and it keeps the answers in memory
only. So the work is done once per NFT on every run, over block ranges
that overlap almost completely.

## Measured, on the $eHex/$hex chain in the dev wallet

133 NFTs, first mint at block 26,028,850, head at 27,557,912 — a span
of 1,529,062 blocks, or 170 chunks at the 9,000-block chunk size.

| | Queries | At 222 ms pacing |
| --- | --- | --- |
| Today — one walk per NFT | 53,268 | ~197 min |
| One batched pass | 510 | ~1.9 min |
| Batched + cached, next run (1 day of new blocks) | 30 | ~7 s |

## Fix 1: batch the filter — the large, cheap win

`scanNftEvents` (`src/compounder.js`) filters one NFT per query:

```js
topics: [_IFACE.getEvent(name).topicHash, tidHex]
```

`tokenId` is the first indexed parameter on `IncreaseLiquidity`,
`Collect` and `DecreaseLiquidity`, and a JSON-RPC topic slot accepts an
**array** of values, matched as OR. So the whole chain can go in one
filter:

```js
topics: [topicHash, ids.map(tidHex)]
```

That collapses 133 overlapping walks into one pass over the union
range: three event types × 170 chunks = 510 queries instead of 53,268.
**Verified against all three shipped endpoints** with a 132-value topic
array over a 9,000-block window — g4mm4, pulsechain.com and
pulsechain.box each accepted it. Keep a batch size, and fall back to
smaller batches, in case a future endpoint caps the array.

This needs no cache, no new state, and no change to what the app
promises. It is pure arithmetic on how the same logs are requested.

## Fix 2: cache with a high-water mark — the rest of the win

Store per-NFT aggregates in `nft-walk-cache.json` alongside a single
`lastScannedBlock`. On start, scan `lastScannedBlock + 1 → head` with
the batched filter and add the deltas.

The obstacle a naive cache hits is that an NFT's history is only
settled while nothing adds liquidity to it, and LP Ranger cannot
guarantee that: the NFT stays in the wallet after being drained, and
its owner can add liquidity to it on 9mm at any time, outside the app.
A write-once cache would serve a stale history for any NFT that came
back to life.

A high-water mark dissolves that problem instead of legislating around
it. A re-funded old NFT emits `IncreaseLiquidity` **in the new range**,
so the next incremental scan sees it and updates that NFT's aggregate.
Nothing has to be forbidden for the cache to stay correct.

What is genuinely fiddly, and what makes this non-trivial:

- Aggregates must be additive, and the compound classifier is
  order-dependent per NFT ("first `IncreaseLiquidity` is the mint
  deposit, later ones are compound candidates"). The cache therefore
  has to record whether an NFT's first `IncreaseLiquidity` has already
  been seen, not just the running totals.
- It needs the same `firstGapFrom` discipline as the pool cache, so a
  partial scan is never mistaken for a complete one.

## Considered and rejected: restrict re-opening instead

If only the *youngest* closed NFT could be re-opened, every older NFT
would be settled and a write-once cache would be correct and trivial.

Rejected on two counts. First, it buys nothing the high-water mark does
not already give, and costs a restriction. Second, and more
importantly, it is not enforceable: LP Ranger can decline to re-open an
old NFT itself, but it cannot stop the owner funding one on 9mm
directly — the same limit that applies to the one-position-per-pool
rule. The failure modes differ, though. A second position in a pool
makes P&L *unattributable*, which is inherently unknowable and can be
stated plainly to the operator. A stale NFT cache makes P&L *silently
wrong*, and the app would go on trusting it. Cheap correctness is worth
more here than a simpler cache file.

## Relation to the other scan nice-to-haves

[Consolidate fee scans](project_consolidate_fee_scans.md),
[merge per-topic log queries](project_merge_per_topic_log_queries.md)
and [mint lookup scan direction](project_mint_lookup_scan_direction.md)
each make an individual walk cheaper. Fix 1 removes most of the walks;
Fix 2 removes most of what remains on a restart. Merging per-topic
queries composes directly with Fix 1 — same call, three topics instead
of one — and would take the 510 down further.
