# Stop Hanging Properties on Arrays

> **Status:** Nice-to-have / cleanup &mdash; not a bug today. The one
> place this broke has been patched and pinned by a test. Funds are
> never at risk.

## Plain language

The event scanner returns a list of rebalance events, and attaches six
extra values directly to that list object, among them:

```js
merged.firstMintTimestamp = firstMintTimestamp;
merged.firstMintBlockNumber = firstMintBlockNumber;
```

The other four are `firstMintTokenId`, `chainFirstTokenId`,
`chainFirstMintBlock` and `chainFirstMintTimestamp`.

Those are not entries in the list. They are properties stuck on the
list object beside the entries. That works right up until somebody
copies the list &mdash; and copying a list copies its entries, not
things stuck to it.

```js
const a = [1, 2];
a.extra = 9;
[...a].extra; // undefined
```

`push(...list)`, `slice()`, `map()`, `JSON.stringify()` and
`structuredClone()` all drop it. Nothing warns. (`Object.assign([], a)`
happens to keep it, which makes the rule even harder to remember.)

## Detail

This cost real time on 2026-09-13. `bot-recorder.js` transplants the
scan result into the bot's own array:

```js
events.length = 0;
events.push(...found);
```

`firstMintBlockNumber` did not survive that. It is the mint block of the
OLDEST NFT in a rebalance chain &mdash; the one NFT no rebalance event
can supply a mint block for &mdash; so it is the only thing that can
stop that NFT's history scan starting at the pool's creation block. On a
pool that existed two years before the operator's first deposit, that is
1,144 chunked queries for a single NFT.

So before the patch the value worked on the two dashboard code paths,
which read the scanner's array directly, and did nothing at all on the
bot's path, which is the slow one. Both paths reported success, so the
difference showed only as the bot being slower than the dashboard for
no stated reason.

That copy site now re-attaches all six values after the push, and
`test/first-mint-block-survives.test.js` asserts the re-attach exists and
follows it. Any other place that copies this array is still exposed.

## Fix when prioritized

Two parts.

**1. Return the values properly.** Have the scanner return an object,
`{ events, firstMintBlockNumber, firstMintTimestamp, … }` with all six
values as fields, and have callers take them as ordinary values.
Touches `src/lib/event-scanner.js`,
`src/lib/pool-scanner.js`, `src/lib/bot-recorder.js`,
`src/lib/bot-recorder-lifetime.js`, `src/server/position-details*.js` and
`src/lib/nft-mint-blocks.js` (`chainScanFloor`). Once done, delete the
re-attach lines and their test.

**2. Add a lint rule.** A custom ESLint rule &mdash; sibling to the
existing `eslint-rules/no-separate-contract-calls.js` and
`eslint-rules/no-unescaped-digit-class-selector.js` &mdash; that rejects
assigning a non-index property to a value that is an array literal, an
array parameter, or the result of a call known to return an array.
Message: *"Do not attach properties to an array; copies silently drop
them. Return an object instead."*

Scope it narrowly to avoid false positives on genuinely array-like
objects. The rule is the part that makes this stay fixed; the refactor
alone leaves the next author free to do it again.
