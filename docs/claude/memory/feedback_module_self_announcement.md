---
name: Modules announce themselves; don't expose init hooks for foreign callers
description: A module's start-up message (banner, "ready" line) comes from its own start function, which the entry point's calls already reach; never from a function exported for a foreign module to call, and never from its top level
type: feedback
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-21T16:33:53.245Z
---
When module A has something to announce as it starts (a banner, a version
line, a "ready" line), A's own start function does it: the function the
program's calls already reach for A's real work. **Do NOT** export a
`printBanner()` / `init()` for module B to call only for that. It
miscasts B as A's orchestrator and bleeds A's responsibilities into B.

**Why:** the bot-banner refactor. I made `server.js` call
`printBotStartedBanner()` from the bot module. The user: "Why on earth
did you make `server.js` call a `printBotStartedBanner` function? The
server is not the bot. The bot is not the server." My fix then put the
banner at the top level of a bot module, run by a `require` the server
already made. That half no longer stands: since 2026-10-21 nothing runs
when a file is loaded except in the program's entry point
([[only-the-entry-point-runs-at-load]]). Code written to the old advice
stays until the user asks for it to change.

**How to apply:**
- A lifecycle marker goes in the owning module's own start function (for
  the bot, what starts a bot loop): never at the module's top level, and
  never in a function exported only so a foreign module can call it.
- Smell: a foreign module calling `require("./other").startOther()` for a
  start-up effect alone.
- Exception: a function the caller must parameterise (e.g.
  `installColorLogger()` patching console with the caller's settings, or
  `readPriceCacheSettings(skipBackups)`) is exported, and the entry point
  calls it.

Related but distinct: `feedback_engineering_invariants.md`
(single source of truth), `feedback_kiss.md` (prefer simple). This one is
about respecting module identity and responsibilities at boundaries.
