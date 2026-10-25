---
name: CSRF 403 retry observability — CLOSED 2026-05-10 PR #124
description: CLOSED 2026-05-10 PR #124. Server now logs `[csrf] retry succeeded for <METHOD> <url>` mirroring the 403 warning.
type: project
originSessionId: 2026-05-04-pause-fetch-fix
modified: 2026-10-24T05:23:58.318Z
---

**Resolved 2026-05-10** in PR #124 (`no-sounds-when-idle-and-optimize-csrf`).

**What shipped:**
- `src/server/server-csrf.js` `handleCsrf` keeps a per-`(method, url)` ring
  buffer of recent 403s (30 s window).  When the next valid verify
  lands on a `(method, url)` in that buffer, it logs
  `[csrf] retry succeeded for <METHOD> <url>` and clears the entry.
  Mirrors the existing `[csrf] 403 <METHOD> <url> — <reason>` warn so
  operators can confirm silent recovery.
- `src/client/web/dashboard-helpers.js` `fetchWithCsrf` now also retries on
  `Unknown CSRF token` (same root cause as `Expired` — token aged
  past TTL AND already pruned from `_issued` because pruning runs
  only when `_issued.size >= 500`).  Closes the gap that left
  `Unknown` 403s dropping requests silently.
- Tests in `test/server-csrf.test.js` (5 cases for ring buffer +
  retry log) and `test/dashboard-csrf-fetch.test.js` (Unknown→retry
  case).
- Docs in `docs/engineering.md` § CSRF Tokens.

**How to apply:** This memory exists as historical record only.
Future questions about "did the silent retry recover?" can be answered
from server stdout directly (look for the matching
`[csrf] retry succeeded` line).
