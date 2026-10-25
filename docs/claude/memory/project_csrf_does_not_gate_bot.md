---
name: CSRF does not gate the bot
description: Architectural invariant — CSRF guard runs only for browser HTTP POSTs; the bot operates as direct in-process calls and is unaffected by CSRF state.
type: project
originSessionId: 78d8132a-823f-4938-9a72-c4083d75282a
modified: 2026-10-24T04:57:19.869Z
---
**Invariant:** The CSRF guard in `src/server/server-csrf.js` (`if (method !==
"GET" && method !== "OPTIONS")`) runs only for inbound HTTP requests
from the browser. The bot loop, rebalancer, compounder, and
position-manager all execute as **direct in-process function calls**
inside the same Node process — they never hit the HTTP server.

**Why:** Came up 2026-05-03 when a `[csrf] 403 POST
/api/pause-price-lookups — Expired CSRF token` appeared in the Prod
log after overnight idle, and the user reasonably worried that the
24×7 position-management work might be disrupted. It cannot be: a 403
on a dashboard POST blocks only the corresponding UI bookkeeping
toggle, never the bot's polling/rebalance/compound flow. Confirmed by
the log — bot kept polling through the 403 window.

The 0.7.2 fix (CSRF instant refresh + on-403 retry) closed the
user-visible failure window for browser POSTs but did not change this
invariant.

**How to apply:**

- When triaging any "is the bot affected?" worry tied to HTTP-layer
  behavior (auth, rate limit, CORS, CSRF, idle pauses, etc.), check
  whether the path under review is an HTTP request from the browser
  or an in-process function call. Bot ≠ HTTP client.
- Server-side modules that DO take HTTP input and mutate bot state
  (e.g. `src/lib/server-positions.js` `handleManage`, `_handleApiConfig`)
  are still gated by CSRF — that's the correct surface for the guard.
- The idle-driven price-lookup pause is also independent of the bot's
  decision loop; per-rebalance/compound flows wrap critical price
  reads in `withFreshPricesAllowed` to bypass the pause and TTL.
