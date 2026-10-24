# Suppress False Out-of-Range on Unmanaged View Until Synced

> **Status:** Nice-to-have / polish — not a bug. Funds are never at
> risk.

The Unmanaged view briefly shows a position as "out of range" when it is
first opened, before the range bar and the current price have loaded.
About a minute later the banner corrects itself, with no reload. The
Managed view does not do this.

**Why it matters:** Low priority, because the Unmanaged view is
low-priority in this app. But a false out-of-range banner misleads
anyone who glances at it.

## Fix when prioritized

Improve the sync badge / gating for the Unmanaged view so the OOR
indicator (and possibly the range bar) stays hidden or shows
"Syncing..." until the Unmanaged data has fully populated. Likely
touch points: `src/client/web/dashboard-unmanaged.js`,
`src/client/web/dashboard-unmanaged-apply.js`, range render in
`src/client/web/dashboard-data-status.js` or
`src/client/web/dashboard-data-range.js`.
