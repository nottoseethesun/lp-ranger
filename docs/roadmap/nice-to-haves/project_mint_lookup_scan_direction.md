# Walk Mint Lookups Newest-First

> **Status:** Nice-to-have / efficiency — not a bug. The mint block the
> lookup returns is correct today, and funds are never at risk. This
> would find a recently minted NFT in a handful of blockchain requests
> instead of thousands, on exactly the cold start that is slowest.

## Plain language

To learn when an NFT was minted, the app reads the blockchain in
windows, starting at the pool's creation block and walking forward. It
stops at the window that finds the mint.

A token is minted once, so stopping early is right. But the walk starts
at the oldest end, and a recently created NFT was minted at the *newest*
end — so the scan grinds through nearly the pool's entire lifetime
before it reaches the answer.

Walking from the newest end instead finds a recent mint almost
immediately. An old NFT would be no worse than it is today.

## Detail

Two call sites do the same lookup with the same shape:

| Call site | Purpose |
| --- | --- |
| `src/hodl-baseline.js` | Mint block for a position's HODL baseline |
| `src/event-scanner-mint-lookup.js` | Mint block for a rebalance-chain NFT |

Both pass the pool creation block as the lower bound, `"latest"` as the
upper, and exit at the first window that returns anything:

```js
fromBlock,                       // the pool's creation block
toBlock: "latest",
onChunk: (found) => found.length > 0,
```

Token ids are global to the position manager rather than per pool, so a
high id means a recent mint regardless of which pool the NFT belongs to.
The lookup for a high id therefore pays close to the full span every
time.

Direction cannot change the answer: the `Transfer` filter is pinned to
one `tokenId` with `from` = the zero address, and an NFT is minted
exactly once. Whichever end the walk starts from, the single window
holding that event is the one that returns it.

## Measured

Observed on a cold start, on NFT #163164 in a wallet whose newest token
is #164743 — so the mint is near the chain head:

```text
[scan] hodl-baseline mint #163164: 50/945 chunks scanned (0 results)
[scan] hodl-baseline mint #163164: 100/945 chunks scanned (0 results)
```

945 windows, at 50 per 57 seconds while sharing the paced request queue
with a concurrent pool scan — roughly eighteen minutes to find something
a newest-first walk would have found in seconds.

## Why deferred

Priority is that the app loads reliably from scratch, and it does; this
is speed on top of correctness. The change is contained — the chunker
already supports an early exit, so it is the iteration order that moves
— but it touches the lower bound of a scan that feeds HODL baselines and
rebalance-chain mint blocks, where a wrong block silently shifts money
figures rather than raising an error. Worth doing with the same care as
the scan-floor work, not squeezed in beside it.
