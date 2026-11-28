---
name: unmanaged-view-shows-false-oor-until-synced
description: "DONE, archived 2026-11-27 — Unmanaged view briefly showed \"out of range\" before range/price finished rendering; the stale-figures guard now hides the range banner and bar until the position's first answer"
metadata:
  node_type: memory
  type: project
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-11-28T02:36:06.464Z
---

**Status: DONE, found 2026-11-27 and taken off the README's Nice to
Have's at the user's word ("remove any other nice-to-haves that have
either been done or no longer apply").** It was done by a broader
change, not by this plan: the range banner and the range bar carry
`data-position-graphic` (src/client/web/index.html), which the
stylesheet hides while the figures on screen may be another
position's (`body[data-position-data-stale]`,
src/client/web/css/9mm-pos-mgr.css; src/client/web/js/dashboard-stale-data.js).
An unmanaged position counts as fresh only once its first answer has
set price and range together (`markPositionDataFresh` after `_apply`,
src/client/web/js/dashboard-unmanaged.js), and a switch does not
repaint the banner. The note below is the record.

The Unmanaged view briefly shows a position as "out of range" when first opened, before the range bar + current price have finished rendering. Waiting ~1 minute self-heals (no reload needed). Managed view does not have this issue — it displays perfectly.

**Why:** Low priority because Unmanaged itself is low-priority in this app. But a false OOR banner is misleading to users who glance at the view.

**How to apply:** Improve the sync badge / gating for the Unmanaged view so the OOR indicator (and possibly the range bar) stays hidden or shows "Syncing..." until the Unmanaged data has fully populated. Likely touch points: `src/client/web/js/dashboard-unmanaged.js`, `src/client/web/js/dashboard-unmanaged-apply.js`, range render in `src/client/web/js/dashboard-data-status.js` or `src/client/web/js/dashboard-data-range.js`.

Confirmed on dev 2026-04-23 at URL `/pulsechain/.../159071`. Related but distinct from `project_sync_badge_closed_positions.md` (closed-position "Syncing..." badge stuck).
