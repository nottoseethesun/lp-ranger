# Consolidate the Transaction Speed-Up / Cancel Pipeline

> **Status:** Internal cleanup &mdash; not a bug. Both copies work
> correctly and read the same two settings, so they behave the same
> today. Funds are never at risk.

## Plain language

When LP Ranger sends a transaction, it waits for the blockchain to
confirm it. If the transaction sits unconfirmed too long, the app sends
a replacement at a higher gas price, and if that still does not confirm,
it cancels the stuck slot so the bot can carry on.

That whole procedure exists twice, in two files, written out separately.

## Detail

`src/tx-speedup.js` holds the pipeline used by
`src/send-transaction.js`, the app's single transaction entry point.
`src/rebalancer-pools.js` carries its own copy: `_waitOrSpeedUp`,
`_cancelGasPrice`, `_receiptGas`, `_baseSigner`, `_resetNonce`, and
inline `_tolerantWait` / `_extractReceipt` closures. Four of those have
byte-identical bodies. Both read `TX_SPEEDUP_SEC` and `TX_CANCEL_SEC`,
so the timings match; the visible difference is the log prefix,
`[send-tx]` against `[rebalance]`.

Two copies of one procedure drift on the next fix: a change made in one
place leaves the other behind, and nothing fails to warn about it.
[CLAUDE-BEST-PRACTICES.md](../../claude/CLAUDE-BEST-PRACTICES.md) names
that a deal-breaker under **NEVER mirror code**.

`src/tx-speedup.js` is the module the duplicate would import. It was
extracted from `send-transaction.js` when that file reached its 500-line
cap, and it takes no module state: it is handed a transaction and a
signer and works with those alone, so nothing about it is specific to
the caller.

## Why it is deferred

The duplicate sits in the rebalance path, which is the code that moves
money. Merging the two means the log prefix becomes a parameter and
every rebalance's wait, speed-up and cancel runs through the shared
copy. That is a behaviour-preserving change on paper, and still wants
its own branch, its own reading, and a burn-in on Production rather than
riding along with unrelated work.
