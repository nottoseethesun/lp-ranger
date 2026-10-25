# Testing

## No Mirroring

**Never copy-paste a SUT function into its test file.** A "mirror" or "in-test replica" — the pattern of re-expressing a browser/server function locally in the test to sidestep an import obstacle — is banned. Mirrors silently drift from the real code, so a green test says nothing about whether the SUT still works.

Smell: docstrings that say `Mirror of …`, `In-test replica`, or "mirror is small enough to keep in lockstep by inspection." If you're tempted to write those, stop.

**Correct pattern** — when a function is module-private and needs testing, **extract it as an exported pure decision** and drive the export directly:

- **Browser tests** (`test/dashboard-*.test.js` and any other test targeting `src/client/web/*.js`): use `require("global-jsdom/register")` at the top of the file, then `await import("../src/client/web/<module>.js")` inside a `before` hook, then assert against the real exports. Templates: `test/dashboard-throttle.test.js`, `test/dashboard-helpers.test.js`, `test/dashboard-idle.test.js`.
- **Server tests** (`src/lib/*.js`): direct `require("../src/lib/<module>.js")`. No import obstacle — mirrors have no excuse.

When the private helper's logic is entangled with I/O (DOM writes, network, module-singleton state), extract only the **pure decision** (accepts state as parameters, returns the intended action) and leave the I/O in the wrapper. See PRs #167–#172 for the extract-then-test pattern applied across ~30 dashboard helpers.

Runtime code changes done for testability must be behaviour-neutral under the bundled build — the wrapper still calls the same code path, it just routes the decision through an exported function.

## Test Runner

Node built-in `node:test` runner + ganache (in-memory EVM for blockchain mocks). Run with:

```bash
npm test                # node --test test/*.test.js
npm run test:coverage   # with --experimental-test-coverage (Node 20+)
npm run test:watch      # watch mode
npm run check           # Combined lint (JS+CSS) + test + coverage check (≥80%)
```

## 95% Coverage Regions

The suite as a whole must keep at least 80% line coverage, and
`npm run check` enforces that. Some code is held higher: **95% of lines
and 95% of branches, in each file on its own**. A file in a region cannot
lean on the rest of the suite's average, because an untested path there
can cost an operator real money.

The 95% figure is not yet a gate in `npm run check`. Measure it as
described below whenever a file in a region changes.

### Swap and aggregator (since 2026-10-16)

Every swap a rebalance or a compound makes runs through these files:

| File | What it does |
| --- | --- |
| `src/lib/rebalancer-swap.js` | The ratio math, and the order swaps are tried in: aggregator, aggregator in chunks, V3 router |
| `src/lib/rebalancer-aggregator.js` | Quote, approve, send and confirm through the aggregator, with its retries and its cancel on timeout |
| `src/lib/aggregator-quote-request.js` | One quote request under its time limit, with the aggregator's reasons on a refusal |
| `src/lib/aggregator-nonce-settle.js` | Works out what mined once a swap's wait has run out |
| `src/lib/rebalancer-router.js` | The V3 router swap, in the position's own pool |
| `src/lib/rebalancer-swap-impact.js` | The price-impact check against the slippage setting, and the refusal of a quote that names no impact |
| `src/lib/rebalancer-correct.js` | Corrective swaps, after the main swap moves the tick |
| `src/lib/rebalancer-execute.js` | Swap and adjust: the range shift, the pre-mint check, the result |
| `src/lib/compounder-swap.js` | The compound's ratio-correcting swap |
| `src/lib/swap-gates.js` | The dust and gas checks in front of every swap |
| `src/lib/slippage-resolver.js` | Which slippage figure a swap uses |
| `src/lib/rebalancer-pools.js` | The shared swap helpers: impact check, approvals, send retries |

Measured 2026-10-18, on Node 24 and Node 22:

- **Lines.** 100% in every file, on both.
- **Branches.** 100%, except two files, the same on both:
  `rebalancer-aggregator.js` 98.9% (88 of 89) and `rebalancer-swap.js`
  98.9% (93 of 94). The branch each misses is listed below.

A branch inside a block counts only once some test runs that block, so a
file's branch total can move by one between Node versions, or after a
test elsewhere starts entering the block. Re-measure rather than trust
the figures above.

The tests that hold them there:

- `aggregator-swap-paths.test.js`, `aggregator-swap-branches.test.js`,
  `aggregator-nonce-settlement.test.js`,
  `aggregator-router-fallback.test.js` and
  `aggregator-quote-impact.test.js` cover the aggregator. Their shared
  stage is `helpers/aggregator-harness.js`: scripted quotes served by a
  local http server, scripted receipts and chain state, around the real
  swap code.
- `rebalancer-router-branches.test.js` covers the V3 router.
- `rebalancer-correct.test.js` and `rebalancer-correct-branches.test.js`
  cover the corrective swaps.
- `rebalancer-execute-swap-adjust.test.js`, `compounder-swap.test.js`,
  `compute-desired-edges.test.js` and `swap-gates.test.js` cover the rest.

### Finding the branches a file misses

`npm run check` writes each file's line and branch percentages to
`test/report-artifacts/tests.tap`, but that table names only the missed
lines. The same run also writes an lcov report,
`test/report-artifacts/raw-data/lcov.info`, which names the missed
branches. Under a file's `SF:` line, each `BRDA:<line>,<block>,<branch>,<hits>`
with hits `0` is a branch no test took.

Take it from `npm run check` rather than from a test run of your own.
`npm run check` backs up the operator's settings and every scan cache
around its tests, as `npm run wipe-settings` does; a direct `node --test`
of the whole suite has neither protection.

### Branches still uncovered, and why

A branch no caller can reach is removed, together with any test that
existed only to reach it; it is not listed here. What is left is
reachable, from data the app does not control, but a test of it would
pin a meaningless input as if it were correct:

- **`rebalancer-aggregator.js`.** A quote with no calldata.
- **`rebalancer-swap.js`.** The in-range fallback's guard against
  reference amounts of zero, which only extreme ticks produce.

## Production File Protection

`scripts/check.js` automatically backs up all production cache and config files before tests run and restores them after (via try/finally — runs even if the test process exits non-zero).

### Protected files

**Operator runtime state (gitignored, protected by backup pass):**

- `app-config/user-configurable/bot-config.json` — managed position status, HODL baselines, compound history
- `app-config/user-configurable/bot-config.backup.json` — automatic snapshot
- `app-config/user-configurable/wallet.json` — encrypted wallet key
- `app-config/user-configurable/api-keys.json` — encrypted third-party API keys (Moralis, Telegram, etc.)
- `app-data/rebalance_log.json` — historical rebalance event log

The `app-config/app-defaults-for-user-configurable/` subdir (including the tracked `api-keys.example.json` format template) is shipped repo content and is excluded from backup/delete. Each operator-state directory (`app-config/user-configurable/` and `app-data/`) is tracked via its own `README.md`; the gitignored contents are protected by the backup pass on the same "operator state" footing as `.env`.

**`app-data/scan-cache/` directory (`src/lib/scan-cache-dir.js`; under `node --test` each test process has its own instead):**

- `pnl-epochs-cache.json` — reconstructed P&L epochs (expensive to rebuild)
- `historical-price-cache.json` — GeckoTerminal OHLCV prices (rate-limited API)
- `block-time-cache.json` — block-number → timestamp cache
- `gecko-pool-cache.json` — GeckoTerminal pool base/quote orientation, and which pool a bare token's price is read from
- `event-cache-*.json` — per-pool rebalance event scan results
- `lp-position-cache-*.json` — LP position enumeration results
- `nft-mint-date-cache.json` — NFT mint timestamps
- `token-symbol-cache.json` — token symbol lookups

### How it works

1. Before tests: `backupProdFiles()` copies every file under the operator-state dirs (`app-config/user-configurable/`, `app-data/` and `app-data/scan-cache/`, each preserving its tracked `README.md`) to a `mkdtempSync` directory, then `wipeRuntimeFiles()` deletes the originals so tests start from vanilla state
2. Tests run (may create, modify, or delete any of these files)
3. After tests (try/finally in `check.js`): `restoreProdFiles()` deletes any test-created files and copies the backed-up originals back into place

This is the ONLY protection mechanism. Individual test files do NOT need their own snapshot/restore logic.

### `logs/`

The backup pass covers `app-config/user-configurable/`, `app-data/` and
`app-data/scan-cache/`. It does **not** cover `logs/`. The two files there are
handled differently.

**`logs/error.log`.** `npm run check` deletes it, and the previous run's
`logs/error-npm-run-check.log`, before anything runs. Once the tests are
done, it renames whatever they wrote to `logs/error-npm-run-check.log`.
Some tests drive code that records a failure in that file:
`test/bot-recorder-lifetime-catastrophic.test.js` writes a scan failure
for NFT #161973 that never happened. The rename keeps it out of the
operator's error log. Nothing is lost that a server start would keep,
since startup deletes `logs/error.log` too.

**`logs/lp-ranger.log`.** Nothing restores it after a test run.

That file is the operator's own log — `--log-file` opens it in append
mode, so it accumulates across runs and a delete is permanent. It is
gitignored, so its loss is reported nowhere and the suite still exits 0.

The path that reaches it is `_DEFAULT_PATH` in `src/lib/boot-log-file.js`:
it is the relative `"logs/lp-ranger.log"`, and `enableLogFile` resolves
it against `process.cwd()`. Any test that boots the logger from the
repo root without supplying an explicit path therefore opens the live
file. Run such a test in a `mkdtempSync` working directory instead —
`loadMergedDefaults` resolves from `__dirname`, so moving cwd does not
disturb config reads. `test/boot-log-file.test.js` does this, and
asserts in an `after` hook that the file survived the suite.

### Adding new cache or config files

When adding a new disk-backed cache or config file:

1. If it's a scan cache → name its file with `scanCachePath` (`src/lib/scan-cache-dir.js`), which puts it in `app-data/scan-cache/`, or under `node --test` in the test process's own folder. Protected by the backup pass, and out of every test's reach.
2. If it's runtime state (managed by the app, may include user secrets) → put it in `app-config/` (top level). Automatically protected by the `find app-config -maxdepth 1 -type f` scan.
3. If it's a tracked shipped default → put it in `app-config/app-defaults-for-user-configurable/`. Excluded from the protection scan (it's committed to git). Operators override at the matching `app-config/user-configurable/<same-name>.json` (gitignored, protected by the backup pass). Every value in a file there is checked for type and range by `test/shipped-config-values.test.js`: by its range in `setting-bounds.json`, by the timer rule, or by the kind of value its entry in that test's `RULES` names. A value, or a file, with no rule fails that test, naming it, until it is given one; a file that holds no defaults is named in `NOT_DEFAULTS` instead. `npm run check` runs that test and `test/setting-bounds.test.js` before every other test (`configValueTests()` in `scripts/check.js`), so a wrong shipped value is reported as the cause before the failures it causes.
4. Document new files in this file under "Protected files".

### Vanilla state

Before tests run, `check.js` deletes all production config and cache files so the code starts from its own built-in defaults (`loadConfig()` returns `{global:{},positions:{}}` when no file exists). No duplicate fixture files are maintained — the defaults live in the code itself. After tests, production files are restored from backup.

### Test config files

Tests that need config files should either:

- Make a temp folder with `makeTestTempFolder` (see "Temp folders" below) and pass it as the `dir` parameter to `loadConfig(dir)` / `saveConfig(cfg, dir)`
- Or call them with no directory: under `node --test` that resolves to the test process's own temp folder, never the operator's `bot-config.json` (`_appConfigDir`, `src/lib/bot-config-v2.js`)

Default/vanilla config values come from `.env.example` and the shipped JSON files under `app-config/app-defaults-for-user-configurable/` in the repository.

### Temp folders

A test run leaves no folder behind. A test that needs a folder of its own takes one from `makeTestTempFolder(purpose)` (`src/lib/test-temp-folders.js`). It is made in the system's temp directory, named `lp-ranger-test-<purpose>-<pid>-<random>`, and removed when the test process exits, whether its tests passed or failed: one exit hook per process removes them all, so a file may make as many as it needs without Node's warning past ten exit hooks. The config folder above is one of these, and so is the scan-cache folder. A folder made any other way is removed by the test that made it, in a `finally` or an `after` hook.

A process stopped outright (Ctrl+C, kill -9) cannot remove its folders, so `npm run check` removes them before its tests start: each `lp-ranger-test-` folder whose process, named in the folder's name, is no longer running. A running process's folder is left alone, so a test run under way elsewhere keeps its files.

Why the system's temp directory and not the project's `tmp/`: anything left in the project's `tmp/` stays in the install. The system's temp directory is outside the install, and most systems clear it at boot. Why a folder per process and not one shared folder: the runner runs test files in parallel processes, which would overwrite one another's files.

### Settings moved off what ships

A test of a configured value runs on a value other than the shipped one. At the shipped value, code with that figure typed in passes too. There are three ways to move one, each set up before anything under `src/lib/` loads, since the loader reads its folders' paths as it loads:

- **An operator's override.** Write the file into a `makeTestTempFolder` folder and point `LP_RANGER_USER_CONFIG_DIR` at it. Most tests do this.
- **`.env`.** Set the variable in `process.env`; dotenv leaves a set variable alone.
- **A copy of the shipped folder.** For what reads the shipped files alone, such as the User Manual's build, or a test of how a reader copes with a broken shipped file: `useShippedDefaultsCopy()` (`test/helpers/shipped-defaults-copy.js`) copies the folder and points `LP_RANGER_DEFAULTS_DIR` at the copy, and `changeShippedCopy` changes values in it. `useMovedHelpSettings()` (`test/helpers/help-settings-moved.js`) moves every value the help quotes. A test never writes the tracked file itself; `test/tests-leave-shipped-files-alone.test.js` fails one that does.

A test that checks the shipped values themselves, such as the manual on disk, reads the tracked files and moves nothing.

### No outside service asked

A test asks no service outside the machine. A result that depends on a third party fails when that party changes its answer, and the app's own budget of calls a minute to GeckoTerminal can make a test wait out a whole minute. Two stand-ins cover what the tests reach:

- **Prices.** A test that reaches a price lookup, through a poll, a rebalance, a compound or a swap gate, requires `test/helpers/price-stand-ins.js` before anything under `src/lib/` that reads a price, since those modules take the lookups when they load. A token's current price and the dust unit's then answer from a fixed table: the chain's wrapped native coin and the dust unit at steady prices, and every other token unpriced.
- **The aggregator.** A test whose swap asks for a quote but is not about the aggregator's own handling starts a local aggregator (`startLocalAggregator`, `test/helpers/local-aggregator.js`) and points the chain's aggregator url at it. It refuses every quote, as the live aggregator refuses the fixtures' made-up tokens, or answers as a case scripts it. A test of the aggregator's own handling stages it with `test/helpers/aggregator-harness.js`.
- **A Manage's pool check.** The Manage route reads the position's pool from the chain and refuses the position when it cannot, so a test that drives a Manage past that check passes `poolReadStandIn()` (`test/helpers/pool-read-stand-in.js`) as the route's `ethersLib` and `readProvider`: each NFT open, alone in a pool of its own.

To find a test that still asks an outside service, run the gate with a preload that records every request leaving the machine (`NODE_OPTIONS="--require <preload>"`, subscribing to `undici:request:create`); `npm audit` is the only stage that should appear.
