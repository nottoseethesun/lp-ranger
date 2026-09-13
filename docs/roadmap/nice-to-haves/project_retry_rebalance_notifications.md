# Mark user-notifications about rebalances that are retries, as such

> **Status:** Nice-to-have / UX polish — not a bug. The app works
> correctly without this. Telegram notifications currently say
> "Rebalance Succeeded" for every rebalance regardless of whether
> it was the first establish-the-position move or a follow-up retry
> to course-correct.

For non-initial rebalances, relabel to **"Retry Rebalance Succeeded
(reason)"** so the user can tell at a glance that the bot is
course-correcting rather than doing fresh work. Hides the internal
trigger distinctions (corrective swap, post-backoff retry, residual
cleanup, out-of-range) behind a single "Retry" framing, with an
optional parenthetical only where it adds clarity.

## Proposed label decision tree

- **Initial** rebalance for the position chain: `"Rebalance
  Succeeded"` (unchanged).
- **Retry** + `trigger === "residual-cleanup"`: `"Retry Rebalance
  Succeeded (wallet residual coin cleanup)"`.
- **Retry** + `trigger === "manual"`: `"Retry Rebalance Succeeded
  (manual)"`.
- **Retry** + `trigger === "out-of-range"`: `"Retry Rebalance
  Succeeded"` (no parenthetical — OOR is the default cause and adding
  "(out of range)" doesn't tell the user anything new).

## Implementation sketch

- `src/bot-cycle.js#_handleRebalanceSuccess`: detect retry via
  `deps._rebalanceEvents.length === 0` at the time of the success
  call (the history-scan populates this array; the just-completed
  rebalance is not in it yet at that point — zero means initial,
  ≥ 1 means retry). Build the label and pass it through the
  `notify("rebalanceSuccess", { … })` payload.
- `src/telegram-notifications/telegram.js`: when `payload.label` is
  supplied, use it as the heading instead of the default
  `EVENT_LABELS.rebalanceSuccess`. Keeps the single `rebalanceSuccess`
  event type and its toggle, so users get one unified on/off for
  both initial and retry notifications.
- Dashboard Activity Log: apply the same label so Telegram and the
  dashboard stay consistent. Replaces the current `(Residual
  Cleanup)` suffix with the new framing.

## Scope

Independent feature change; new branch.

## Context

A normal OOR rebalance and the residual-cleanup rebalance that follows
it both send `Rebalance Succeeded`, with nothing in the message to tell
them apart. The pair fires minutes apart by design, so in Telegram it
reads as the bot rebalancing twice for no reason. Distinguishing the
two is the point of this item.
