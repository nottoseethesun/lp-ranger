---
name: project-consolidate-rpc-retry
description: "Nice-to-have / future — consolidate the per-URL × per-attempt RPC-retry orchestrator pattern used by getPoolState, can-reopen wallet reads, and likely other sites into a single shared helper."
metadata: 
  node_type: memory
  type: project
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-01T20:32:46.906Z
---

**Status: DEFERRED, with a named gate.** Per user 2026-06-18: "It seems that there might be a lot of opportunity to consolidate the re-try code for reading token balances and other items in the app. But I don't want to do a big refactor for a long time." Holding the refactor until the user signals readiness.

**The gate is now explicit.** User, 2026-10-01: *"we'll address that nice-to-have cleanup once the big fixes are all confirmed stable."* The big fixes are 0.9.8's transaction-path work, which shipped unexercised — see [[project_0098_burn_in_watch]]. So the trigger is that release being proven in the field, not a date.

> **Updated 2026-09-12.** Both orchestrators now walk `config.RPC_URLS`
> rather than a hand-built primary/fallback pair, and both build their
> providers through `buildProvider`, so their requests are paced by
> `src/rpc-request-manager.js` like every other. The duplication below is
> unchanged — only the URL source and provider construction moved.

## The cost is diagnostic, and it was paid on 2026-10-01

Reading a Production outage, the user asked why a `[pool-state]` failure
against `g4mm4` had no success line after it. The answer took a code read
to establish: these orchestrators step to the next endpoint **without**
calling `sendTx.failoverToNextRPC`, which is the only thing that logs
`RPC failover engaged`. So one mechanism's endpoint changes are announced
and the other's are invisible, and an operator cannot tell from the log
which endpoint served a read — nor distinguish recovery-on-the-next-endpoint
from recovery-on-retry.

Nothing breaks: the walk is real failover for the read, it reports every
outcome to `noteRpcResult`, and it deliberately does not move
process-wide selection, which would pin every concurrent read for an
hour. But "why is there no success log" is a question the duplication
creates, and consolidating would retire it — the shared helper is the
natural place for one line naming the endpoint and attempt that
succeeded. Worth doing as part of the consolidation rather than bolting
a log onto each copy now.

## What's duplicated

The same retry orchestrator shape now exists in two places (and likely more):

- **`src/rebalancer-pools.js` `getPoolState`** (PR #137 / commit `b920a5d`). Iterates `config.RPC_URLS` (the ordered endpoint list), each tried up to `_POOL_STATE_ATTEMPTS_PER_URL` (2) times with `_POOL_STATE_RETRY_DELAY_MS` (3 s) wait between. Builds a fresh provider per attempt via `buildProvider` (so the requests are paced by the global request manager); falls back to the caller-supplied provider when the ethersLib lacks the constructor (test-mock case). On exhaustion throws `PoolStateUnavailableError(attempts, cause)`. Test-only delay override via `_setRetryDelayForTests`.
- **`src/server-can-reopen.js` `_readBothBalancesWithRetry`** (closed-position-reopen PR / branch `closed-position-reopen-via-manage`). Identical shape: same `config.RPC_URLS` list, same attempts-per-url, same delay default, same `buildProvider`-or-fallback construction, same test setter, throws `WalletReadUnavailableError(attempts, cause)`.

The two functions differ only in (a) what they call inside the inner `try` and (b) the error class they throw on exhaustion.

## What to look at when consolidating

**Verified against the code 2026-10-01.** The two bodies are now the same
shape line for line. Everything in this list is identical in both, so all
of it belongs in the helper and none of it is a parameter:

- `const urls = walkOrderFrom(config.RPC_URLS, sendTx.getCurrentRPCUrl())`
  — the ordered list, rotated to start at the endpoint failover has
  selected. **Load-bearing: this is what makes a failover move these
  reads too.**
- outer `for (const url of urls)`, inner
  `for (let attempt = 1; attempt <= 2; attempt++)`, with `attemptCount++`
- `if (attempt > 1) await` a 3,000 ms delay, and a test-only setter that
  overrides it
- `try { provider = buildProvider(url, ethers) } catch { provider = <fallback> }`
  — **`buildProvider`, never `new JsonRpcProvider`**, or the requests
  escape the global pacing queue
- `noteRpcResult(url, true)` before returning, `noteRpcResult(url, false)`
  in the catch. **Load-bearing: successes are the denominator of the
  failover rate.**
- `lastErr = err` plus one `log.warn("[<tag>] rpc=%s attempt=%d/%d failed: %s", …)`
- `throw new <ErrorClass>(attemptCount, lastErr)` after every endpoint

They differ in **exactly four** things, which are therefore the helper's
whole parameter list:

| Parameter | `getPoolState` | `_readBothBalancesWithRetry` |
| --------- | -------------- | ---------------------------- |
| the work | `_getPoolStateOnce(provider, ethersLib, {...opts, _rpcUrl: url})` | `Promise.all` of two `readBalance({provider, …})` |
| log tag | `pool-state` | `can-reopen` |
| error class | `PoolStateUnavailableError` | `WalletReadUnavailableError` |
| provider fallback | the caller-passed provider | `providerFactory()` |

So the helper is `withRpcRetry({ fn, tag, ErrorClass, fallbackProvider })`
in `src/rpc-retry.js`, and both call sites collapse to a few lines. The
fallback exists only for test mocks whose ethers lacks the constructor —
keep it, both rely on it.

### Done means

1. Both orchestrators deleted, both call sites calling the helper, no
   third copy introduced.
2. The two error classes keep their `(attemptCount, cause)` signatures
   and their current names — callers check them by instance
   (`bot-loop-detect.js:307`, `server-positions.js:597`).
3. The existing tests for both paths pass unchanged, including the delay
   overrides. The helper gets one test for the walk order and one for
   exhaustion.
4. The success path gains the line this duplication has been swallowing:
   endpoint and attempt, so a log says which endpoint served the read.
   See the diagnostic section above.

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
`docs/roadmap/clean-ups/project_consolidate_rpc_retry.md`.
Keep the two in step, and do not add a second entry for it.
