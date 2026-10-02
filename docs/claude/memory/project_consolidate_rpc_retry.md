---
name: project-consolidate-rpc-retry
description: "Nice-to-have / future — consolidate the per-URL × per-attempt RPC-retry orchestrator pattern used by getPoolState, can-reopen wallet reads, and likely other sites into a single shared helper."
metadata: 
  node_type: memory
  type: project
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-02T03:12:10.313Z
---

**Status: ACTIVE, and the target changed.** This entry was a deferred
tidy-up; it is now step two of a three-step plan the user set on
2026-10-01, and the destination is different from what the rest of this
file describes. Read the next section before the older material.

## The plan, and where it stands (2026-10-01)

The user's words, in order:

1. *"make the main consolidated failover route properly log one log line
   about success if the previous attempt was a failure and logged as
   such."* **DONE** — `retryRead` (`src/rpc-read-retry.js`) closes a run
   it has logged with one line naming the endpoint that answered and
   whether that endpoint is the one that had been failing. Gated on
   `attempt > 1`. Pinned by `test/rpc-read-retry-recovery-log.test.js`.
2. *"the consolidation of that one path that doesn't use the new
   consolidated failover route, onto the new consolidated failover
   route."* **NEXT.** This is `getPoolState`, and note the target: move
   it **onto `retryRead`**, retiring its private walk. That is NOT the
   `withRpcRetry` helper shared between two private walks that the
   sections below propose — that design keeps the bypass and merely
   deduplicates it. Treat the old sketch as background, not as the spec.
3. *"all logs of failures should, once there is recovery to success,
   result in a single log line about that recovery to success, so that
   the read of the log (dev or user) can be spared wondering if things
   are working."* **Scoped by the user to rpc calls only:** *"no need to
   go exhaustively through the app to check all the other places."*

**What prompted it.** Reading the 0.9.8 Production log, a burst of
`[pool-state]` and `read retry` failures at 20:47 ended in silence. The
user: *"the dev or user is left reading about some bad errors, and
wonders if maybe something isn't working. Do you get it?!!!"* Recovery
and giving up both looked like silence. Being on the centralized
failover route bought no confirmation either — `rpc-read-retry.js` had
exactly one log statement, the failure.

The earlier gate (0.9.8 proving stable) applied to the old tidy-up
framing and no longer holds for steps two and three.

**Also observed in that log and still true:** no failover ever engaged
in 6h 38m, because the rate gate
(`send-transaction.js`, `decideIfCurrentRPCIsOutOfService`) correctly
refused to move for blips lasting seconds. So a recovery line saying
"recovered, no failover" is the common case, not the exception.

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
