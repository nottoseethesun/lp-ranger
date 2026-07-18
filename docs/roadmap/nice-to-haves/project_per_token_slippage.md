# Per-Token Slippage Settings

> **Status:** Nice-to-have / future feature — not a bug. The app
> works correctly today with the existing one-size-fits-both slippage
> percent. Funds are never at risk. This item is a fidelity
> improvement for asymmetric-liquidity pairs.

Add per-token slippage: instead of a single `slippagePct` that applies
to every swap in the rebalance pipeline, allow the user to configure a
slippage percent independently for each side of the pair.

## Why

The current single slippage setting is one-size-fits-both. For pairs
where one token is thinly-traded and the other is deep (for example
`$texan / $wPls`), a single value forces a bad trade-off:

- **High enough for the thin side** (e.g. 5% for $texan so a rebalance
  swap can actually complete against its shallow liquidity)
- **Way too high for the deep side** (e.g. 5% on $wPls, where 0.5%
  would be fine, opens the swap up to front-running MEV that eats
  most of the slippage budget as extractable value).

Users of asymmetric pairs today either accept the MEV loss or manually
adjust slippage before each rebalance — neither is a good outcome.

## Design when prioritized

### Config fields

Add exactly **one additional per-position field** so the total slippage
configuration goes from 1 to 2 settings. Both are per-token overrides:

- `slippagePctToken0` (float, 0.1–5) — per-position override for
  Token 0 side.
- `slippagePctToken1` (float, 0.1–5) — per-position override for
  Token 1 side.

**Unset → shipped default.** If either field is unset for a given
position, use the shipped `slippagePct` default from
`app-config/app-defaults-for-user-configurable/bot-config-defaults.json`
(currently 0.75). No fancy multi-level fallback chain; a single simple
rule per token.

**No backflips for backwards-compat.** The existing `slippagePct` field
stays where it is and continues to work exactly as before for anyone
who hasn't opted into per-token overrides. Per-position overrides are
purely additive — a saved `slippagePct` on Production keeps applying
until the user chooses to set either per-token override for that
position. Do NOT auto-copy the existing `slippagePct` into the new
fields at load time; do NOT rewrite bot-config.json to migrate. Users
who want per-token control opt in explicitly per-position.

### Which slippage applies where

The rebalance pipeline does swaps in specific directions. Each swap
converts one side to the other. Apply the DESTINATION token's slippage:

- Primary swap: swapping excess of token X → token Y → use
  `slippagePctToken<Y>`.
- Corrective swap: same rule based on direction.

Alternative: apply the SOURCE token's slippage. Either is defensible
— the choice needs a paragraph in the circle-i so users know which
side "eats" the slippage budget in each direction.

### UI

Two per-token inputs in Bot Settings → Range & Execution (the existing
"Slippage" input keeps its slot for the shipped default / general
setting; the per-token pair sits next to it or right below it):

```text
Slippage (Token 0 name): [   ] %   Save  No Override
Slippage (Token 1 name): [   ] %   Save  No Override
```

The token-name labels update to match the pool (`Slippage
(HarryPotter)`, etc.) — same treatment as the Position Offset row.

Empty per-token input → falls back to the shipped default (0.75%). No
"Fallback" row; the shipped default IS the fallback.

### Circle-i copy

Explain the asymmetric-liquidity motivation, the destination-token
convention, and the "unset → shipped default" rule. Include the
`$texan / $wPls` example (or similar) so users can map the concept to
their own pairs.

### Migration

None needed. `slippagePct` stays as-is; per-token fields are additive
and opt-in per position.

### Aggregator implications

The 9mm DEX Aggregator quote path (`src/rebalancer-aggregator.js`)
passes a slippage percent into the quote request. Wire the destination-
token value in there. The V3 SwapRouter fallback path
(`src/rebalancer-swap.js`) uses `amountOutMinimum` computed from a
static-call quote; apply the same destination-token slippage there.

## Related

- `src/config.js` — global fallback (`SLIPPAGE_PCT` env var).
- `src/bot-cycle-opts.js` — where the current `slippagePct` is read
  and threaded into the rebalance opts.
- `src/rebalancer-aggregator.js`, `src/rebalancer-swap.js` — swap
  execution seams that consume the slippage.
- `app-config/app-defaults-for-user-configurable/setting-labels.json`
  — will need three new label entries for the Activity Log formatter.
