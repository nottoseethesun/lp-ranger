# Rebuild Only the Missing Epoch, Not the Whole Chain

> **Status:** Nice-to-have / efficiency — not a bug. Every P&L figure
> the app produces is correct today, and a rebuild that is interrupted
> repairs itself. Funds are never at risk. This would remove the largest
> repeated cost in the app: re-reading a position's entire history after
> every rebalance to recover the one epoch that rebalance created.

## Plain language

Every time the bot rebalances, it closes one position and opens another.
The closed one needs one new entry in the P&L history.

To add that one entry, the app re-reads **every** position the chain has
ever had. On a position that has rebalanced 132 times, that is 133
positions read to learn about one.

Nothing is wrong with the result. It is the amount of work done to reach
it that is out of proportion, and because every blockchain request waits
its turn in one queue, the work is the wall-clock time.

## Why it re-reads everything

A stored epoch does not record which NFT it came from. Its fields are
values and timestamps — `entryValue`, `exitValue`, `fees`, `gas`,
`openTime`, `closeTime` — plus an `id` that is only a position in a
sorted list, reassigned every time the list is written.

So the app cannot ask "which epoch is missing?" It can only count:

```js
// src/epoch-reconstructor.js
closedEpochs.length >= closedIds.length
```

132 stored against 133 closed positions is short, and the only repair
available is to build all 133 again.

The disk cache is all-or-nothing for the same reason. It is consulted,
found short by one, and skipped entirely.

## What it costs

A cold rebuild of one 132-rebalance chain was measured at **44,352
paced requests** — roughly three hours of queue time at the global
222 ms interval. (Same measurement as
[Merge Per-Topic Log Queries](project_merge_per_topic_log_queries.md),
which attacks a different factor in the same total.)

The ratio is what matters here: 133 positions read where 1 would do.

## Two routes

### A. Give each epoch its NFT id

Record `tokenId` on the epoch when it is built. Completeness then
compares sets rather than counts, and the rebuild fetches only the ids
it is missing.

- Removes the cost permanently, including across restarts.
- Also removes the overwrite described below, since nothing is replaced.
- Needs a defined behaviour for epochs already cached without an id —
  most simply, treat any set containing one as needing a single full
  rebuild, after which every epoch carries its id.

### B. Keep the in-memory resume buffer instead of clearing it

`_fetchEpochsFromChain` already holds a per-NFT buffer of reads so a
failed rebuild can be retried cheaply. It is emptied on success:

```js
if (complete) botState._epochResumeBuffer = null;
```

Keeping it would let the post-rebalance rebuild reuse the 132 it already
read and fetch only the new one. A drained NFT is inert — it is never
returned to and cannot emit again — so reuse is exact rather than a
cache with a staleness window.

- Much smaller change than A.
- Does not survive a restart, so the first rebuild after one still pays
  full price.
- Needs checking first: `getPositionHistory` falls back to **current**
  prices when historical ones are unavailable, so a buffered read can
  have a price baked into it. Keeping it indefinitely freezes that
  price. How often the fallback fires decides whether B is acceptable
  on its own or only as a step toward A.

## Related: the overwrite this would also remove

Because the rebuild replaces rather than fills in, a rebuild interrupted
part-way writes its partial result over the complete one — 132 epochs
replaced by however many were read before the interruption. Cumulative
P&L reads low until a later pass completes.

That is bounded today and self-repairing: the short result raises
`_epochHistoryIncomplete`, the thirty-minute rescan retries, and the
resume buffer means the retry re-reads only what failed. A guard of the
"never save fewer than you have" kind was considered and rejected — the
app cannot distinguish a worse scan from a better one that corrected an
earlier over-count, so such a guard would permanently pin a wrong
history the day the count was too high.

Route A removes the overwrite as a side effect, which is the stronger
argument for preferring it.

## Why deferred

Priority is that the app loads reliably from scratch. This is a speed
problem sitting on top of correctness work that has only just landed —
the fee and gas guards, the two resume buffers, and the rescan flag —
and none of that has been through a live burn-in yet. Revisit once a
cold start is dependable.
