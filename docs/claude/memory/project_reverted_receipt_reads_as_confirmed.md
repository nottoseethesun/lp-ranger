---
name: project_reverted_receipt_reads_as_confirmed
description: "FIXED 2026-10-17, uncommitted (on Production since 0.9.8): a transaction that reverted came back as confirmed from the receipt re-ask, or as a speed-up's TRANSACTION_REPLACED receipt; both paths now throw what ethers' own wait would"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T22:54:33.650Z
---

**Fixed 2026-10-17, uncommitted, approved by the user ("#4: Yes,
fix").** `confirmedReceipt` in src/tx-speedup.js reads a receipt's
`status` and throws, for status 0, the CALL_EXCEPTION ethers' own wait
throws, carrying the receipt. Both doors below hand their receipt
through it. A CALL_EXCEPTION that reaches `sendTx.sendTransaction`
also carries the reverted transaction's gas as `gasCostWei`, so the
failed move's gas reaches the open period.

The bug as it was: when the endpoint that broadcast a transaction
fails during the wait for its receipt, a transaction that reverted on
chain was reported as confirmed.

**How it happens.** The wait asks the broadcasting endpoint first, through
ethers' `tx.wait()`, which throws CALL_EXCEPTION for a reverted
transaction. When that endpoint fails instead (a 502, a timeout),
`_receiptAcrossEndpoints` in `src/send-transaction.js` asks the other
endpoints with `getTransactionReceipt` and returns the first receipt it
gets. It never reads the receipt's `status`, and a reverted transaction
has a receipt, with status 0.

**Proven 2026-10-17** by a probe driving the real `sendTx.waitForReceipt`
with a provider stand-in whose wait failed with a 502 and whose receipt
had status 0: the wait resolved with that receipt.

**Who is affected.** Every receipt wait goes through it: the speed-up
pipeline's waits behind every `sendTx.sendTransaction` (approvals, the
drain, the V3 router's swap, the mint, the compound's collect and
deposit) and the aggregator's own swap wait. None of their callers reads
`status` afterwards. For the aggregator swap, the retry loop takes a
reverted swap as one that landed, so it does not re-quote, and the
rebalance carries on with the balances as they are. For the mint, the
operator sees "Mint succeeded but no tokenId was returned".

It needs an endpoint failure during the wait and a revert at once; both
happen on Production (outages, stale aggregator routes).

**A second door, found 2026-10-17 in the state-and-sequence audit.**
`_tolerantWait` in src/tx-speedup.js returns the receipt ethers attaches
to TRANSACTION_REPLACED without reading its `status`. A speed-up that
replaced the move and then reverted therefore comes back as the move's
confirmation, with no endpoint failure needed. The same fix shape covers
both: read `status` wherever a receipt is handed back from a path other
than ethers' own wait.

**Why:** found while tracing the failed-attempt gas fix
([[project_failed_aggregator_gas_dropped]]); it came in with the re-ask
([[project_tx_wait_not_failover_covered]]).

**How to apply:** any new path that hands back a receipt from somewhere
other than ethers' own `wait()` goes through `confirmedReceipt`, or it
reopens this bug.
