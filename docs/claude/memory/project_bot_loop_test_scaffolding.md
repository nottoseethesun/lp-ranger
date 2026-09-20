---
name: bot_loop_test_scaffolding
description: Nice-to-have — startBotLoop's poll/stop lifecycle has no direct test fixture; only its extracted helpers are covered
type: project
originSessionId: bcc28f64-9d30-4e60-a7b9-e380ad93cf12
modified: 2026-09-20T22:28:11.053Z
---
`src/bot-loop.js` exports `startBotLoop` which wires up a `poll()` closure plus `stop()`. The extracted helpers (`pollCycle`, `resolvePrivateKey`, `forceRebalance`, `wireBotStateGetConfig`) are well covered in `test/bot-loop.test.js`. The `poll()`/`stop()` lifecycle itself is not — surfaced when PR #130 fixed the stop-race but couldn't add a regression test for it.

**Why:** Building the fixture needs mocked provider/signer/position/throttle plus deterministic timer control — likely requires extracting the scheduling logic and/or DI for the timer source. That's a non-trivial refactor that shouldn't be bolted onto a stopgap fix.

**How to apply:** Defer until someone takes a dedicated pass at it. When the time comes, expect to extract `_scheduleNext` / the poll closure for direct testability. Documented at docs/roadmap/clean-ups/project_bot_loop_test_scaffolding.md and listed in README's Nice to Have's table.
