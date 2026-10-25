---
name: Sound gate uses input-idle only — by design
description: Polling-driven compound/rebalance jingles playing when browser input-idle timer hasn't fired is correct; don't re-propose document.hidden / server-pause / visibility gates without explicit ask
type: feedback
originSessionId: 07cc2228-b226-49e1-ab79-d7e34d6e38c0
modified: 2026-10-24T05:24:12.695Z
---
`playSound()` in `src/client/web/dashboard-sounds.js` gates only on `isSoundsEnabled()` and `isBrowserPaused()` (15-min input-idle timer in `src/client/web/dashboard-idle.js`). It intentionally does NOT consult `document.hidden`, the server-side idle flag, or `document.hasFocus()`.

**Why:** Validated 2026-05-10. User reported a compound jingle that played after the server had already entered server-idle pause but before the browser's input-idle timer fired (CSRF 403 pause/unpause both arrived right after the compound, indicating browser only detected idle on user return). I proposed adding a `document.hidden` check; user said "working as expected." So the design contract is: the gate's job is the "user logs back in after hours away" backlog scenario only — not the "user briefly stepped away mid-window" case.

**How to apply:** When a user reports a polling-driven jingle playing in a scenario where some other idle indicator was set (server-pause, hidden tab, blurred window), default to "expected behavior" and confirm with the user before proposing to tighten the gate. The current scope was a deliberate choice, not an oversight.
