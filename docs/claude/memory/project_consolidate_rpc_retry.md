---
name: project-consolidate-rpc-retry
description: "Nice-to-have / future — consolidate the per-URL × per-attempt RPC-retry orchestrator pattern used by getPoolState, can-reopen wallet reads, and likely other sites into a single shared helper."
metadata: 
  node_type: memory
  type: project
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-09-13T20:34:57.018Z
---

**Status: DEFERRED.** Per user 2026-06-18: "It seems that there might be a lot of opportunity to consolidate the re-try code for reading token balances and other items in the app. But I don't want to do a big refactor for a long time." Holding the refactor until the user signals readiness.

> **Updated 2026-09-12.** Both orchestrators now walk `config.RPC_URLS`
> rather than a hand-built primary/fallback pair, and both build their
> providers through `buildProvider`, so their requests are paced by
> `src/rpc-request-manager.js` like every other. The duplication below is
> unchanged — only the URL source and provider construction moved.

## What's duplicated

The same retry orchestrator shape now exists in two places (and likely more):

- **`src/rebalancer-pools.js` `getPoolState`** (PR #137 / commit `b920a5d`). Iterates `config.RPC_URLS` (the ordered endpoint list), each tried up to `_POOL_STATE_ATTEMPTS_PER_URL` (2) times with `_POOL_STATE_RETRY_DELAY_MS` (3 s) wait between. Builds a fresh provider per attempt via `buildProvider` (so the requests are paced by the global request manager); falls back to the caller-supplied provider when the ethersLib lacks the constructor (test-mock case). On exhaustion throws `PoolStateUnavailableError(attempts, cause)`. Test-only delay override via `_setRetryDelayForTests`.
- **`src/server-can-reopen.js` `_readBothBalancesWithRetry`** (closed-position-reopen PR / branch `closed-position-reopen-via-manage`). Identical shape: same `config.RPC_URLS` list, same attempts-per-url, same delay default, same `buildProvider`-or-fallback construction, same test setter, throws `WalletReadUnavailableError(attempts, cause)`.

The two functions differ only in (a) what they call inside the inner `try` and (b) the error class they throw on exhaustion.

## What to look at when consolidating

Likely shape of the future shared helper (`src/rpc-retry.js`?):

```js
async function withRpcRetry({ ethersLib, providerFactory, fn, ErrorClass, attemptsPerUrl = 2, delayMs = 3000 }) {
  const urls = config.RPC_URLS;
  let attemptCount = 0, lastErr = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= attemptsPerUrl; attempt++) {
      attemptCount++;
      if (attempt > 1) await new Promise(r => setTimeout(r, delayMs));
      try {
        let provider;
        try { provider = new ethersLib.JsonRpcProvider(url); }
        catch { provider = providerFactory(); }
        return await fn({ provider, url });
      } catch (err) {
        lastErr = err;
        log.warn("[%s] rpc=%s attempt=%d/%d failed: %s", ErrorClass.tag, url, attempt, attemptsPerUrl, err.message);
      }
    }
  }
  throw new ErrorClass(attemptCount, lastErr);
}
```

Then both call sites become a 3-line wrapper around `withRpcRetry({...fn: () => _getPoolStateOnce(provider, ethersLib, opts)})`.

## Audit candidates beyond these two

Before refactoring, grep for similar patterns. Quick mental list:
- `src/send-transaction.js` — already has its own RPC-failover Proxy + retry layer (`_retrySend` in `src/tx-retry.js`), but that's WRITE-path with nonce considerations; probably orthogonal, don't try to merge.
- `src/event-scanner.js` — chunk-loop with rate limiting; retry on chunk failure?
- `src/price-fetcher.js` — has Moralis → GeckoTerminal → DexScreener cascade with its own retry / fallback logic. Different shape (fallback DATA SOURCES not fallback RPCs); probably should stay separate.
- `src/pool-creation-finder.js` — binary search on `eth_getCode`; deliberately has NO retry. A provider error there means the node cannot serve historical state, and the caller's degraded path (return 0, keep your own floor) is correct and cheap. Leave it alone.

The consolidation only makes sense for the SHAPE that appears in `getPoolState` + `_readBothBalancesWithRetry` (per-URL × per-attempt JsonRpcProvider construction). Don't try to unify with the price-source cascade or the sendTx write-path Proxy — those are different concerns.

## Don't make it worse in the meantime

When future features need RPC retry, **copy from the closer of the two existing orchestrators** (whichever is more similar to the new use case) rather than inventing a third variant. That keeps the eventual consolidation a 2-file change, not a 4-file one.

---

**On the public list (2026-09-02).** Published on the README's
Nice-to-Have list as "Consolidate the RPC Retry Pattern", detailed in
`docs/roadmap/nice-to-haves/project_consolidate_rpc_retry.md`.
Keep the two in step, and do not add a second entry for it.
