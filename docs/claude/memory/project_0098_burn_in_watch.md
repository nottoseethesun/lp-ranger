---
name: project_0098_burn_in_watch
description: "Release 0.9.8 ('Cole Younger - 8') deployed to Production 2026-10-01. Ten hours of Dev burn-in on the exact commit proved the read path and failover again, and proved nothing about what the release actually changed: not one transaction fired, so the whole swap and nonce path shipped unexercised."
metadata:
  node_type: memory
  type: project
---

Release **0.9.8** cut and deployed to Production 2026-10-01, as an
Update. <https://github.com/nottoseethesun/lp-ranger/releases/tag/0.9.8>
Tag points at `16e83c2` — PRs #215 through #226.
Supersedes [[project_0097_burn_in_watch]], now in `archive/`.

Dev ran that exact commit for about ten hours with ten positions
managed, one session, no restarts, then a clean shutdown.

## 0. The release's own subject went to Production unexercised

**This is the top open risk, and it is sharper than the usual
"untested" note.** Every behavior change in 0.9.8 sits on the
transaction path, and the Dev run sent **zero transactions** — no swap,
no rebalance, no compound, in ten hours. So burn-in confirmed the parts
of the build nobody changed.

Specifically never run in the field:

- `settleNonce` asking the chain which of the swap or its cancel mined
- the `nonceUnsettled` flag declining the router fallback
- a chunked swap keeping the chunks that completed
- `receiptGasWei` against a live receipt
- the corrected aggregator submit log

The last one is the cheapest confirmation available and worth taking
first. The submit line's `gasPrice` should read about **1.5×** the
nearest preceding `feeData:` line. Before this release it printed the
pre-multiplier price, so a submit that matches `feeData` exactly means
Production is not running what was shipped.

```bash
grep -E 'swap \(aggregator attempt|feeData:' logs/lp-ranger.log | tail
grep -E 'unsettled|partial swap|cancel at nonce' logs/lp-ranger.log
```

The second command should stay empty. Those phrases are the release's
new failure paths, not its normal operation.

## 1. Nobody has ever seen these defects fire

The three doors to a double swap were found by **audit, not by an
incident**. No log line anywhere shows funds swapped twice. That cuts
both ways and the second way is the one to hold on to: there is no
signature to watch for the fix working, because there was never a
signature of it failing. The evidence that 0.9.8 is right will only
ever be the absence of something that was already absent.

So the burn-in question for this release is not "did the fix work" but
"did the rewritten path still do the ordinary thing" — a swap that
times out once and succeeds on the re-quote, with one nonce consumed.

## 2. Dev burn-in cannot reach the transaction path by waiting

Three releases running, the write path under failover has gone to
Production unexercised, and each time for the same reason: the Dev
positions stayed in range, so nothing moved. Waiting longer does not
fix this. Ten hours bought no more transaction coverage than one hour
would have.

If the transaction path matters to a release, burn-in has to **force a
move** — a manual Compound or Rebalance on one position — rather than
hope the market supplies one. That is the single change that would have
made this release's burn-in mean something.

## 3. What the ten hours did prove

The read path and rate-based failover, again, and cleanly:

- one real failover at 09:48:03Z, `g4mm4` → `rpc.pulsechain.com`, after
  78 read retries
- a nine-retry blip at 06:59 absorbed with no failover — the designed
  outcome, the retry loop serving the reads
- a six-second 502 burst at 14:10 absorbed with four retries
- the hourly snapback at 11:25–11:33 returning to `g4mm4`, finding it
  still sick, and absorbing that too
- zero `ALL 3 RPC ENDPOINT` banners, zero 429s

Every one of the 95 error lines in the run was a 502 from that one
endpoint. Two `1 new mint(s) produced 0 rebalance pairs` warnings match
[[project_rebalance_data_lag]] and are not new.

A handful of daily failovers remains the baseline, not a regression —
see the archived [[project_0097_burn_in_watch]] § 0 for why the sticky
window produces a repeating cycle.

## 4. Carried forward, still unresolved

**The 429 backoff has still never fired.** `rpcRetryOn429DelaysMs` and
`rpcMax429PenaltyMs` are untested in the field across four releases.
A 429 must produce a wait and a retry, never a failover.

**The Impermanent Loss Guard at 15%** is still unproven, because
proving it needs a rebalance. A position sitting rejected for weeks on a
sideways pair is the failure mode; the number is one literal in
`bot-config-defaults.json`.

**The stranded fees from the 0.9.7 compound failure** (NFT #164418) are
still stranded as far as any log shows. They fold back on the next
rebalance or on a compound that happens to swap, and neither has
happened. See [[project_tx_wait_not_failover_covered]].

The standing bar is [[project_maturity_staircase]]: stability outranks
features. Note that Dev's wallet is not representative —
[[project_test_wallet_is_atypical]].
