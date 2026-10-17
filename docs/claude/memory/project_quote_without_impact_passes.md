---
name: project_quote_without_impact_passes
description: "OPEN QUESTION (found 2026-10-17): an aggregator quote with no estimatedPriceImpact is read as zero impact and passes the slippage check, while _checkSwapImpact refuses NaN"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T07:05:35.582Z
---

**Open, found 2026-10-17 in the branch audit; the user's call.**
`src/rebalancer-aggregator.js` reads a quote's impact as
`parseFloat(quote.estimatedPriceImpact) || 0`, for the first quote and
for every re-quote. A quote whose impact field is missing or unreadable
therefore counts as zero impact and passes the slippage check, while
`_checkSwapImpact` (`src/rebalancer-swap-impact.js`) refuses a NaN
impact outright. The two disagree about what an unknown impact means.

What it would cost: the aggregator's own `minBuyAmount` still bounds the
swap, so the check that is skipped is the operator's slippage figure
against the price impact, not the swap's floor.

**Why:** the slippage check exists to stop a swap whose impact is too
high, and "unknown" read as "zero" is the false-zero pattern
([[project_false_zeroes_for_price_and_amounts]]).

**How to apply:** ask the user whether a quote with no impact should be
refused (NaN, as `_checkSwapImpact` already handles) or allowed. Do not
change it unasked.
