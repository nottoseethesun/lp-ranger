# Merge Per-Topic Log Queries Into One Call Per Chunk

> **Status:** Nice-to-have / efficiency — not a bug. Every figure the
> scans produce is correct today. Funds are never at risk. This would
> halve the blockchain requests a history rebuild makes, at the cost of
> touching parsing logic that sits directly upstream of money figures.

## Plain language

When the app reads one position's history it asks the blockchain the
same question twice over the same range of blocks: once for "when were
fees collected", once for "when was liquidity removed". The compound
scan asks three such questions. A single request can carry all of them
at once, because the blockchain's log filter accepts a list of event
types rather than one.

Nothing is wrong with the answers. It is the number of round trips that
is double what it needs to be, and every round trip waits its turn in
the global request queue, so the count is the wall-clock time.

## Detail

Two call sites scan one NFT's events, and each issues one
`eth_getLogs` per event type per block window. Address, `fromBlock`,
`toBlock` and the tokenId topic are identical across them; only
`topics[0]` differs.

| Call site | Event types | Queries per chunk |
| --- | --- | --- |
| `scanCollectAndDrain` (`src/position-history-scan-helpers.js`) | `Collect`, `DecreaseLiquidity` | 2 |
| `scanNftEvents` (`src/compounder.js`) | `IncreaseLiquidity`, `Collect`, `DecreaseLiquidity` | 3 |

The server log shows the pairs moving in lockstep, which is the tell:

```text
03:50:13  history Collect #156966:           50/168 chunks scanned
03:50:14  history DecreaseLiquidity #156966: 50/168 chunks scanned
```

Measured on a cold rebuild: one 132-rebalance chain at 168 chunks per
NFT, two queries per chunk — 44,352 paced requests, roughly two and three
quarter hours of queue time at the default 222 ms interval. Merged, half
of both.

A second chain of 39 NFTs was queued behind it in the same run, and a
third pool resolved to zero rebalances and so contributed none. The
39-NFT chain's per-NFT window never reached the log before the run was
read, so its cost is not included above rather than estimated.

This is a different duplication from
[Derive Per-NFT Fees From One Scan Instead of Two](project_consolidate_fee_scans.md).
That entry is about two separate *passes* reading the same logs for the
same NFTs. This one is about duplicate *queries* inside a single pass.
Fixing either leaves the other in place.

## Fix when prioritized

`eth_getLogs` accepts an array at each topic position, so
`topics: [[collectHash, decreaseHash], tokenIdHex]` returns both event
types from one call, and the results partition client-side on
`log.topics[0]`.

The source change is contained. Neither function's signature nor return
shape changes, so no caller moves:

- `scanCollectAndDrain` keeps `{ collectEvents, dlEvents }` and its
  `collectEvents.length === 0 → null` contract. One production caller,
  `src/position-history.js`.
- `scanNftEvents` keeps
  `{ ilEvents, collectEvents, dlEvents, ilLogsCount }`. Two production
  callers, both untouched.

The work is in the tests. Six files stub `getLogs` for these paths and
assert on the per-topic call shape;
`test/position-history-scan-bound.test.js` alone has seventeen stubs.

**Why it is deferred, and it is not the size.** The partition step sits
directly upstream of exit values and lifetime fee totals. A subtly wrong
`topics[0]` match drops logs into the wrong bucket, and that surfaces as
wrong money figures rather than as an error —
`scanCollectAndDrain` returns `null` on zero Collects precisely because
a silent miscount there would overwrite real numbers with wrong ones. A
rebuild from cold is rare, so spending that risk to halve a scan nobody
waits on is a poor trade while stability outranks speed.

A cheaper lever on the same problem, if scan time is what wants fixing:
`_findMintEvent` in `src/hodl-baseline.js` walks a pool's entire history
to find one mint event, passing neither `direction` nor `onChunk` even
though `scanChunked` supports both and
`src/event-scanner-mint-lookup.js` already uses `onChunk` for the same
job. In the run above it scanned 944 chunks for a hit that sat in the
last 44.
