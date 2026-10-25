---
name: unmanaged-view-shows-false-oor-until-synced
description: "Low-priority nice-to-have — Unmanaged view briefly shows \"out of range\" before range/price finish rendering; Managed view displays perfectly"
metadata:
  node_type: memory
  type: project
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-10-24T05:23:48.532Z
---

The Unmanaged view briefly shows a position as "out of range" when first opened, before the range bar + current price have finished rendering. Waiting ~1 minute self-heals (no reload needed). Managed view does not have this issue — it displays perfectly.

**Why:** Low priority because Unmanaged itself is low-priority in this app. But a false OOR banner is misleading to users who glance at the view.

**How to apply:** Improve the sync badge / gating for the Unmanaged view so the OOR indicator (and possibly the range bar) stays hidden or shows "Syncing..." until the Unmanaged data has fully populated. Likely touch points: `src/client/web/dashboard-unmanaged.js`, `src/client/web/dashboard-unmanaged-apply.js`, range render in `src/client/web/dashboard-data-status.js` or `src/client/web/dashboard-data-range.js`.

Confirmed on dev 2026-04-23 at URL `/pulsechain/.../159071`. Related but distinct from `project_sync_badge_closed_positions.md` (closed-position "Syncing..." badge stuck).
