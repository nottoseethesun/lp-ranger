# LP Ranger — `npm` Project Commands

Every command defined in `package.json`, what it does, and what to type.

Companion to [`docs/engineering.md`](engineering.md), which covers how the
system works. This file covers how to drive it.

---

## Table of Contents

- [Passing Flags](#passing-flags)
- [Getting Help on Any Command](#getting-help-on-any-command)
- [Lifecycle Commands](#lifecycle-commands)
- [Developer Tools](#developer-tools)
- [Test](#test)
- [Commands That Are Usually Not Run Alone](#commands-that-are-usually-not-run-alone)
- [Command Notes](#command-notes)
  - [Before Running Any Lint or Test Command](#before-running-any-lint-or-test-command)
  - [Stopping a Running Install](#stopping-a-running-install)
  - [Dependency Cycles](#dependency-cycles)
  - [Wallet and Scan-Cache Resets](#wallet-and-scan-cache-resets)
  - [Housekeeping](#housekeeping)

---

## Passing Flags

Run with `npm run <name>`; `start`, `test` and `stop` also work without
`run`. Flags go after a `--` separator:

```sh
npm run build-and-start -- --verbose
npm start -- --headless
npm test -- --test-name-pattern="failover"
```

The `--` is what tells npm the rest belongs to the script rather than to
npm itself. Without it `npm run start --verbose` sets an npm config flag
and the server never sees it.

---

## Getting Help on Any Command

Every entry point that takes flags also takes `--help` (or `-h`). It
prints the flag list and exits without starting anything:

```sh
npm run build-and-start -- --help
npm start -- --help
npm run bot -- --help
npm run dev -- --help
npm run debug -- --help
npm run debug-bot -- --help
```

`--help` starts no server and no bot, writes nothing to the log file, and
prints no startup banner — so a help listing can never be mistaken for a
running process.

The same text is produced by `src/cli-help.js`, so the help output and
the tables below describe the same flags.

---

## Lifecycle Commands

Starting and stopping a running install.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `bot` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h`, `--start-with-price-lookups-unpaused` | Headless bot, no dashboard. Requires `PRIVATE_KEY` in `.env` or an imported wallet. Price lookups start paused to conserve quota; the flag disables that for continuous P&L cache warming. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run bot -- --start-with-price-lookups-unpaused` · `npm run bot -- --help` |
| `clear-blockchain-scan-cache` | `--dry-run` | Delete every blockchain scan cache in `tmp/`. Refuses to run while the server is up. `--dry-run` lists what would go without deleting. See [Wallet and Scan-Cache Resets](#wallet-and-scan-cache-resets). | `npm run clear-blockchain-scan-cache -- --dry-run` |
| `start` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h`, `--headless` | Start the dashboard server and auto-start every position saved as `running`. `--headless` prompts for the wallet password on the terminal instead of needing a browser. Does not build first; a `prestart` hook verifies the artifacts exist. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm start -- --verbose` · `npm start -- --help` |
| `stop` | — | Clean shutdown: reads `tmp/lp-ranger.pid` and sends SIGTERM, the same path as Ctrl+C. Falls back to an lsof-by-port lookup when no PID file exists. See [Stopping a Running Install](#stopping-a-running-install). | `npm stop` |

---

## Developer Tools

Building, running from source, debugging, inspecting the codebase, and
resetting local state.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `api-doc` | — | Serve the Scalar API reference at `http://localhost:5556`. | `npm run api-doc` |
| `build` | — | Full build: version stamp, manual and disclosure content, UI tokens, the esbuild bundle, cache-bust stamps, inlined SVGs. | `npm run build` |
| `build-and-start` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h` | Build the dashboard bundle, then start the server. The usual command after pulling changes. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run build-and-start -- --log-file /tmp/burn-in.log` · `npm run build-and-start -- --help` |
| `build:watch` | — | esbuild in watch mode. Rebuilds the bundle on change; skips the one-off generators `build` runs. | `npm run build:watch` |
| `clean` | — | Full reset to fresh-clone state: wallet, bot config, API keys, rebalance log, every `tmp/` cache, logs and build artifacts. Rebuild before starting again. See [Wallet and Scan-Cache Resets](#wallet-and-scan-cache-resets). | `npm run clean` |
| `clean:log` | — | Truncate `logs/lp-ranger.log`. See [Housekeeping](#housekeeping). | `npm run clean:log` |
| `debug` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h` | Start the server under `node --inspect`. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run debug` · `npm run debug -- --help` |
| `debug-attach` | — | Attach a debugger to an already-running server and print the URL to visit. | `npm run debug-attach` |
| `debug-attach-bot` | — | The same for a running headless bot. | `npm run debug-attach-bot` |
| `debug-bot` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h` | Start the headless bot under `node --inspect`. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run debug-bot` · `npm run debug-bot -- --help` |
| `dev` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h` | Build, then start under `node --watch` so the server restarts on file changes. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run dev -- --verbose` · `npm run dev -- --help` |
| `dev-clean` | — | The same as `clean`, but keeps the price, block-time and Gecko caches, which cost API quota to rebuild. See [Wallet and Scan-Cache Resets](#wallet-and-scan-cache-resets). | `npm run dev-clean` |
| `format` | — | Prettier write pass over the tracked file set. | `npm run format` |
| `knip` | — | Dead-code detection. The `dashboard-*.js` files report as unused because knip cannot trace HTML `<script>` tags — those are false positives. | `npm run knip` |
| `lint` | — | Linters only: ESLint, stylelint, html-validate, SVG policy, openapi-sync, markdownlint, Prettier across JS/JSON/YAML, actionlint. | `npm run lint` |
| `lint:fix` | — | The same set with autofix where each tool supports it. | `npm run lint:fix` |
| `nuke` | — | Delete `node_modules` and `package-lock.json` for a clean reinstall. Run `npm install` afterwards. | `npm run nuke` |
| `reset-wallet` | — | Delete `wallet.json` and scrub `WALLET_PASSWORD` from `.env`. See [Wallet and Scan-Cache Resets](#wallet-and-scan-cache-resets). | `npm run reset-wallet` |
| `restore-settings` | — | Restore whatever `wipe-settings` backed up. | `npm run restore-settings` |
| `show-dependency-cycles` | — | madge circular-import report across the whole source tree. See [Dependency Cycles](#dependency-cycles). | `npm run show-dependency-cycles` |
| `show-gallery` | — | Serve a Pages-accurate preview of the screenshot gallery at `http://localhost:5557`. Architecture in [engineering.md § Previewing the Screenshot Gallery](engineering.md#previewing-the-screenshot-gallery). | `npm run show-gallery` |
| `view-report` | — | Open the PDF report produced by the last `check`. | `npm run view-report` |
| `wipe-settings` | — | Back up operator settings to `tmp/.settings-backup/` to simulate a fresh install. `check` uses this, so never run it against a live server. | `npm run wipe-settings` |

---

## Test

The gates. `check` runs all of them and is what must pass before a
commit. Read [Before Running Any Lint or Test
Command](#before-running-any-lint-or-test-command) first.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `audit:deps` | — | `npm audit` at the `high` threshold. | `npm run audit:deps` |
| `audit:secrets` | — | secretlint across the repo. | `npm run audit:secrets` |
| `audit:security` | — | The custom security lint rules. | `npm run audit:security` |
| `check` | — | The full gate: every linter, the test suite, coverage and the audits, summarised in one table. What must pass before a commit. Writes reports to `test/report-artifacts/`. | `npm run check` |
| `format:check` | — | Prettier in check mode; fails rather than rewriting. | `npm run format:check` |
| `test` | any `node --test` flag | Run the suite with a concurrency of 24. | `npm test -- --test-name-pattern="failover"` |
| `test:coverage` | — | The suite with V8 coverage collection. | `npm run test:coverage` |
| `test:util` | — | Only the `util/diagnostic/` suites. See [engineering.md § Diagnostic Utilities](engineering.md#diagnostic-utilities). | `npm run test:util` |
| `test:watch` | — | Re-run affected tests on file change. | `npm run test:watch` |

---

## Commands That Are Usually Not Run Alone

npm lifecycle hooks and helpers. These run automatically around the
command each is named for.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `clean:reports` | — | Remove `test/report-artifacts/`. Invoked by all nine `pre*` hooks — `precheck`, `prelint`, `prelint:fix`, `pretest`, `pretest:coverage`, `pretest:watch` and the three `preaudit:*` — so every gate starts without stale reports. | `npm run clean:reports` |
| `copy-fonts` | — | Copy the self-hosted WOFF2 files from `node_modules` into `public/fonts/`. Also runs automatically via `postinstall`. | `npm run copy-fonts` |
| `postinstall` | — | Runs automatically after `npm install`; copies the fonts. | automatic |
| `precheck`, `prelint`, `prelint:fix`, `pretest`, `pretest:coverage`, `pretest:watch`, `preaudit:deps`, `preaudit:security`, `preaudit:secrets` | — | Run automatically before the command each is named for; clear stale reports and regenerate generated content so the gate starts from a known state. | automatic |
| `prepare` | — | Runs automatically after `npm install`; installs the husky hooks. | automatic |
| `prestart` | — | Runs automatically before `start`; verifies the build artifacts exist. | automatic |

---

## Command Notes

Detail the tables above cannot carry. Each heading is linked from the
matching table row.

### Before Running Any Lint or Test Command

**Caution — read before running any lint or test command.** `npm run check`,
`npm test`, and their variants actively write to config and cache files
during test execution. Those files are backed up by `scripts/check.js`
before the tests start and restored automatically when the process exits.
However, if you Ctrl-C the process mid-run, the restore may not complete
and the files will be left in a state that is only appropriate for the
automated tests (stub position keys, missing managed positions, etc.).
**Always let tests and checks finish before interrupting.**

**Step 1 — back up your real state out of tree (do this once per machine
before your first run):**

```sh
mkdir -p ../app-config-backup
cp -R ./app-config ../app-config-backup/
cp .env ../app-config-backup
```

If you ever end up with corrupted state after an interrupted run, restore
from `../app-config-backup/`. `npm run clean` is also available as a
nuclear option — it wipes runtime files entirely and triggers full-length
blockchain wallet scans on next start to rebuild caches.

`npm run test:util` runs ONLY the `util/diagnostic/test/` suites, for a
fast loop while working on a diagnostic tool. Those suites also run as
part of plain `npm test` and `npm run check`, and count toward the 80%
coverage gate — `util/` is held to the same bar as `src/`.

### Stopping a Running Install

`npm stop` (alias `npm run stop`) shuts down without switching to the
server's terminal. It reads the server PID from `tmp/lp-ranger.pid`
(written on startup by `src/server-pid.js`) and sends **SIGTERM** — the
same handler as Ctrl+C, so it stops all managed positions, closes the
HTTP server, and removes the PID file. It escalates to SIGKILL if the
process does not exit within ~3 s, and falls back to an lsof-by-port
lookup when no PID file is present. Both SIGINT and SIGTERM run the one
`shutdown` handler in `server.js`.

### Dependency Cycles

`npm run show-dependency-cycles` is an optional diagnostic. It runs
[`madge`](https://github.com/pahen/madge) `--circular` across every `.js`
file in the project (`src/`, `bot.js`, `server.js`, `scripts/`,
`eslint-rules/`, `test/`, `public/`) and lists any circular module
imports. It is not wired into `npm run check` — surface it only when you
want it.

Why a CLI tool instead of an ESLint rule: the server-side code is
CommonJS (`require`/`module.exports`) because Node loads it directly with
no `"type": "module"` in `package.json`; the dashboard code under
`public/dashboard-*.js` is ESM (`import`/`export`) because esbuild bundles
it into `public/dist/bundle.js` for the browser. The standard ESLint cycle
rules (`import/no-cycle`, `import-x/no-cycle`) only reliably detect ESM
cycles — they cannot trace `require()` calls because `require` is a
runtime function call, not a static import. `madge` traverses both
`import` and `require` by walking the actual dependency graph, so it
catches cycles in both halves of the codebase. Dashboard `public/` ESM
cycles are also reported; cleaning those up is a separate nice-to-have
task.

### Wallet and Scan-Cache Resets

- `npm run reset-wallet` — Delete `app-config/user-configurable/wallet.json` + clear
  `WALLET_PASSWORD` from `.env`. Forces a fresh wallet import via the
  dashboard on next start.
- `npm run clear-blockchain-scan-cache` — Delete every `tmp/*.json`, and
  nothing else. That directory holds derived scan results only — event
  scans, LP position enumeration, P&L epochs and the lifetime HODL
  amounts kept beside them, block timestamps, pool creation
  blocks, token symbols, fetched prices — all rebuilt from chain on the
  next start. This is the command for testing scan behaviour from cold.
  Refuses while a server is running, because clearing the cache under a
  live process achieves nothing: it rewrites the files within seconds and
  keeps its in-memory copies regardless. `-- --dry-run` lists without
  deleting. Configuration, wallet and API keys are untouched.
- `npm run clean` — Returns the install to the state a fresh clone is
  in. Stops the server and **waits for it to exit**, runs `reset-wallet`,
  then deletes operator state (`bot-config.json`,
  `bot-config.backup.json`, `api-keys.json`, `rebalance_log.json`),
  every `tmp/*.json` cache, `logs/*.log`, the build artifacts
  (`public/dist/`, `public/fonts/`, `public/ui-tokens.css`,
  `public/disclosure-content.js`) and `test/report-artifacts/`.
  Run `npm run build` before `npm start` afterwards — the prestart guard
  names the missing files if you forget.
  Implemented in [`scripts/clean.js`](../scripts/clean.js), which
  delegates the cache to `clear-blockchain-scan-cache.js` rather than
  naming cache files itself. That script is the single definition of
  "the scan cache", so a cache added later is covered here without a
  second list to update.
  **Note:** browser localStorage is NOT cleared, and does not need to be
  for a cold scan — the browser holds display state only (last viewed
  position, privacy toggles, price overrides, a copy of the
  rebalance-events list for instant paint). None of it makes the server
  skip a scan. Clear it via the Settings gear icon → "Clear Local Storage
  & Cookies" only when you actually want the browser-side preferences
  reset, accepting that wallet re-entry and per-position UI state go with
  it.
- `npm run dev-clean` — The same run with three caches preserved for a
  faster development restart: the historical price cache
  (`tmp/historical-price-cache.json`), the block-time cache
  (`tmp/block-time-cache.json`) and the gecko-pool orientation cache
  (`tmp/gecko-pool-cache.json`). None is derived from chain and all three
  cost third-party API quota to refill. Logs are kept too. Same script,
  `--dev`.

### Housekeeping

- `npm run clean:log` — Delete the log-to-file output at
  `logs/lp-ranger.log` (the file produced when the app is started
  with `--log-file` or with `enabled: true` in
  `app-config/app-defaults-for-user-configurable/logging.json`). No-op when the file is
  absent. Use this to free disk space, to start a clean capture before
  a diagnostic session, or to scrub a log before sharing.  The log is
  NOT automatically rotated — long-lived production tails should run
  this on a cron or external logrotate setup.
- `npm run nuke` — Delete `node_modules` + `package-lock.json` for a clean
  reinstall. Run `npm install` afterwards.
- `npm run wipe-settings` — Back up all user settings/state (`.env`, every
  runtime file in `app-config/`, `tmp/pnl-epochs-cache.json`,
  `tmp/event-cache*.json`, `*.keyfile.json`) to `tmp/.settings-backup/` and
  remove them — simulates a fresh install. Also clear browser localStorage
  via Settings gear → "Clear Local Storage & Cookies" to complete the
  simulation.
- `npm run restore-settings` — Restore settings previously backed up by
  `wipe-settings`.
- `npm run view-report` — Open `test/report-artifacts/report.pdf` via
  `xdg-open` (Linux dev box).

---

## See Also

- [`docs/engineering.md`](engineering.md) — how the system works.
- [`docs/engineering.md` § Utilities](engineering.md#utilities) — the
  `node util/…` diagnostic, update and cache tools, which are not npm
  scripts.
- [`docs/configuration.md`](configuration.md) — every environment
  variable and JSON tunable.
- [`docs/claude/CLAUDE-CI.md`](claude/CLAUDE-CI.md) — the CI and merge
  protocol these gates feed.
