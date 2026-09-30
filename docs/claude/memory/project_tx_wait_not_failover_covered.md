---
name: project_tx_wait_not_failover_covered
description: "OPEN BUG, Production 0.9.7, 2026-09-30: a transient rpc 502 during tx.wait() aborts a whole compound or rebalance, because _tolerantWait tolerates only TRANSACTION_REPLACED and tx.wait() never goes through the rpc retry/failover path. The collect had already mined, so fees sat in the wallet with their gas unrecorded."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-30T16:52:24.958Z
---

**Open.** Seen on Production 0.9.7 at 13:21Z on 2026-09-30, on
NFT #164418 (HEX / HEX from Ethereum).

## What happened

An auto-compound collected fees, the collect took longer than
`TX_SPEEDUP_SEC` to confirm, the speed-up was correctly refused because
the original had already mined — and then the compound died on a 502.

```
13:21:09  collect: TX submitted, hash=0x6da417… nonce=1992
13:23:09  collect: TX not confirmed after 120s — speeding up
13:23:10  RPC failover engaged: g4mm4 → rpc.pulsechain.com
13:23:12  collect: speedup origGas=… bumped=… nonce=1992
13:23:13  collect speedup nonce=1992: 'nonce too low' — original TX likely
          mined; not recovering
13:23:13  collect: speed-up send failed — waiting for original
13:23:13  Compound failed: server response 502 Bad Gateway
          (requestUrl https://rpc-pulsechain.g4mm4.io, code=SERVER_ERROR)
```

**The failover fired three seconds before the compound died, and the
compound still died on the endpoint it had just left.** That is the
whole defect in two lines: selection moved to `rpc.pulsechain.com` at
13:23:10, and the receipt wait was still asking `g4mm4` at 13:23:13.
The wait also did not wait — the 502 returned at once and propagated
straight out.

## Root cause

`_tolerantWait` (`src/tx-speedup.js:71`) wraps `tx.wait()` and catches
exactly one error:

```js
return tx.wait().catch((e) => {
  if (e.code === "TRANSACTION_REPLACED" && e.receipt) return e.receipt;
  throw e;
});
```

Everything else rethrows, including a transient `SERVER_ERROR` that the
read path would have retried and failed over. **`tx.wait()` never goes
through `retryRead` or the managed read provider** — it polls whatever
provider the transaction object is bound to. So the rpc failover work of
0.9.6 and 0.9.7 does not cover receipt waits at all.

It bites hardest at exactly this moment, because the "speed-up refused,
wait for the original" branch is a bare `_tolerantWait` with no race and
no fallback (`src/tx-speedup.js`, phase 2).

This is the gap recorded as untested in
[[project_0097_burn_in_watch]] § 1 — the write path under failover.
Fourteen hours of Dev burn-in never fired a compound, so it went to
Production unexercised and failed the first time the two coincided.

## What it leaves behind

The collect **mined**. Two independent proofs: the `nonce too low`
rejection shows nonce 1992 was consumed, and the chain scan at
16:44:47Z reports **"11 IncreaseLiquidity (10 standalone), 11 Collect,
0 drain"** for this NFT. Ten completed compounds account for ten
Collects; the eleventh Collect has no matching deposit. So:

- **The fees moved to the wallet and were never re-deposited.**
  `executeCompound` throws inside `collectFees`, so the ratio swap and
  `increaseLiquidity` never run.
- **They are not swept back automatically.** `_resolveDepositAmounts`
  (`src/compounder.js:248`) re-reads wallet balances **only when a ratio
  swap fired**; with no swap it deposits just that collect's own
  amounts. So stranded fees wait for a rebalance (which mints with the
  whole wallet balance) or for a later compound that happens to swap.
  Not lost, not promptly recovered.
- **The next compound cycle does nothing.** Unclaimed fees are now zero,
  so `executeCompound` returns `{compounded: false, reason: "no_fees"}`
  and logs "No fees to compound".
- **The gas is unrecorded, permanently.** The collect's gas was spent on
  chain, but gas is written in `recordCompound` on the success path
  only. A rescan does not recover it:
  `_supplementGasFromChain` (`src/position-history.js:536`) sums the
  mint TX and the close TX and nothing else. So `nftGasWeiByTokenId`
  stays short by that transaction for the life of the NFT.
- **Nothing reaches the Activity log**, correctly — no
  `IncreaseLiquidity` event exists to scan.

## The fix, when taken up

Make `_tolerantWait` treat a failover-eligible error the way the read
path does: report the outcome, fail over, and re-poll for the receipt,
rather than throwing. The receipt is a read like any other and the
transaction is already on chain — there is nothing to re-send, only
something to re-ask. Keep `TRANSACTION_REPLACED` handling as is.

Check the same pattern at `src/rebalancer-pools.js:237`, which carries
the twin of this code for the rebalance path.

## The missing Telegram was a second bug, now confirmed

`notify("compoundFail", …)` did fire. Telegram refused it with a 400 —
the message carried the raw ethers error dump and
`parse_mode: "Markdown"` could not parse it. See
[[project_telegram_markdown_drops_alerts]]. The operator therefore got
no alert for any of this, which is why the incident surfaced a day
later by reading the log.

## Scale, from the same log

Eleven failovers in the nineteen hours to 16:46Z on 2026-09-30, every
one `g4mm4` → `rpc.pulsechain.com`, no banners, no 429s — the rate-based
failover itself working as designed and at the same beat as Dev. One
compound was attempted in that window and it is the one that broke. No
rebalance ran at all, which is why nothing has folded the stranded fees
back yet.
