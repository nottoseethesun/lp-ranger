# Walk Mint Lookups Newest-First

> **Status:** Done for the lookup that cost the time. Kept as the record
> of why it walks newest-first, and of why the other lookup does not.

## Plain language

To learn when an NFT was minted, the app reads the blockchain in
windows between the pool's creation block and the chain head, and stops
at the window that finds the mint.

A token is minted once, so stopping early is right. But the walk used to
start at the oldest end, and a recently created NFT was minted at the
*newest* end, so the scan ground through nearly the pool's entire
lifetime before it reached the answer. Walking from the newest end finds
a recent mint almost at once, and an old NFT is no worse off.

## What changed

Two call sites do this lookup:

| Call site | Looks up | Walks |
| --- | --- | --- |
| `_findMintEvent`, `src/hodl-baseline.js` | the mint of the position's current NFT, for its HODL baseline | newest-first (`direction: "desc"`), since a managed position mints a new NFT at every rebalance |
| `findOriginalMintOnChain`, `src/event-scanner-mint-lookup.js` | the mint of a chain's first NFT | oldest-first, the default, since that mint is the oldest in the chain |

Both stop at the first window that returns anything
(`onChunk: (found) => found.length > 0`).

Token ids are global to the position manager rather than per pool, so a
high id means a recent mint regardless of which pool the NFT belongs to.
Oldest-first, the lookup for a high id paid close to the full span every
time.

Direction cannot change the answer: the `Transfer` filter is pinned to
one `tokenId` with `from` = the zero address, and an NFT is minted
exactly once. Whichever end the walk starts from, the single window
holding that event is the one that returns it.

## Measured, before the change

Observed on a cold start, on NFT #163164 in a wallet whose newest token
is #164743 — so the mint is near the chain head:

```text
[scan] hodl-baseline mint #163164: 50/945 chunks scanned (0 results)
[scan] hodl-baseline mint #163164: 100/945 chunks scanned (0 results)
```

945 windows, at 50 per 57 seconds while sharing the paced request queue
with a concurrent pool scan — roughly eighteen minutes to find something
a newest-first walk would have found in seconds.

## Why it was handled with care

The change only reverses the order of the windows. But it touches the
lookup that feeds HODL baselines, where a wrong mint block silently
shifts money figures rather than raising an error. A lookup added later
for a chain's oldest NFT should keep the oldest-first default, for the
reason the table gives.
