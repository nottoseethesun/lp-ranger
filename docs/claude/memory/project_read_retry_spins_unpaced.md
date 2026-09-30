---
name: project_read_retry_spins_unpaced
description: "OPEN BUG, Production 0.9.7, 2026-09-30: retryRead fired 678 getLogs calls at a dead endpoint inside ONE second, disproving the module's stated reason for having no backoff. The same scan's successful chunks were paced at ~270ms, so pacing was live and the retry path escaped it."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-30T16:56:54.586Z
---

**Open.** Production 0.9.7, 2026-09-30 16:41:25Z, during a dashboard
page reload.

## What the log shows

```
16:41:25Z  read retry #1   on getLogs failed: server response 502 Bad Gateway
   …       676 more, every one 502, every one naming g4mm4
16:41:25Z  read retry #678 on getLogs failed: server response 502 Bad Gateway
16:41:25Z  RPC failover engaged: g4mm4 → rpc.pulsechain.com
```

Every one of the 678 carries the **same second**, all name the same
endpoint, and all precede the failover. Zero retries follow it — the
move worked and the read then succeeded.

## Why that should be impossible

`src/rpc-read-retry.js` states its own invariant:

> **Why there is no backoff.** Every provider is built by
> `bot-provider.buildProvider`, which funnels each call through the
> global pacing queue (`src/rpc-request-manager.js`), so attempts are
> already spaced by `globalRPCRequestRateIntervalMS` and this loop
> cannot spin.

At the shipped 222 ms, 678 requests take 150 seconds. They took under
one.

**Pacing was live at the time**, so this is not an operator who turned
it off: the same hodl-baseline scan ran 900 chunks between 16:39:40Z and
16:43:43Z — 243 seconds, about 270 ms per chunk, which is 222 ms plus
overhead. The scan's *successful* requests were paced; its *retries*
were not.

`rpc-request-manager._drain` is sound on inspection — it shifts one
resolver per call and re-arms — and `_patchRequestPacing` awaits
`acquire()` before every `send()`. So the bypass is somewhere between
`retryRead` calling `next[prop].apply(next, args)` and the patched
`send()`, and finding it wants a targeted test rather than more log
reading. Reproduce with a provider that 502s and assert the wall-clock
spacing between successive `read retry` attempts.

## The second half: the threshold scales with traffic

678 is not arbitrary. The decider moves when failures exceed half of
what the endpoint served in the last five minutes, and the scan had just
banked several hundred successes. The bot had to fail about as many
times as it had recently succeeded.

Burst sizes across the same nineteen hours, by the highest retry number
each reached: mostly 1–40, with outliers at 69, 79, 92, and this 678.
An idle bot crosses at roughly 28 (see
[[project_0097_burn_in_watch]]); a bot mid-scan crosses at 678.

That is the rate rule working as designed, and it is also a cost nobody
priced: **the busier the bot, the longer a dead endpoint keeps being
asked.** Worth deciding whether a consecutive-failure ceiling should
short-circuit the rate — a hundred straight refusals is not a rate
question. That would be new mechanism, so it is a decision to take
deliberately, not a fix to slip in.

## Context: what the reload cost

The browser reload at 16:37:45Z kicked off `hodl-baseline mint #164418`,
a **969-chunk** scan that ran four minutes and returned **0 results** in
every progress line.

**That scan has no mint floor.** `_resolveBaseline`
(`src/position-details-quick.js:122`) calls
`getPositionBaseline(provider, ethersLib, position)` with three
arguments; the scan's `fromBlock` parameter defaults to `0`
(`src/hodl-baseline.js:151`). The NFT was minted 2026-08-25, so
everything before that block is walked for nothing.

This is the case CLAUDE.md § "Per-NFT Scan Windows" says cannot ship:
`test/nft-scan-floor-coverage.test.js` is supposed to fail CI for a
chunked scan whose label names a tokenId, and this scan's label is
`hodl-baseline mint #${tokenId}`. Either the test does not reach this
call site or the pattern misses it — check the test before fixing the
scan, because a gate that missed this will miss the next one.

It is also what gave the retry storm something to ride on: without four
minutes of scan traffic there would have been no large denominator and
no 678-deep burst.

Related: [[project_tx_wait_not_failover_covered]],
[[project_telegram_markdown_drops_alerts]] — the other two open bugs
from the same log.
