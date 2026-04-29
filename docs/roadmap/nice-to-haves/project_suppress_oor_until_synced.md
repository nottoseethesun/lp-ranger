# Suppress False Out-of-Range on Unmanaged View Until Synced

The Unmanaged view briefly shows a position as "out of range" when
first opened, before the range bar + current price have finished
rendering. Waiting ~1 minute self-heals (no reload needed). Managed
view does not have this issue — it displays perfectly.

**Why it matters:** Low priority because Unmanaged itself is
low-priority in this app. But a false OOR banner is misleading to
users who glance at the view.

## Fix when prioritized

Improve the sync badge / gating for the Unmanaged view so the OOR
indicator (and possibly the range bar) stays hidden or shows
"Syncing..." until the Unmanaged data has fully populated. Likely
touch points: `public/dashboard-unmanaged.js`,
`public/dashboard-unmanaged-apply.js`, range render in
`public/dashboard-data-status.js` or
`public/dashboard-data-range.js`.
