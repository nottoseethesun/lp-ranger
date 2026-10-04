---
name: project_tx_wait_not_failover_covered
description: "FIXED, shipped in 0.9.8; hit Production on 0.9.7 2026-09-30: a transient rpc 502 during tx.wait() aborted a whole compound or rebalance, because _tolerantWait tolerated only TRANSACTION_REPLACED and tx.wait() never went through the rpc retry/failover path. The collect had already mined, so fees sat in the wallet with their gas unrecorded."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-01T16:39:29.860Z
---

**Fixed**, shipped in 0.9.8 (Production 2026-10-01). Hit Production on
0.9.7, at 13:21Z on 2026-09-30, on NFT #164418 (HEX / HEX from
Ethereum). The stranded fees it left are still stranded — see
[[project_0098_burn_in_watch]] § 4.

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

## The fix taken

`_tolerantWait` accepts an `onWaitError` callback and `send-transaction.js`
supplies `_receiptAcrossEndpoints`, which re-asks through
`getManagedReadProvider().waitForTransaction(hash)`.

Injection rather than an import, because `tx-speedup.js` states in its
own header that nothing in it consults the endpoint list or the failover
window. That seam is worth keeping and costs nothing here: the module
has exactly one caller, and that caller is the module which owns
failover.

Nothing reports or fails over explicitly. **A receipt is a read** — the
transaction is already broadcast, so the only thing needed is to ask a
different endpoint the same question, and the managed read provider
already reports outcomes to `rpc-out-of-service.js` and fails over by
itself. Adding either on top would be a second failover mechanism racing
the first.

Errors describing the TRANSACTION rather than the endpoint — a revert —
re-throw untouched, and `TRANSACTION_REPLACED` still returns the
replacement's receipt.

Pinned by `test/receipt-wait-failover.test.js`. Its strongest case
asserts the receipt arrives carrying the OTHER endpoint's name, since a
receipt from the original endpoint would prove nothing.

**One caution for whoever reads the tally next.** Engaging a failover
clears the samples for the endpoint being left, so
`decideIfCurrentRPCIsOutOfService` reads false immediately after a
successful move. An assertion that the failing endpoint is "out of
service" can therefore never hold once the move has happened; what
survives as evidence is selection having advanced.

`src/rebalancer-pools.js` carried a second, 180-line copy of this whole
pipeline, holding this defect and three more besides — `unref`'d timers,
no abort for the losing branch of a race, no re-ask hook at all. Nothing
ever called it, so none of that could fire: the one `_waitOrSpeedUp` the
app reaches is `tx-speedup.js`, through `send-transaction.js`. Deleted
2026-09-30, with its private `_cancelGasPrice`, `_baseSigner` and
`_resetNonce`; the gas helper stayed, because `_ensureAllowance` uses it.
That helper was the one name the roadmap entry listed as duplicated which
was not dead — worth knowing before trusting a list like that. It is no
longer called `_receiptGas` and no longer lives there: the same expression
turned out to exist thirteen times across nine modules, and it is now
`receiptGasWei` in `src/receipt-gas.js`, shared by every path that records
a charge.

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
