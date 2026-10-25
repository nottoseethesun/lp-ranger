---
name: gas_defer_retry_limit
description: Nice-to-have — optional cap on the gas-defer retry loop; not required because the loop uses no gas and the user can halt via LP Browser
type: project
originSessionId: bcc28f64-9d30-4e60-a7b9-e380ad93cf12
modified: 2026-10-24T04:54:55.387Z
---
When estimated gas > 0.5% of position value, the bot defers and retries every 60 min (`GAS_DEFER_MS = 3600_000` in `src/lib/bot-loop.js`). No cap today — for tiny positions where the threshold will never clear, the loop runs forever.

**Why:** Strictly optional. The retry loop consumes no gas (RPC poll + price fetch only). The user has a clean halt path via LP Browser → Remove (documented in the FAQ; PR #129 made the LP Browser button reachable during sync). Most other deferral gates (throttle, daily cap, OOR threshold) also retry indefinitely — that's standard control-loop behavior, not a bug.

**How to apply:** Treat as low-priority polish. If implemented, surface a Telegram notification + dashboard banner on cap-reach and stop polling for that position. Default cap should be forgiving (gas swings significantly over a day; aggressive caps could prematurely give up on positions that would naturally clear). Documented at docs/roadmap/nice-to-haves/project_gas_defer_retry_limit.md and listed in README's Nice to Have's table.
