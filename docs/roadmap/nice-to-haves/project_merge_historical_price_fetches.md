# Merge the two historical-price lookups into one

**Not a bug.** Every figure it touches is correct today. The cost is
duplicated API calls during a chain reconstruction.

## What happens now

Reconstructing a chain asks for historical prices along two separate
paths, and they cannot see each other's answers.

The **pair** path, `fetchHistoricalPriceGecko` in `src/price-fetcher.js`,
prices a pool's token0 and token1 for one epoch. It is given a block, so
it caches under a block-scoped key — `@27123456`.

The **single-token** path, `fetchHistoricalTokenPriceUsd` in
`src/historical-token-price.js`, prices the chain's native token so an
epoch's gas can be valued at the day it was spent. It caches under a
day-scoped key — `2026-03-16T00:00`.

Both write into `tmp/historical-price-cache.json` through
`src/price-cache.js`. Same token, same moment, two entries, neither a hit
for the other. The two also restate the same cascade: read cache, try
Moralis by block, fall back to GeckoTerminal, write the answer back.

## What it costs

One extra historical lookup per epoch whose close day is not already
cached. On a 132-rebalance chain spread over six months that is on the
order of a hundred calls per cold rebuild, against a rate-limited free
tier.

The sharpest case is a pool that **contains** the native token — a
PulseX/WPLS position, say. There the pair path has already priced WPLS at
the exact block the gas lookup wants, and the gas lookup fetches it
again anyway, because it is looking under a different key.

## Shape of the fix

Make the single-token lookup the primitive and have the pair function
call it twice, so one cascade and one key convention serve both. Two
details decide whether it lands cleanly:

- **Which key wins.** Block-scoped is exact; day-scoped is what collapses
  a hundred rebalances onto a handful of lookups. Gas wants the second.
  A single convention that serves both probably means writing the day
  key always and the block key additionally when a block is known, so a
  block-exact reader still gets its answer.
- **GeckoTerminal is per-pool.** The single-token path resolves a pool
  first (`getBestPoolForToken`); the pair path already holds one. The
  merged primitive needs to accept a caller-supplied pool and only
  resolve one when it is not given.

Not difficult, but it is surgery on `src/price-fetcher.js`, which
everything that shows a dollar figure depends on — so it wants its own
branch and a full reconstruction to verify against known totals.

## Related

- `docs/claude/memory/feedback_no_duplication.md` — extract the shared
  helper rather than restating the flow.
- `docs/claude/memory/project_price_source_priority.md` — all price
  fetching goes through `price-fetcher.js`.
