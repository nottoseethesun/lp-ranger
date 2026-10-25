---
name: Event-cache scoping rationale (asset-config, not pool hash)
description: Why event-cache files key on blockchain+nftFactory+wallet+token0+token1+fee instead of pool address — ideal for Lifetime P&L reporting
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-24T04:55:01.277Z
---
`src/lib/cache-store.js` `eventCachePath` deliberately scopes event-cache
filenames by **blockchain + nftFactory + wallet + token0 + token1 + fee**
rather than by the specific pool contract address.

**Why:** This is the better design for the Lifetime P&L (Reporting) use
case. The same asset configuration — same wallet, same token pair, same
fee tier, on the same DEX (NFT factory) — can span multiple distinct
pool contract instances across its history. Keying by the asset config
captures the entire history of that exposure together, even if the
underlying pool address changes (e.g. factory redeployment, fork
migration, new pool spun up at the same fee tier).

If we keyed by pool hash, history would fragment per-pool-instance and
Lifetime P&L for "my wPLS/HEX 1% LP exposure" would split across
multiple report rows.

**How to apply:**
- Don't "fix" the cache filename to include the pool address — that
  regresses the reporting model.
- When extending cache cleanup tools (e.g. `util/cache/clean-pool-cache.js`),
  remember that pool-address alone can't target an event-cache file —
  you need (factory, token0, token1, fee) to construct the filename
  via `eventCachePath`.
- Multi-NFT-factory support is already safe: factory address is the
  second segment of the filename, so distinct factories never collide.
