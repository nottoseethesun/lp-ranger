# Range Width (Fraction of Pool's Populated Liquidity Range)

> **Status:** Nice-to-have / future feature — not a bug. The app
> works correctly today with the existing **Price Range Extension**
> semantic (percentage of current price). Funds are never at risk.
> This item is an alternative width-configuration mode that would
> sit alongside Price Range Extension, not replace it.

Introduce **Range Width** as a per-position rebalance configuration
alongside the existing **Price Range Extension**. Both would describe
"how wide is my position," but from different anchors:

- **Price Range Extension** (implemented today): the position's price
  range as a percentage of the *current price*. `W=50` means the
  position covers ±25% around current (0.75× to 1.25× current).
- **Range Width** (this proposal): the percentage of the *pool's
  currently-populated liquidity price range* that the position covers.
  `W=50` means the position covers half of "where liquidity actually
  exists in the pool right now."

## Why

The LP-native concept when deciding where to place coins is "how much
of the pool's actual liquidity zone am I covering," not "how far away
from current price am I." Range Width answers the natural question
directly.

Price Range Extension is easier to compute because its denominator
(current price) is always known; the pool's populated liquidity range
requires querying the pool's tick bitmap and summing `liquidityNet` to
find where aggregate liquidity is > 0.

## Design when prioritized

### Dynamic denominator

The denominator (`highestPopulatedTickPrice − lowestPopulatedTickPrice`)
is snapshotted before the rebalance and used for the whole cycle. It
is dynamic — different for different pools and different at different
times, as other LPs enter and leave the pool. The Range Width value
shown in the input is also computed from the pool bounds at query time,
so `W` for the same NFT can drift over time even without our own
rebalance activity (because the pool bounds themselves drift).

### Values > 100 are meaningful

Setting `W > 100` produces a position wider than the pool's currently-
populated range. The rebalance mint's `tickLower` / `tickUpper` extends
past current populated ticks, and those extreme ticks become
initialized. The pool's populated range grows to include the new
position. On the next poll, the displayed Range Width self-corrects to
100 (the position IS the new widest LP in the pool).

### No sentinel for full-range

Full-range remains a separate toggle (the **Full-Range** checkbox next
to the Price Range Extension input) exactly as today. Range Width does
not repurpose any specific value as "full-range." In a pool with any
existing full-range LP, `W = 100` naturally corresponds to a full-range
position (100% of the populated range, which spans MIN_TICK to MAX_TICK
because of that other LP).

### Query for pool bounds

- Walk the pool's `tickBitmap` starting from current tick outward.
- For each word, use `nextInitializedTickWithinOneWord` to find
  initialized ticks.
- Track running aggregate liquidity via `liquidityNet` deltas at each
  initialized tick.
- Highest tick where aggregate > 0 = upper bound.
- Lowest tick where aggregate > 0 = lower bound.
- Cache the result per (pool, block window) — the bounds change slowly.

### UI

- Same input row as Price Range Extension, or a companion input just
  below it.
- Circle-i explains both concepts side-by-side and the trade-off (Range
  Width is more meaningful for LP decisions; Price Range Extension is
  simpler and always defined).
- Settings toggle at the row lets the user pick which one is "active"
  for saving on this position.

### Migration

- Existing `rebalanceRangeWidthPct` values stay Price-Range-Extension.
- New field `rebalanceRangeWidthPoolFraction` (or similar) holds the
  Range Width value.
- At most one is active per position; the toggle chooses.

## Related

- Session that surfaced this design (2026-07-18): the discussion that
  led to renaming the misnamed "Range Width" input to "Price Range
  Extension" also produced this concept as a future feature. See the
  Manual section "Price Range Extension, Range Width, and Position
  Offset" and the circle-i on the Price Range Extension input for
  the user-facing framing.
