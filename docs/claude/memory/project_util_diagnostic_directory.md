---
name: util/ directory convention
description: util/diagnostic/ is for non-standard dev/diagnostic tooling; scripts/ is for normal operations (including standard dev ops like clean/nuke)
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-19T18:30:30.713Z
---
The repo has two distinct dev-tooling directories:

- **`scripts/`** — Standard operations, including standard dev operations (e.g. `npm run clean`, `npm run nuke`, `clear-pool-cache.js`). Wired into `package.json` scripts.
- **`util/`** — Non-standard dev tooling. Sub-folder `util/diagnostic/` for investigative read-only tools that an end user might also occasionally run.

**Constraints for `util/diagnostic/`:**
- Node only (no shell scripts, no other languages).
- Read-only by default — no mutations, safe to run while the bot is live.
- Friendly to non-developers: clear usage messages, sensible defaults.

**Why:** User drew the distinction explicitly on 2026-04-28 when asked to write phantom-IL/G investigative tools. They wanted these separate from `scripts/` so the standard-ops directory stayed clean.

**How to apply:** When creating a new investigative/diagnostic tool, put it in `util/diagnostic/`. When creating a new standard-ops script (something likely to be wired into a `package.json` `npm run` entry), put it in `scripts/`.

**Existing tools (2026-04-28):**
- `util/diagnostic/inspect-pool.js` — file-only inspector for `app-config/user-configurable/bot-config.json` + `app-data/scan-cache/pnl-epochs-cache.json`
- `util/diagnostic/reconcile-hodl/` — on-chain HODL reconciler (sums IL/DL/Collect per tokenId, compares to cached `hodlBaseline.hodlAmount0/1`)
- `util/diagnostic/show-rebalance-chain.js` — walks Transfer events to show wallet's full NFT mint/drain timeline
