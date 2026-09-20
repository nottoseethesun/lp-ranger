---
name: project-split-rebalance-paused-flag
description: "Future cleanup — split the overloaded `rebalancePaused` bot-state flag into `rebalanceAborted` (slippage abort, requires user action) and `rebalancePaused` (priceVolatile exhaustion, bot earned the pause). Decided 2026-06-18 to defer."
metadata: 
  node_type: memory
  type: project
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-09-20T22:28:53.320Z
---

**Status: DEFERRED to a future cleanup PR.** User picked option C in the 2026-06-18 closed-position-reopen-via-manage review: leave the flag as-is for now, discipline the user-facing prose via [[feedback_paused_vs_aborted]]. Tackle the rename when there's appetite for a small, focused cleanup PR.

## What's overloaded

The `botState.rebalancePaused` flag is written from two structurally different places with different semantics:

1. **Swap-abort on slippage** — `src/bot-loop.js:194-202` `_handleError`. When the swap quote's price impact exceeds the user's `SLIPPAGE_PCT`, the entire rebalance effort halts instantly. The bot will NOT retry — slippage problems require manual user action 99.9% of the time. "Aborted" fits.
2. **PriceVolatile exhaustion** — `src/bot-cycle-backoff.js:36-52` `_activateSwapBackoff`. When the pool's price keeps moving between swap quote and fill, the bot enters exponential backoff (1m → 2m → 4m … 20m cap). After `REBALANCE_RETRY_SWAP_LIMIT` consecutive failures, the bot pauses itself with an actionable error. "Paused" fits here — the bot earned the pause through exhaustion.

Both paths share the same downstream consumer (`_checkRebalanceGates` in `bot-cycle.js:392` returns early when paused) and the same UI treatment (the "RETRYING" pill in `dashboard-data-status.js:337`, plus the alerts in `dashboard-alerts.js`). They converge enough that splitting downstream isn't worth it — but the flag NAME needs splitting for prose clarity.

## Proposed split

- **`rebalanceAborted`** — set ONLY by `_handleError` on the swap-abort case (when `/swap aborted/i.test(errMsg)`).
- **`rebalancePaused`** — keep the name, set ONLY by `_activateSwapBackoff` after exhausting the priceVolatile retry budget.
- Update `_checkRebalanceGates` to early-return on either flag: `if (!forced && (bs.rebalancePaused || bs.rebalanceAborted))`.
- Update `server-routes.js`'s POST /api/config slippage-change handler to clear BOTH flags (the user changing slippage is the natural action for either case).
- Update `_stampReopenFlagsOnLive` in `src/server-positions.js` to clear both.
- Update the dashboard pill: `RETRYING` for `rebalancePaused`, `ABORTED` for `rebalanceAborted` (or two different colors — talk to the user about wording).

## Files that touch the flag today

Source (~15 places):

- `src/bot-loop.js` — `_handleError` writes (becomes `rebalanceAborted` writer), `_handleRecovery` / `_handleRebalanceSuccess` clear (clear both).
- `src/bot-cycle.js:392` — `_checkRebalanceGates` reads.
- `src/bot-cycle-residual.js:54` — reads to skip residual cleanup.
- `src/bot-cycle-backoff.js:42, 51` — writes (stays as `rebalancePaused` writer).
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
