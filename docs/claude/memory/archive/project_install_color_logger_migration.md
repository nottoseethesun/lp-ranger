---
name: project-install-color-logger-migration
description: "CLOSED 2026-06-16 — `installColorLogger()` folded into `src/lib/log.js`'s `_colorize` step; Core Essentials grandfather clause closed."
metadata: 
  node_type: memory
  type: project
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-24T05:23:48.391Z
---

**Status: CLOSED 2026-06-16** in the branch following PR #137 (same branch that added the `prestart` build-artifacts guard).

After PR #137 shipped the opt-in `src/lib/log.js` / `src/client/web/dashboard-log.js` wrapper and migrated every `console.*` call site (94 Node + 25 browser files), the **only remaining monkey-patch** in the codebase was `installColorLogger()` in `src/lib/logger.js` (lines 132-138 as of 2026-06-16): it reassigned `console.log` / `console.warn` / `console.error` at startup to colorize bracketed tag prefixes.

That patch is grandfathered in the Core Essentials rule (`docs/claude/CLAUDE-BEST-PRACTICES.md`), but the grandfather clause should NOT survive long-term. Carve out a dedicated release to remove it.

**Why:** Same reasons the rule exists in the first place — clash risk with other libraries that also wrap the same methods, and security/trust reasoning (a reviewer should be able to trust `console.log(...)` does what it says without spelunking through startup wiring). The whole point of the no-monkey-patch rule is to apply uniformly.

**How to apply (the migration):**

1. Move the `COLORS` table and `HIGHLIGHTS` array (`src/lib/logger.js:67-92`) into a new `_colorize(args)` helper that lives next to `log.info` / `warn` / `error` in `src/lib/log.js`. The wrapper's existing chain — `log.info(first, ...rest) → _sink.log(_withTimestamp(first), ...rest)` — gains a colorize step: `_sink.log(_colorize(_withTimestamp(first)), ...rest)`.
2. Delete `installColorLogger()` and the two `installColorLogger();` call sites in `server.js` and `bot.js`. Keep `emojiId`, `abbrAddr`, `logCtx` in `src/lib/logger.js`.
3. Confirm `npm run check` passes — most call sites already went through `log.info` after PR #137, so the colorization continues to fire for them via the wrapper. The few remaining `console.log` call sites (the three files skipped in the Node migration: `src/lib/log.js`, `src/lib/logger.js` itself, `src/lib/bot-banner.js`) need a separate audit: `bot-banner.js` was already migrated to `log.info` in PR #137, so the only direct `console.*` left would be inside `log.js` (the sink default) — which is correct as the implementation primitive.
4. Update the Core Essentials rule in `docs/claude/CLAUDE-BEST-PRACTICES.md` to drop the "grandfathered" sentence about `installColorLogger`.
5. Update [[feedback-no-global-monkey-patch]] to record that the grandfather clause is closed.

**Scope:** Doesn't need to be bundled with any other feature work — small, self-contained, one-PR. Cosmetic for the operator (log output looks identical) but closes the architectural exception.
