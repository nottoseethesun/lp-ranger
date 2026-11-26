---
name: feedback-minimize-caching
description: "No new caching layers, reuse existing resolvers; key chain caches generically so every position shares them; every cache key leads with the chain (cacheKey)"
metadata:
  type: feedback
---

# Caches

Merged from: feedback_generic_chain_cache_keys, feedback_cache_keys_lead_with_the_chain — those slugs no longer exist
separately; search this one.

## minimize caching

When a value can be fetched live, fetch it live. Don't introduce new caching unless there's a concrete reason that fetching live is unworkable (RPC quota, latency budget, etc.).

**Why:** Cached values go stale, cache invalidation is hard, and most "for-performance" caching is premature optimization. The dashboard's existing token-symbol resolver already caches as a side effect of `resolveSymbolMap` — that's enough. Adding `setTokenSymbol` / `flushSymbolCache` calls from the bot path is duplicate caching with no incremental benefit. Same principle applies to other value caches: prices, pool addresses, decimals, etc. — if an existing resolver covers the path, route through it instead of writing the value to a separate cache.

**How to apply:**

- When you need a value, check whether an existing resolver in the codebase fetches it. Route through that resolver.
- Don't add a new cache layer to skip the resolver. Even if the resolver doesn't cache, prefer re-resolving on next call over introducing a cache.
- If you genuinely cannot avoid caching (quota cliff, latency hard requirement), call it out explicitly when proposing the change.
- The exception: caching that's already there (e.g. `getTokenSymbol` / `setTokenSymbol` in `src/lib/token-symbol-cache.js`, `resolveSymbolMap` in `src/bot/wallet-scan.js`, disk caches in `src/lib/cache-store.js`) is fine to *read from* — just don't add additional write sites.

## generic chain cache keys

Key any cache of blockchain-derived data as generically as possible, so
that all positions can access it. For pool-scoped results, that means the
pool identity the codebase already uses (see
[[project_event_cache_scoping_rationale]]), not one position's composite
key or its `bot-config.json` slot.

**Why:** stated by the user on 2026-09-16: "caches from the blockchain
must be keyed as generically as possible, so that all positions can
access them. E.g., by pool." It came up because an unmanaged position's
lifetime request computes Fees Compounded and the deposit total, but
those are saved only in a position's config slot, which an unmanaged
position lacks. So when that position is managed later, its first scan
reads the whole chain again.

**How to apply:** when designing or reviewing a cache of chain data, ask
who else reads the same facts (another position in the pool, the
unmanaged view, a later managed run) and key the cache so all of them
can read it. This governs the planned per-NFT walk cache (Fix 2 in
`docs/roadmap/nice-to-haves/project_cache_per_nft_walk.md`).

## cache keys lead with the chain

Every cache of chain or price-service data keys its entries with the
canonical format: the chain's key in chains.json first, then what
identifies the entry, dash-joined and lower-cased. That is
`cacheKey(chain, ...parts)` in `src/lib/cache-store.js`, or the canonical
pool key in `src/lib/pool-key.js` for a pool's identity. This applies to
memory and disk caches on the server and to the browser's localStorage
copies of scan results (those end with the chain:
`9mm_position_store_<chain>`).

**Why:** the user, 2026-10-17: "All caches of course need to be keyed
with our canonical key format - fix that." A token or pool can sit at
the same address on two chains, and PulseChain's copy of Ethereum's
state means many do. The user also said the chain cannot change while a
server runs ("we don't allow the blockchain to be changed ... maybe
someday"), but it can change between runs. Disk and browser caches
outlive the run, so an address-only key hands one chain's answer to the
other.

**How to apply:** a new cache leads its key with the chain from the
start. Do not raise chain-change handling inside a running server (a
dashboard reload on a chain switch, say) as an issue, because that
cannot happen today. Re-keying a cache that is costly to rebuild needs
the cost stated first, and no migration code
([[feedback_no_junk_repair_code]]): the event cache's in-file key and
the epoch cache are already chain-scoped and were left alone on
2026-10-17 for that reason. Related: [[feedback_generic_chain_cache_keys]].
