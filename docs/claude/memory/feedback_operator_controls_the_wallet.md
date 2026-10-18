---
name: feedback_operator_controls_the_wallet
description: "What the operator sends from the bot's wallet outside the bot is not a bot bug; the operator controls the wallet"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-17T16:54:26.056Z
---

A transaction the operator sends from the bot's own wallet, outside the
bot, is not a defect to guard against. The case raised on 2026-10-17
was one taking a pending move's nonce, which the speed-up pipeline reads
as the move's success in phases 1 and 3.

**Why:** the user, 2026-10-17: "Nothing to do there, and since the user
controls the wallet anyway, not a problem." The operator who sends from
the bot's wallet mid-move knows they did, and the app does not need
defending against its own owner.

**How to apply:** do not report the wallet owner's own actions as bugs,
and do not ask about them. This is not about a third party or a
compromised key, which is a security question. Related:
[[feedback_bug_only_if_current_stack_breaks]],
[[feedback_no_finding_without_a_failure]].
