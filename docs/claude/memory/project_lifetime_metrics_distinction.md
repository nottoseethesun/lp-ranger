---
name: project-lifetime-metrics-distinction
description: "Lifetime Net P&L Return vs Lifetime IL/G — different formulas, different roles; initial wallet residual is subtracted in ONE, not the other"
metadata: 
  node_type: memory
  type: project
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-24T04:57:19.920Z
---

The dashboard's Lifetime panel surfaces two related-but-distinct
profit metrics.  Do not conflate them when reasoning about residuals.

**Lifetime Net Profit / Loss Return** — comprehensive lifetime
accounting.  Subtracts the Initial Wallet Residual (Pool) so the
unavoidable leftover from the very first IncreaseLiquidity TX does
not inflate profit.  This subtraction is CORRECT for net P&L — those
tokens were a one-time mint side-effect, not LP-generated value.

**Lifetime Impermanent Gain / Loss (IL/G)** — simple "a vs b"
comparison: `(LP_value + current Wallet Residual) − HODL_value`.
Does NOT subtract the Initial Wallet Residual.  Per the user's
explicit decision (PR #142), the gross credit is the right model for
IL/G: it answers "how did the LP do vs holding the tokens?", not
"what was my lifetime net financial outcome?".  Accepted edge case:
a freshly minted LP whose only residual IS the initial mint leftover
will briefly show +$X of IL/G until the first rebalance folds that
leftover into the position.

**Where I went wrong (conflation):** when proposing "Option C" for
PR #142, I reached for Lifetime Net P&L's initial-residual
subtraction and tried to bake it into the IL/G formula too.  That
was wrong.  The two metrics have different jobs and the initial-
residual subtraction belongs in one of them, not both.

Future reasoning:
- For IL/G code changes (`src/lib/il-calculator.js`, `_computeIL` in
  `src/lib/bot-pnl-updater.js`, the IL/G debug modal), stay with the
  gross-credit formula.  No initial-residual term.
- For Net P&L code changes (anywhere the Lifetime panel's "Net P&L
  Return" or the "PROFIT" line is computed), the initial-residual
  subtraction stays.
