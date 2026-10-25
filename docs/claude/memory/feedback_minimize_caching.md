---
name: feedback-minimize-caching
description: Do not introduce caching layers unless unavoidable. Prefer reusing existing resolvers (which may cache as a side effect) over adding new cache writes.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-24T04:54:43.090Z
---

When a value can be fetched live, fetch it live. Don't introduce new caching unless there's a concrete reason that fetching live is unworkable (RPC quota, latency budget, etc.).

**Why:** Cached values go stale, cache invalidation is hard, and most "for-performance" caching is premature optimization. The dashboard's existing token-symbol resolver already caches as a side effect of `resolveSymbolMap` — that's enough. Adding `setTokenSymbol` / `flushSymbolCache` calls from the bot path is duplicate caching with no incremental benefit. Same principle applies to other value caches: prices, pool addresses, decimals, etc. — if an existing resolver covers the path, route through it instead of writing the value to a separate cache.

**How to apply:**

- When you need a value, check whether an existing resolver in the codebase fetches it. Route through that resolver.
- Don't add a new cache layer to skip the resolver. Even if the resolver doesn't cache, prefer re-resolving on next call over introducing a cache.
- If you genuinely cannot avoid caching (quota cliff, latency hard requirement), call it out explicitly when proposing the change.
- The exception: caching that's already there (e.g. `getTokenSymbol` / `setTokenSymbol` in `src/lib/token-symbol-cache.js`, `resolveSymbolMap` in `src/lib/server-scan.js`, disk caches in `src/lib/cache-store.js`) is fine to *read from* — just don't add additional write sites.
