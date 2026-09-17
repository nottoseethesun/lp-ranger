---
name: project_fresh_deposit_detection
description: Fresh deposit detection system for lifetime HODL/IL/G — Transfer scan with swap/drain/contract filters
metadata: 
  node_type: memory
  type: project
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-17T20:18:07.636Z
---

Fresh deposit detection scans ERC20 Transfer events between each rebalance boundary (prev mint block → next mint block). Filters:
1. **Swap filter**: TX with one token out + other token in → skip
2. **Drain filter**: TX with both tokens inbound, nothing outbound → skip
3. **Contract filter**: Inbound transfers FROM the Position Manager or pool contract → skip (eliminates collect/drain/refund noise)

Only genuine external deposits (from exchanges, personal wallets) pass all filters.

Results cached incrementally in `tmp/pnl-epochs-cache.json` under `freshDeposits` key with `{ raw0, raw1, lastBlock, deposits[] }`. Each deposit entry stores `{ raw0, raw1, block, usd }` — USD is fetched once per deposit at historical block price and cached.

Re-scan Prices is the one path that prices a deposit again: it passes `refresh` to `totalLifetimeDeposit` (skips the per-entry `usd`) and to `fetchHistoricalPriceGecko` (skips the disk price cache, which has no expiry). A refreshed entry keeps its old figure when no source answers. See [[feedback_never_clear_to_force_a_recompute]].

**Why:** Needed to compute Total Lifetime Deposit accurately and feed correct HODL amounts into IL/G calculations.
**How to apply:** Key files: `src/lifetime-hodl.js` (scan logic), `src/bot-pnl-updater.js` (`_totalLifetimeDeposit` USD computation), `src/bot-recorder.js` + `src/position-details.js` (callers for managed/unmanaged paths).
