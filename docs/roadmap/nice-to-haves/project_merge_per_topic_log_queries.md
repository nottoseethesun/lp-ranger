# Merge Per-Topic Log Queries Into One Call Per Chunk

> **Status:** Nice-to-have / efficiency — not a bug. Every figure the
> scans produce is correct today. Funds are never at risk. This would
> cut the blockchain requests a history read makes to between a half and
> a third, at the cost of touching parsing logic that sits directly
> upstream of money figures.

## Plain language

When the app reads one position's history it asks the blockchain the
same question twice over the same range of blocks: once for "when were
fees collected", once for "when was liquidity removed". The compound
scan asks three such questions. A single request can carry all of them
at once, because the blockchain's log filter accepts a list of event
types rather than one.

Nothing is wrong with the answers. It is the number of round trips that
is two or three times what it needs to be, and every round trip waits
its turn in the global request queue, so the count is the wall-clock
time.

## Detail

Three call sites issue one `eth_getLogs` per event type per block
window. Address, `fromBlock`, `toBlock` and the tokenId topic are
identical across those queries; only `topics[0]` differs.

| Call site | Reads | Event types | Queries per chunk |
| --- | --- | --- | --- |
| `scanChainNftEvents` (`src/lib/nft-events-batch.js`) | a whole chain, ids in groups of up to 100 | the ones the caller names, up to three | one per type, per id group |
| `scanCollectAndDrain` (`src/lib/position-history-scan-helpers.js`) | one NFT | `Collect`, `DecreaseLiquidity` | 2 |
| `scanNftEvents` (`src/lib/compounder.js`) | one NFT | `IncreaseLiquidity`, `Collect`, `DecreaseLiquidity` | 3 |

The server log shows the queries moving in lockstep, which is the tell:

```text
03:50:13  history Collect #156966:           50/168 chunks scanned
03:50:14  history DecreaseLiquidity #156966: 50/168 chunks scanned
```

Measured on a cold rebuild, before chain reads were batched: one
132-rebalance chain at 168 chunks per NFT, two queries per chunk —
44,352 paced requests, roughly two and three quarter hours at the
default 222 ms interval. Batching has since cut a whole-chain read to
about 1,000 requests for a chain that size: three event types, two id
groups. Merging the types would cut that to about a third.

This is a different duplication from
[Derive Per-NFT Fees From One Scan Instead of Two](project_consolidate_fee_scans.md).
That entry is about two separate *passes* reading the same logs for the
same NFTs, and those passes now share one read. This one is about
duplicate *queries* inside a single read, which sharing did not touch.

## Fix when prioritized

`eth_getLogs` accepts an array at each topic position, so
`topics: [[collectHash, decreaseHash], tokenIdHex]` returns both event
types from one call, and the results partition client-side on
`log.topics[0]`.

The source change is contained. No function's signature or return
shape changes, so no caller moves:

- `scanChainNftEvents` keeps one entry per requested id, with an array
  for each event type the caller named.
- `scanCollectAndDrain` keeps `{ collectEvents, dlEvents }` and its
  `collectEvents.length === 0 → null` contract. One production caller,
  `src/lib/position-history.js`.
- `scanNftEvents` keeps
  `{ ilEvents, collectEvents, dlEvents, ilLogsCount }`. One production
  caller, `detectCompoundsOnChain` in the same file.

The work is in the tests, which stub `getLogs` for these paths and
assert on the per-topic call shape: among them
`test/nft-events-batch.test.js`, and
`test/position-history-scan-bound.test.js` with seventeen stubs.

**Why it is deferred, and it is not the size.** The partition step sits
directly upstream of exit values and lifetime fee totals. A subtly wrong
`topics[0]` match drops logs into the wrong bucket, and that surfaces as
wrong money figures rather than as an error —
`scanCollectAndDrain` returns `null` on zero Collects precisely because
a silent miscount there would overwrite real numbers with wrong ones. A
rebuild from cold is rare, so spending that risk to shorten a scan
nobody waits on is a poor trade while stability outranks speed.

A cheaper lever on the same problem has since been pulled. In the run
above, `_findMintEvent` in `src/lib/hodl-baseline.js` walked a pool's entire
history, 944 chunks, for a mint that sat in the last 44. It now walks
newest-first and stops at the first hit (`direction: "desc"`,
`onChunk`); see [Walk Mint Lookups Newest-First](project_mint_lookup_scan_direction.md).
