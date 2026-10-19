---
name: project_0099_burn_in_watch
description: "Release 0.9.9 cut 2026-10-04 and running on Dev, not yet on Production. Its subject is again the transaction path, which Dev burn-in cannot reach by waiting — force a Compound or Rebalance or the release ships unexercised for the fourth time."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-04T18:02:35.696Z
---

Release **0.9.9** cut 2026-10-04.
<https://github.com/nottoseethesun/lp-ranger/releases/tag/0.9.9>
Tag points at `eaad836` — PRs #227, #228, #229, 39 commits.
Supersedes [[project_0098_burn_in_watch]], now in `archive/`.

**Running on Dev only.** The user is holding it there for a while
before deploying to Production, so a Production deploy is still ahead,
not behind.

## 0. The release's subject is the transaction path again

Three of the release's five headline fixes sit on the write path: the
aggregator sending a swap twice, a stuck transaction abandoned rather
than replaced at higher gas, and an endpoint failure mid-transaction
taking the process down. None of them can be observed by a Dev run that
sends nothing.

[[project_0098_burn_in_watch]] § 2 is the standing lesson and it has now
held for four releases: **waiting does not reach the write path.** Dev
positions stay in range, so nothing moves, and ten hours buys no more
coverage than one. If this release's subject matters, burn-in has to
force a move — a manual Compound or Rebalance on one position.

Never yet run in the field, carried forward again:

- `settleNonce` asking the chain which of a swap or its cancel mined
- the `nonceUnsettled` flag declining the router fallback
- any speed-up or cancel phase. `grep -icE "speeding up|cancel TX"`
  across the whole of the pre-release Dev run returned **zero**

## 1. What 0.9.9 adds that IS observable by waiting

Four figures now decline to record a value rather than writing a zero,
and each says so in the log. Phrases to watch:

```bash
grep -E "left unknown|not caching a short|not recording a short" logs/lp-ranger.log
grep -E "baseline .* deferred|re-reading the initial residual" logs/lp-ranger.log
```

**A hit is not a defect.** It means a real endpoint failure was caught
instead of being written down as a zero, which is the fix working.
Note the NFT when one fires.

Likewise the rpc recovery line: a run of endpoint failures should now
end with a line naming the endpoint that served the retry. A run that
simply stops is the thing to flag.

## 2. What the pre-release Dev run showed

Roughly three hours on the shipped code before the release was tagged
(`#229` changed no shipped file, so the burn-in commit and the tag are
equivalent for this purpose):

- **An overnight compound on NFT #164418**, 04:32 local / 09:32:53Z —
  both transactions confirmed, no speed-up, no cancel.

  **A compound is not a swap, and that is the whole point here.**
  `compounder.js` collects fees and calls `increaseLiquidity` on the
  same NFT: no swap, no range change, no new NFT. So it exercises
  `sendTransaction`, phase 1 of the speed-up pipeline and
  `receiptGasWei` — and reaches none of the release's headline
  subject, which lives in the aggregator swap path. Compounds alone
  will never prove 0.9.9.

  Compounds are routine, not a rarity to be cited as coverage:
  **184 records** in `bot-config.json`, the previous one 2026-09-28,
  before that 09-22, 09-21, 09-18. What burn-in windows keep failing
  to catch is a **swap** — a rebalance, or a compound that happens to
  need one.
- `g4mm4` 502 bursts throughout, every run closing with a recovery line
  naming the endpoint that served the retry
- two `Pool state error: exhausted` events — a read gave up and the
  dashboard showed `pool-info-unavailable` for that cycle
- clean shutdown at 17:15:09Z, ten bot loops stopped in the same second

**That log is gone.** The log file is recreated on restart, so the
evidence above survives only here. The 0.9.9 run started fresh at
17:56:00Z with 22 positions in config, ten of them running.

## 3. Carried forward, still unresolved

**The 429 backoff has still never fired** — `rpcRetryOn429DelaysMs` and
`rpcMax429PenaltyMs`, untested in the field across five releases now. A
429 must produce a wait and a retry, never a failover.

**The Impermanent Loss Guard at 15%** remains unproven, since proving
it needs a rebalance. A position sitting rejected for weeks on a
sideways pair is the failure mode.

**The stranded fees from the 0.9.7 compound failure** (NFT #164418) —
the 09:32 compound was on that same NFT, so this may now be resolved.
Not asserted: the log that would show it has been rotated away. Confirm
against the position's Fees Compounded before closing it out. See
[[project_tx_wait_not_failover_covered]].

The standing bar is [[project_maturity_staircase]]: stability outranks
features. Dev's wallet is not representative —
[[project_test_wallet_is_atypical]].
