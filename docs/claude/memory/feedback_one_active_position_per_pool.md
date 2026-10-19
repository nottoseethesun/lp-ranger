---
name: feedback-one-active-position-per-pool
description: "One active position per pool, period — no code contemplates two; every path that starts or re-opens a position enforces it, the headless bot included"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-19T00:33:33.524Z
---

LP Ranger supports one active (open) position per liquidity pool, period. Do not build handling that treats two positions in one pool as a case to manage gracefully: no fallback from one to the other, no "if the first fails, start the second". A pool keeps its one position, and any other is refused or comes off the list.

**Why:** on 2026-10-18 I offered, as a choice, a start-up that let a second listed position in a pool start when the first failed. The user: "Remember, the app (of course, including the bot) only supports one single active position per pool, period; go back and fix things as needed per that rule (it's even in the User Manual)." Checking every path then found the server's pool check had never fired in production (an ABI with unnamed outputs), the headless bot had no check at all, and the re-open rule the manual states was enforced only by the page.

**How to apply:** any path that starts, re-opens or lists a position — Manage, the start-up, bot.js, a re-open — must hold to the rule in the core, not only the page ([[feedback_validate_in_the_core_not_the_ui]]). "Active" is open: where a pool has an open position, that one is the pool's. Test a chain read through the real ethers decoder, since a stand-in returning named fields hides an interface that names none.
