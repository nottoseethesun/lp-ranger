---
name: project-split-rebalance-paused-flag
description: "Future cleanup — rename the overloaded `rebalancePaused` bot-state flag, every writer of which now waits for the owner, and record which case set it. Decided 2026-06-18 to defer."
metadata: 
  node_type: memory
  type: project
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-24T02:49:36.548Z
---

**Status: DEFERRED to a future cleanup PR.** User picked option C in the 2026-06-18 closed-position-reopen-via-manage review: leave the flag as-is for now, discipline the user-facing prose via [[feedback_paused_vs_aborted]]. Tackle the rename when there's appetite for a small, focused cleanup PR.

## What's overloaded

The `botState.rebalancePaused` flag is written from two structurally different places with different semantics:

1. **Swap-abort on slippage** — `src/bot-loop.js:194-202` `_handleError`. When the swap quote's price impact exceeds the user's `SLIPPAGE_PCT`, the entire rebalance effort halts instantly. The bot will NOT retry — slippage problems require manual user action 99.9% of the time. "Aborted" fits.
2. **A rebalance the price outran** — `src/price-moved-stop.js` `holdAfterPriceMove`. When the price leaves the new range before the mint, with the old position emptied, the bot holds the position at once for the owner to weigh the impermanent loss and click Rebalance Now (the user's ruling, 2026-10-23). Until then it backed off and retried, up to `REBALANCE_RETRY_SWAP_LIMIT` stops, and paused only once those ran out; that ladder and its three settings are gone, so this case no longer earns a pause by exhaustion, and "Aborted" fits it too.

Both paths share the same downstream consumer (`_checkRebalanceGates` in `bot-cycle.js:392` returns early when paused) and the same UI treatment (the "RETRYING" pill in `dashboard-data-status.js:337`, plus the alerts in `dashboard-alerts.js`). They converge enough that splitting downstream isn't worth it — but the flag NAME needs splitting for prose clarity.

## Proposed split

- **`rebalanceAborted`** — set ONLY by `_handleError` on the swap-abort case (when `/swap aborted/i.test(errMsg)`).
- **`rebalancePaused`** — keep the name, set ONLY by `_activateSwapBackoff` after exhausting the priceVolatile retry budget. (Overtaken 2026-10-23: that writer is gone, and its successor, `holdAfterPriceMove`, holds at the first stop. The public roadmap's form, one flag renamed `rebalanceAborted` that records which case set it, covers every writer.)
- Update `_checkRebalanceGates` to early-return on either flag: `if (!forced && (bs.rebalancePaused || bs.rebalanceAborted))`.
- Update `server-routes.js`'s POST /api/config slippage-change handler to clear BOTH flags (the user changing slippage is the natural action for either case).
- Update `_stampReopenFlagsOnLive` in `src/server-positions.js` to clear both.
- Update the dashboard pill: `RETRYING` for `rebalancePaused`, `ABORTED` for `rebalanceAborted` (or two different colors — talk to the user about wording).

## Files that touch the flag today

Source (~15 places):

- `src/bot-loop.js` — `_handleError` writes (becomes `rebalanceAborted` writer), `_handleRecovery` / `_handleRebalanceSuccess` clear (clear both).
- `src/bot-cycle.js:392` — `_checkRebalanceGates` reads.
- `src/bot-cycle-residual.js:54` — reads to skip residual cleanup.
- `src/price-moved-stop.js` (`holdAfterPriceMove`) — writes.
- `src/server-routes.js:141-142` — clears on slippage change.
- `src/server-positions.js:54, 185` — initializes / clears on key migration.
- `public/dashboard-data-status.js:337` — pill label.
- `public/dashboard-alerts.js:157, 183, 186` — alert visibility.
- `public/dashboard-manage-badge.js` (from this branch) — closed-position Manage button logic.
- `public/dashboard-data.js` (from this branch) — `_updateClosedManageBtn` reads.

Tests: grep `rebalancePaused` in `test/` to find existing coverage; add coverage for the new `rebalanceAborted` writer.

API: `/api/status` exposes the field. Browser code reads it. A rename is a coordinated server+client change — but both sides ship together so it's a single PR.

## Why now-not-now

Splitting is a one-shot rename with a clear blast radius (~15 source files, several tests, the API shape). Not a quick contained fix. Worth a dedicated PR titled "split rebalance{Aborted,Paused} flags" so the rename is reviewable on its own, not bundled into a feature PR.

Cross-links: [[feedback_paused_vs_aborted]] (the prose discipline that this rename would make redundant).

---

**On the public list (2026-09-02).** Published on the README's
Nice-to-Have list as "Split the Overloaded Rebalance-Paused Flag", detailed in
`docs/roadmap/clean-ups/project_split_rebalance_paused_flag.md`.
Keep the two in step, and do not add a second entry for it.
