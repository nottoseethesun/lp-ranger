# Price Each Deposit at Its Own Block Without Moralis

> **Status:** Nice-to-have — not a bug. Without it Total Lifetime
> Deposit is right to the day, and funds are never at risk: it would
> change only which moment of the day a deposit's price is taken from.
> Deferred at the user's word (2026-10-24): "if the price oracle doesn't
> support per-block, it is not a big deal."

## What happens now

Total Lifetime Deposit prices each deposit at its own block. The
deposit count records each one at its block as it arrives, and the
Lifetime scan enters each one it finds the same way
(`src/lib/lifetime-hodl.js`). The price comes from the historical-price
lookup (`fetchHistoricalPriceGecko`, `src/lib/price-fetcher.js`):

- **With a Moralis API key,** Moralis answers for the block itself.
- **Without one,** or for a coin Moralis has no price for,
  GeckoTerminal answers. It is asked for candles as of the end of the
  deposit's UTC day: the day's candle first, and the hour's or the
  minute's only when the day's has none. So the price is the day's
  closing price, and every deposit made that day takes it.

## What it costs

- A deposit made early in a day that moved a lot is priced at the
  day's close.
- A deposit priced during its own day gets that day's candle so far.
  Reload Current Position and Re-scan Prices ask for the prices again,
  past the cache, and once the day has closed the answer is its final
  close, so Total Lifetime Deposit can move a little.
- The User Manual says each deposit is valued at the historical price
  of the block it was made in, which holds only with Moralis.

## Shape of the fix

Ask GeckoTerminal for the candle that holds the deposit's block, the
minute's or the hour's, as of just after the block's time rather than
the end of its day. Two things to settle first:

- **Requests.** GeckoTerminal's free tier allows about thirty a minute,
  shared by every GeckoTerminal call (`src/lib/gecko-rate-limit.js`).
  Asking for the minute's candle first adds a request wherever it comes
  back empty and the lookup falls back to a coarser one.
- **A pool with no trade yet.** For a block at the pool's start, before
  any swap, no candle precedes it. The end-of-day look-ahead exists for
  that case, and the finer lookup must keep it as its last resort.
