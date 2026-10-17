---
name: project_foreign_tx_at_nonce_read_as_success
description: "OPEN BUG, rare (found 2026-10-17): a transaction sent from the bot's wallet outside the bot that takes the nonce during phase 1 or 3 of the speed-up pipeline is read as the move succeeding"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T07:05:41.976Z
---

**Open bug, found 2026-10-17 in the branch audit, not fixed. Rare.** In
`src/tx-speedup.js`, phases 1 and 3 wait on the move's own transaction
(and its speed-up). When something else takes that nonce, ethers reports
`TRANSACTION_REPLACED`, and `_tolerantWait` turns that into the receipt
of whatever replaced it. Phase 4 tells the move's own hashes from a
stranger's and fails naming the stranger; phases 1 and 3 do not, so a
transaction sent from the same wallet by another program, landing at
that nonce, is returned as the move's success.

What it would cost: the bot would record a rebalance or compound step
that did not happen, with the stranger's receipt, and go on to the next
step on balances that step never produced.

**Why:** it needs the operator to send from the bot's wallet while a
move is pending, which the app does not expect, so it is rare; it is
still a wrong outcome rather than a refusal.

**How to apply:** the fix is phase 4's rule in phases 1 and 3 — accept a
receipt only for one of the move's own hashes. Ask the user before
changing the pipeline. Related:
[[project_speedup_phase_boundary_race]].
