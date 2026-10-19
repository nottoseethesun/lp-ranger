# Mark user-notifications about rebalances that are retries, as such

> **Status:** Nice-to-have / UX polish — not a bug. The app works
> correctly without this.

Every rebalance sends the same Telegram alert, "Rebalance Succeeded". A
normal out-of-range rebalance and the residual-cleanup rebalance that
follows it minutes later, by design, therefore read in Telegram as the
bot rebalancing twice for no reason. Telling the two apart is the point
of this item.

The proposal: label rebalances after the first as **"Retry Rebalance
Succeeded (reason)"**, so the operator can tell at a glance that the bot
is course-correcting rather than doing fresh work. The trigger
(`manual`, `residual-cleanup` or `out-of-range`) shows as a
parenthetical only where it adds something.

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

## Open question

By the test above, every rebalance after a position's first is a
"retry", including a routine out-of-range rebalance days later. The aim
is only to mark follow-ups as retries, so settle what counts as one
before building this: for example, a rebalance whose trigger is
`residual-cleanup`, or one that comes within some window of the last.

## Scope

Independent feature change; new branch.
