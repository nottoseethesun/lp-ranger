---
name: feedback-reliability-before-responsiveness
description: "In finance, reliability beats responsiveness: let every prerequisite (a decrypt, a setup) finish before work that depends on it starts, even if a dialog answers later"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-26T05:11:25.393Z
---

When a design trades reliability against responsiveness, choose
reliability. Let every prerequisite step, a decrypt or a setup, finish
before anything that depends on it starts, even when a dialog answers
later for it.

**Why:** the user, 2026-11-25, choosing between two fixes for an alert
the start-up could lose: decrypt the stored api keys before the bot
takes the wallet key (the unlock answers about 0.7 s later), or keep the
order and make only the alert wait. "In finance, reliability is more
important than responsiveness: So, I'd prefer a design that waits for
all decrypts to finish before going on to the other tasks."

**How to apply:** when setup races its use, prefer an order that
finishes the setup first over a patch that makes one consumer wait, and
say what the wait costs in time. A prerequisite that fails counts as
finished, logged, and never blocks the core job: a Telegram key that
will not decrypt still lets the positions start. Related:
[[feedback-no-close-action]], [[feedback_no_delay_patches]].
