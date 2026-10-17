# Testing

## No Mirroring

**Never copy-paste a SUT function into its test file.** A "mirror" or "in-test replica" — the pattern of re-expressing a browser/server function locally in the test to sidestep an import obstacle — is banned. Mirrors silently drift from the real code, so a green test says nothing about whether the SUT still works.

Smell: docstrings that say `Mirror of …`, `In-test replica`, or "mirror is small enough to keep in lockstep by inspection." If you're tempted to write those, stop.

**Correct pattern** — when a function is module-private and needs testing, **extract it as an exported pure decision** and drive the export directly:

- **Browser tests** (`test/dashboard-*.test.js` and any other test targeting `public/*.js`): use `require("global-jsdom/register")` at the top of the file, then `await import("../public/<module>.js")` inside a `before` hook, then assert against the real exports. Templates: `test/dashboard-throttle.test.js`, `test/dashboard-helpers.test.js`, `test/dashboard-idle.test.js`.
- **Server tests** (`src/*.js`): direct `require("../src/<module>.js")`. No import obstacle — mirrors have no excuse.

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
| `src/rebalancer-swap.js` | The ratio math, and the order swaps are tried in: aggregator, aggregator in chunks, V3 router |
| `src/rebalancer-aggregator.js` | Quote, approve, send and confirm through the aggregator, with its retries and its cancel on timeout |
| `src/aggregator-nonce-settle.js` | Works out what mined once a swap's wait has run out |
| `src/rebalancer-router.js` | The V3 router swap, in the position's own pool |
| `src/rebalancer-swap-impact.js` | The price-impact check against the slippage setting |
| `src/rebalancer-correct.js` | Corrective swaps, after the main swap moves the tick |
| `src/rebalancer-execute.js` | Swap and adjust: the range shift, the pre-mint check, the result |
| `src/compounder-swap.js` | The compound's ratio-correcting swap |
| `src/swap-gates.js` | The dust and gas checks in front of every swap |
| `src/slippage-resolver.js` | Which slippage figure a swap uses |
| `src/rebalancer-pools.js` | The shared swap helpers: impact check, approvals, send retries |

Measured 2026-10-17, on Node 24 and Node 22:

- **Lines.** 100% in every file, on both.
- **Branches.** 100%, except two files, the same on both:
  `rebalancer-aggregator.js` 99.1% (105 of 106) and `rebalancer-swap.js`
  98.8% (84 of 85). The branch each misses is listed below.

A branch inside a block counts only once some test runs that block, so a
file's branch total can move by one between Node versions, or after a
test elsewhere starts entering the block. Re-measure rather than trust
the figures above.

The tests that hold them there:

- `aggregator-swap-paths.test.js`, `aggregator-swap-branches.test.js` and
  `aggregator-nonce-settlement.test.js` cover the aggregator. Their shared
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
`npm run check` backs up the operator's settings and every `tmp/*.json`
cache around its tests. `npm run wipe-settings` covers far fewer of
them, so a direct `node --test` of the whole suite can write test data
into a cache the app reads.

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

**`tmp/` directory (all JSON files):**

- `pnl-epochs-cache.json` — reconstructed P&L epochs (expensive to rebuild)
- `historical-price-cache.json` — GeckoTerminal OHLCV prices (rate-limited API)
- `block-time-cache.json` — block-number → timestamp cache
- `gecko-pool-cache.json` — GeckoTerminal pool base/quote orientation, and which pool a bare token's price is read from
- `event-cache-*.json` — per-pool rebalance event scan results
- `lp-position-cache-*.json` — LP position enumeration results
- `nft-mint-date-cache.json` — NFT mint timestamps
- `token-symbol-cache.json` — token symbol lookups

### How it works

1. Before tests: `backupProdFiles()` copies every file under the two operator-state dirs (`app-config/user-configurable/` and `app-data/`, each preserving its tracked `README.md`) plus every `tmp/*.json` to a `mkdtempSync` directory, then `wipeRuntimeFiles()` deletes the originals so tests start from vanilla state
2. Tests run (may create, modify, or delete any of these files)
3. After tests (try/finally in `check.js`): `restoreProdFiles()` deletes any test-created files and copies the backed-up originals back into place

This is the ONLY protection mechanism. Individual test files do NOT need their own snapshot/restore logic.

### `logs/`

The backup pass covers `app-config/user-configurable/`, `app-data/` and
`tmp/*.json`. It does **not** cover `logs/`. The two files there are
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

The path that reaches it is `_DEFAULT_PATH` in `src/boot-log-file.js`:
it is the relative `"logs/lp-ranger.log"`, and `enableLogFile` resolves
it against `process.cwd()`. Any test that boots the logger from the
repo root without supplying an explicit path therefore opens the live
file. Run such a test in a `mkdtempSync` working directory instead —
`loadMergedDefaults` resolves from `__dirname`, so moving cwd does not
disturb config reads. `test/boot-log-file.test.js` does this, and
asserts in an `after` hook that the file survived the suite.

### Adding new cache or config files

When adding a new disk-backed cache or config file:

1. If it's a pure performance cache → put it in `tmp/` as `*.json`. Automatically protected by the `tmp/*.json` glob.
2. If it's runtime state (managed by the app, may include user secrets) → put it in `app-config/` (top level). Automatically protected by the `find app-config -maxdepth 1 -type f` scan.
3. If it's a tracked shipped default → put it in `app-config/app-defaults-for-user-configurable/`. Excluded from the protection scan (it's committed to git). Operators override at the matching `app-config/user-configurable/<same-name>.json` (gitignored, protected by the backup pass).
4. Document new files in this file under "Protected files".

### Vanilla state

Before tests run, `check.js` deletes all production config and cache files so the code starts from its own built-in defaults (`loadConfig()` returns `{global:{},positions:{}}` when no file exists). No duplicate fixture files are maintained — the defaults live in the code itself. After tests, production files are restored from backup.

### Test config files

Tests that need config files should either:

- Use a temp directory via `fs.mkdtempSync()` and pass the `dir` parameter to `loadConfig(dir)` / `saveConfig(cfg, dir)`
- Or use the production path knowing that `check.js` will restore the original after tests complete

Default/vanilla config values come from `.env.example` and the shipped JSON files under `app-config/app-defaults-for-user-configurable/` in the repository.
