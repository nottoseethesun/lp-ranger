---
name: project_top_panels_price_at_today
description: "The Current and Lifetime panels deliberately value everything at TODAY's prices — gas included. Only the Per-Day P&L table keeps period-correct dollars. A current-priced figure feeding the top two panels is correct, not a bug."
metadata:
  node_type: memory
  type: project
  originSessionId: 07cfe275-1c36-4264-bf15-f23bc31b60d4
  modified: 2026-09-19T17:30:19.200Z
---

The user's framing, 2026-09-19:

> For the top two panels, we are always just using the current gas
> figure, since we are looking at the topic from the point of view of,
> "What is the reality in terms of today's prices?"

So the two panels answer a **present-tense** question. Every figure on
them is the saved coins multiplied by the price at the moment of
display. Gas is not an exception to that; it is an instance of it.

The **Per-Day P&L table** is the exception. Each of its rows is a closed
accounting period, and a closed period keeps the dollars it closed at.

## What this settles

These call sites price gas at today and are **correct**:

- `src/bot-pnl-current-nft.js` `_weiToUsd` — managed Current panel.
- `src/position-details-compound.js` `_currentValuesFromScan` —
  unmanaged Current panel. Same figure, so the two views agree.
- `src/bot-pnl-updater.js` `overridePnlWithRealValues` — the Lifetime
  Gas line, re-derived every poll as `totalGasNative × current price`.

These are past-dated charges that DO need historical pricing, because
they land in a Per-Day row:

- `src/epoch-reconstructor.js` — each epoch's gas, at its close day.
- `src/bot-pnl-updater.js` `_applyMintGas` — the NFT's mint gas, at
  `hodlBaseline.mintTimestamp`.

**Why:** a reader looking at Current or Lifetime is asking what the
position is worth and what it has cost them *now*. Mixing in
years-old dollar figures answers a question they did not ask. A closed
period is the opposite: it is a historical record, and re-pricing it
would make last March's row move with this week's market.

**How to apply:**

- Before "fixing" a gas figure that uses the current price, ask which
  panel it reaches. If it is one of the top two, leave it alone.
- I flagged both Current-panel sites as defects in this session, twice,
  and was wrong both times. The current price is the specification
  there.
- The README nice-to-have *Current-Panel Historical Prices for Gas +
  Fees Compounded* proposed exactly what this decision rejects — both
  halves, since Fees Compounded is coins priced at display for the same
  reason. Removed on the user's instruction, 2026-09-19, along with
  `docs/roadmap/nice-to-haves/project_current_panel_historical_prices.md`.
  Do not reintroduce it.
- Related: [[project_pnl_accounting_model]],
  [[project_lifetime_metrics_distinction]],
  [[feedback_no_finding_without_a_failure]].
