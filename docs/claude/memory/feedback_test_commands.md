---
name: feedback_test_commands
description: "Test commands: never node --test/npm test directly, wrap in wipe/restore-settings, never npm run check inside an agent"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fbb9ad2b-bfb6-4113-a2f4-fcb15a7900da
  modified: 2026-08-08T16:39:53.374Z
---

# Running tests

Merged from: feedback_never_node_test_directly, feedback_wipe_restore_around_tests, feedback_no_check_in_agents — those slugs no longer exist as
separate files; search this one.

## never node test directly

NEVER run `node --test` AND NEVER run `npm test` directly on this project. Always use `npm run check` (or at minimum `bash scripts/check.sh`). If you must run tests outside check, wrap them in `npm run wipe-settings` / `npm run restore-settings`.

**Why:** Several test files use `fs.unlinkSync(_CACHE_PATH)` against production cache file paths in their `beforeEach`. The production-file protection is implemented in `scripts/check.sh`: it backs up the full `app-config/` set (.wallet.json, .bot-config.json, .bot-config.backup.json, api-keys.json, rebalance_log.json), `tmp/pnl-epochs-cache.json`, and other state files before tests run and restores them via an EXIT trap. Running `node --test` OR `npm test` bypasses this protection entirely and **destroys real user data**.

**What I broke (latest, 2026-04-26):** During the lazy-require refactor I tried to be clever — backed up only `.bot-config.json` + `.bot-config.backup.json` before `npm test`, then restored. This was insufficient — the test run still wiped the user's settings (wallet.json, api-keys, etc.). User noticed: "you blew away my settings again."

**Earlier incident:** Ran `node --test test/price-cache.test.js` to verify a migration. The test deleted the user's `tmp/historical-price-cache.json` (185 entries of real Moralis historical price data).

**How to apply:**
- ALWAYS use `npm run check` for full local verification (it handles ALL the backup/restore).
- For a faster individual-file test loop, you must first run `npm run wipe-settings`, then run the test, then `npm run restore-settings`. NEVER cp/mv individual config files yourself — the canonical backup list is in `scripts/wipe-settings.js` and changes over time.
- A safer long-term fix: tests should use env-var-injected paths so production paths are never reachable from a test process.

## the chain is not interrupt-safe

`npm run wipe-settings; npm run check; npm run restore-settings` in ONE Bash call is a trap. `wipe-settings` **moves** live state (wallet.json, bot-config.json, api-keys.json, rebalance_log.json, the epoch cache, every event-cache file) into `tmp/.settings-backup/`. If the user cancels the call — or `check` dies — `restore-settings` never runs and the user is left with a wiped install.

**What happened (2026-08-08):** user cancelled a redundant `npm run check` mid-run. The wipe had already completed, so their dev server started against an empty `app-config/user-configurable/` — no wallet, no managed positions, no event caches. Recovered fully with `npm run restore-settings` (the files were moved, not deleted), but only after they noticed: "you f'd the dev cache."

**How to apply:**

- Run `wipe-settings` and `restore-settings` as **separate** tool calls, never chained with the check in the middle. Then an interrupt on the check leaves a recoverable state you can see.
- If a run is interrupted, **check `tmp/.settings-backup/` first** before diagnosing anything else — its presence means a wipe is outstanding, and `npm run restore-settings` is the whole fix.
- Never conclude data was lost until you have looked in that directory.

## wipe restore around tests

Always wrap any test run that could touch app-config/ state in:

```
npm run wipe-settings  # backs up to tmp/.settings-backup/
npm run check          # or whatever the test target is
npm run restore-settings
```

**Why:** Tests can write to `app-config/.bot-config.json`, `.wallet.json`, the epoch cache, the rebalance log, etc. — and a normal user is running the bot against the same files at the same time. A test run that doesn't wipe first will overwrite their managed positions, HODL baselines, residuals, and other live state. User explicitly flagged this 2026-06-18 after some testing had accidentally cleared state.

**How to apply:** Whenever you'd run `npm run check`, `npm test`, or any node test script (even via the [[feedback_no_check_in_agents]] indirection), wrap it. The same applies to running the server / bot in test-style invocations. The wipe step takes <1s; the cost of skipping it is the user's real wallet config.

**Exceptions:** Pure unit-test files that don't touch the filesystem (e.g., `range-math.test.js`, `pnl-tracker.test.js`) are technically safe, but it's easier to just always wipe than to remember which tests are pure.

Cross-links: [[feedback_never_node_test_directly]] (always `npm run check`, never raw node --test) — wipe/restore is the corollary so the check doesn't blow away state.

## never while the operator's server is running (2026-09-12)

Before `npm run wipe-settings` or `npm run check`, confirm no server is
running: `cat tmp/lp-ranger.pid` and `ss -ltnp | grep 5555`. If one is,
**stop and ask the user to shut it down** — they launch the app, so they
stop it too (see [[feedback_user_launches_app]]).

**Why:** `wipe-settings` MOVES the live wallet, bot config, API keys,
epoch cache and every event cache into `tmp/.settings-backup/`. For the
~70 s a check takes, a running server has none of them on disk. Two ways
that loses data, and neither announces itself:

- The bot records something in that window — a rebalance, a compound, a
  HODL baseline resolving — and writes a fresh `bot-config.json` into the
  emptied directory. `restore-settings` deletes test-created files before
  restoring, so that record is thrown away.
- The server's in-memory `_diskConfig` is written later, on top of the
  restored file, reverting it to whatever the process held.

The same window bit us from the other side on 2026-09-12: the user
started the server nine seconds into a wipe, and it came up with no
wallet and no managed positions, looking exactly like data loss. Nothing
was lost, but only because no write happened to land — luck, not design.

**How to apply:** while the user is testing, stay on commands that do not
touch operator state — `npm run lint`, `npm run build`, `node --check`,
reading code. Batch the gate run for when the server is down, and say
plainly that you need it stopped rather than stopping it yourself.

## no check in agents

NEVER run `npm run check` (or any command that touches production files via check.sh) inside an Agent subprocess. Always run it directly in the main session.

**Why:** The check.sh script backs up production files (.bot-config.json, etc.) before tests and restores them via an EXIT trap. If an agent is killed (timeout, SIGKILL), the trap doesn't fire and production config is destroyed. This happened — the user's managed positions were wiped because an agent ran `npm run check` and the restore didn't complete.

**How to apply:** When delegating work to agents, tell them to make code changes only. Run `npm run check` yourself in the main session after the agent returns.
