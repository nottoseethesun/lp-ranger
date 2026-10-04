---
name: project_read_retry_spins_unpaced
description: "FIXED, shipped in 0.9.8; hit Production on 0.9.7 2026-09-30: ethers cached the rejected promise for a retried read, so the retry loop spun in memory and reported one endpoint refusal to the failover decider 678 times. The endpoint received one request, not 678. Fixed with cacheTimeout: -1."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-01T16:40:06.710Z
---

**Fixed**, shipped in 0.9.8 (Production 2026-10-01). Found on Production
0.9.7 at 2026-09-30 16:41:25Z, during a dashboard page reload.

## What the log showed

```
16:41:25Z  read retry #1   on getLogs failed: server response 502 Bad Gateway
   …       676 more, every one 502, every one naming g4mm4
16:41:25Z  read retry #678 on getLogs failed: server response 502 Bad Gateway
16:41:25Z  RPC failover engaged: g4mm4 → rpc.pulsechain.com
```

All 678 in the same second, all naming one endpoint, none after the
failover. The retry numbers are 1..678 with no repeats, so it is one
`retryRead` call going round 678 times, not many callers.

## What it was NOT

**The endpoint was not hammered.** The first reading of this — that 678
requests were fired at a dead endpoint in one second — was wrong, and
measuring it is what corrected it. A real-socket reproduction showed
exactly **two** requests reaching the wire after the endpoint began
refusing: the one real attempt, and the successful retry once selection
had moved. Both properly paced, 219 ms and 441 ms.

The pacer was never bypassed. It was never reached.

## What it was

ethers' `AbstractProvider` holds each request's promise for 250 ms and
hands the same one back to an identical request arriving inside that
window. **A rejected promise is cached like any other**, and the retry
loop retries with identical arguments. So a failed read was answered
from memory, instantly, for as long as the cache entry lived.

Two consequences, and the second is the serious one:

- **The loop spun unpaced.** Pacing is entered inside the patched
  `send()`, and a cached answer never reaches it — which is exactly what
  `src/rpc-read-retry.js` states cannot happen, and its stated reason for
  carrying no backoff.
- **One refusal was counted as hundreds of failures.** Every turn calls
  `note(next, false)` into `src/rpc-out-of-service.js`. So what decides
  failover stopped being the endpoint's failure rate and became the
  loop's iteration count. The rate rule was measuring the wrong thing
  entirely.

## The fix

`buildProvider` passes `cacheTimeout: -1`
(`src/bot-provider.js`). Every retry then becomes a real, paced request
and every reported failure a real endpoint outcome. Measured after the
change: nine requests over two seconds, gaps of 221–224 ms against a
222 ms interval.

The cost is that two identical reads inside 250 ms now cost two
requests. That is the right trade — the global queue is what bounds the
rate, and a cache that also silently bounded it was answering a question
nobody asked it.

Pinned by `test/rpc-read-retry-pacing.test.js`, on a real socket because
the behaviour lives in the seam between ethers' internals and the pacing
wrapper. Its sharpest assertion is that retries logged must not exceed
requests sent: **a retry that never left the process is not a retry.**

## Reproducing anything like it

The fixture has to bank successes first. Selection moves on a failure
RATE, so how long a dead endpoint is retried depends on how much it had
recently been serving. An endpoint that had been idle is abandoned after
a handful of failures and the loop never runs long enough to show
anything. Production reached 678 because a chunked scan had just banked
about that many successes.

That scaling is real and unfixed: **the busier the bot, the longer a
dead endpoint keeps being asked.** Whether a consecutive-failure ceiling
should short-circuit the rate is an open design question, deliberately
not answered here — it would be new mechanism.

## The scan that supplied the traffic

The same reload ran `hodl-baseline mint #164418` for 969 windows and
four minutes, every progress line reporting nothing found.

**Not a missing floor**, which was the first reading and also wrong. The
scan is floored at the pool's creation block, and
`test/nft-scan-floor-coverage.test.js` exempts the file for a reason
that holds: it searches FOR a mint block, so cannot be bounded by one.
The CI gate was behaving correctly.

The defect was **direction**. It walked oldest-first with an early exit,
and the id it looks up is the position's CURRENT NFT — which a managed
position re-mints on every rebalance, so the answer sits near the chain
head while the walk starts at the pool's birth. Fixed by passing
`direction: "desc"`; the existing early exit then ends the walk at the
first window. `src/position-history-mint.js` and
`src/event-scanner-mint-lookup.js` deliberately keep oldest-first,
because both look up OLDER NFTs and that is their near end.

Related: [[project_tx_wait_not_failover_covered]] and
[[project_telegram_markdown_drops_alerts]], both found on the same
Production run and both fixed in 0.9.8.
