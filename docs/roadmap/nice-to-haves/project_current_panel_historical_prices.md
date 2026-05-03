# Current-Panel Historical Prices for Gas + Fees Compounded

> **Status:** Nice-to-have / polish — not a bug. A small
> improvement: the **Lifetime panel already exists** and is the
> right place for an at-a-glance "what did this position cost / earn
> overall" reading. The Current panel is a snapshot view; valuing
> its lifetime-aggregated Gas and Fees Compounded at today's prices
> is acceptable and matches how the Unmanaged view has always
> displayed the same numbers.

The Current panel's "Gas" and "Fees Compounded" rows are valued at
**today's** native-token / token0 / token1 prices, not at the
prices that prevailed when each compound or gas-spend actually
happened. Applies to BOTH Managed and Unmanaged views — both use
the same `detectCompoundsOnChain` scan and
`actualGasCostUsd(totalNftGasWei)` math (single current-price
multiplication on the summed lifetime wei).

Managed/Unmanaged parity for these two rows was established by the
`bot-pnl-current-nft.js` hook (Current-panel only — the Lifetime
panel was untouched). That fix intentionally kept the existing
current-price valuation; per-TX historical pricing was deferred.

## Why this is small

The Lifetime panel's "Net Profit and Loss Return" already gives the
user the comprehensive lifetime view, with breakdown rows for
Compounded, Gas, Price Change, Wallet Residual, etc. A user
chasing exact historical costs/earnings reads that section. The
Current panel is for "where am I right now," and the slight
valuation drift between today's price and the average historical
price is rarely material at typical position lifespans.

## Proposed approach

The compounder scan already records per-TX `timestamp` + `txHash`.
For per-TX historical pricing, fetch:

- **Native price at each TX's block** for gas USD (one historical
  lookup per compound TX + the mint TX).
- **token0 / token1 prices at each compound's timestamp** for
  compound USD (replaces the single current-price multiplication
  in `_eventUsd` / `applyCurrentNftFigures._backfill`).

Mind the existing price-fetcher rate limiter (GeckoTerminal 30
calls/min, Moralis preferred when key available). Likely batch and
cache the historical lookups per pool/block so a re-scan doesn't
re-fetch.

## Where to add

`src/bot-pnl-current-nft.js` `_backfill` for the Managed path;
`src/position-details-compound.js` `_currentValuesFromScan` for the
Unmanaged path. Keep the two paths in lockstep — don't reintroduce
the divergence the parity fix closed.
