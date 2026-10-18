# Don't Let a Bookmarked Link Override a Pick Made During the Scan

> **Status:** Nice-to-have / polish — not a bug. The app works
> correctly without this. Funds are never at risk: which position the
> page shows decides nothing the bot does.

## What happens now

Open a bookmarked or shared link to a position this browser has never
stored, such as one opened in a fresh browser, and the dashboard first
scans the wallet for its positions. If you pick a different position
from the Position Browser while that scan runs, the page shows your
pick, and then, when the scan finishes, jumps to the position the link
named.

The page has done what the link asked, only late. Picking your
position again puts it right, and the jump happens at most once per
link opened.

## Why the obvious fix breaks links

The obvious guard is to check the address bar before jumping: if it no
longer names the linked position, someone has moved on, so do nothing.
But the dashboard rewrites the address bar itself when the wallet
loads, to name the position it is showing. That rewrite would trip the
same guard, and the jump a fresh-browser link depends on would be
dropped every time.

## Shape of the fix

The scan's follow-up needs to know whether **you** picked a position
since the link was opened, not merely whether the shown position
changed. That takes a signal only your own click produces, such as a
counter the Position Browser's row click advances, which the follow-up
compares against the value it saw when it began.

Likely touch points: `_tryActivatePosition` in
`public/dashboard-router.js`, which starts the scan and asks the store
again when it finishes, and the row-click handlers in
`public/dashboard-positions-browser.js`.
