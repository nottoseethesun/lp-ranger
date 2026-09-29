---
name: feedback-no-global-monkey-patch
description: "NEVER modify standard JS globals (`console.log/warn/error`, `Array.prototype.*`, `Date`, `Math`, `fetch`, etc.) in production code. Use opt-in wrapper modules instead. One exception: test code, only where unavoidable, and the original must be restored pristine immediately after use."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-09-29T06:02:09.195Z
---

NEVER modify standard JS functions or built-ins (`console.log` / `console.warn` / `console.error` / `console.debug` / `console.info`, `Array.prototype.*`, `Date`, `Math`, `fetch`, etc.). This includes wrapping them at startup via "install" / "patch" helpers.

**Why:** Two reasons.

1. **Clashes with other libraries.** Any third-party module that also wraps the same global will either double-wrap (each call goes through both layers, possibly in unpredictable order) or shadow the other's wrapping (one wins, the other silently breaks). In tests, mocking libraries that replace `console.*` will collide. The pre-existing `installColorLogger()` in `src/logger.js` already monkey-patches `console.log/warn/error`; adding another patch on top compounds the fragility.

2. **Security.** Patched globals make it hard to reason about what a `console.log` call actually does. A malicious or buggy patch could exfiltrate strings, mutate args, or swallow errors silently. Code reviewers can no longer trust that `console.log(secret)` only writes to stdout.

**Promoted to canonical project doc:** This rule is also written into `docs/claude/CLAUDE-BEST-PRACTICES.md` under the "Core Essentials" section (the highest-priority bucket in that doc). Treat the canonical doc as authoritative; this memory file is the session-level cross-reference.

**One exception, added 2026-09-29: test code, where unavoidable.** A
test may replace a global when there is no other way to reach the
behaviour under test — controlling the clock to age something out of a
time window is the case that keeps arising, and waiting five real
minutes is not a test. Unavoidable means what it says: if the module
offers an injection seam, use it (`log._setSinkForTests`,
`bot-provider._setDelaysForTests`, `price-source-backoff._setDelays`),
and if it does not but easily could, add one. When a swap really is the
only way, **capture the original first and restore it in a `finally`**,
immediately after the call that needed it — not at the end of the
suite, and never on the success path alone, or a failing assertion
leaks the patched global into every later case in the file. Production
code keeps no exception at all.

**And every such swap is flagged in the code.** The comment opens with
the literal words `TEST-ONLY global swap:`, says why no seam exists,
and states that the original is restored pristine immediately. The
fixed opener is what makes the exception auditable — one grep finds
every use, and a swap without one reads as an oversight rather than a
decision:

```js
/*- TEST-ONLY global swap: ageing a sample out of the window needs the
 *  clock, and there is no seam for it. Restored pristine in the
 *  `finally` below, immediately after the call that needed it. */
const realNow = Date.now;
Date.now = () => nowMs;
```

**How to apply:**

- Need cross-cutting behavior (timestamps, structured fields, redaction, color)? Build a thin **opt-in wrapper module** (e.g. `src/log.js` exporting `log.info/warn/error`). Callers `require()` it explicitly and use `log.info(...)` instead of `console.log(...)`. The global `console` stays untouched; everything that doesn't import the wrapper logs through the unmodified built-in.
- Migrate to the wrapper incrementally — touched files get the new API as you work on them; the rest keep calling `console.*`.
- Same rule for browser code: don't reassign `window.console.log`, `document.querySelector`, etc.; build a module-scoped wrapper and have UI code call that.
- The codebase has **no grandfathered exceptions**. The original `installColorLogger()` exception was retired in a follow-up to PR #137 by folding its tag-color table directly into `src/log.js`'s `_colorize` step. Any future addition of cross-cutting log behavior (redaction, structured fields, log levels) goes in the same opt-in chain.
- Backed out PR #137's `src/log-timestamp.js` (Node) + `public/dashboard-log-timestamp.js` (browser) monkey-patches after this rule was issued. Re-implemented as opt-in `src/log.js` / `public/dashboard-log.js`.
