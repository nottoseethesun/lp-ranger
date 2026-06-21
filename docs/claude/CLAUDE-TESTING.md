# Testing

## Test Runner

Node built-in `node:test` runner + ganache (in-memory EVM for blockchain mocks). Run with:

```bash
npm test                # node --test test/*.test.js
npm run test:coverage   # with --experimental-test-coverage (Node 20+)
npm run test:watch      # watch mode
npm run check           # Combined lint (JS+CSS) + test + coverage check (≥80%)
```

## Production File Protection

`scripts/check.js` automatically backs up all production cache and config files before tests run and restores them after (via try/finally — runs even if the test process exits non-zero).

### Protected files

**`app-config/` directory (top-level runtime files only):**

- `app-config/.bot-config.json` — managed position status, HODL baselines, compound history
- `app-config/.bot-config.backup.json` — automatic snapshot
- `app-config/.wallet.json` — encrypted wallet key
- `app-config/api-keys.json` — encrypted third-party API keys (e.g. Moralis)
- `app-config/rebalance_log.json` — transaction history

The `app-config/app-defaults-for-user-configurable/` subdir and `app-config/api-keys.example.json` are tracked repo files and are explicitly excluded from backup/delete. The matching `app-config/user-configurable/` subdir is tracked (via `.gitkeep`) but its contents are gitignored — operators drop layered overrides there, and those overrides ARE protected by the backup pass (same upgrade-safety semantics as `.env`).

**`tmp/` directory (all JSON files):**

- `pnl-epochs-cache.json` — reconstructed P&L epochs (expensive to rebuild)
- `historical-price-cache.json` — GeckoTerminal OHLCV prices (rate-limited API)
- `block-time-cache.json` — block-number → timestamp cache
- `gecko-pool-cache.json` — GeckoTerminal pool base/quote orientation
- `event-cache-*.json` — per-pool rebalance event scan results
- `lp-position-cache-*.json` — LP position enumeration results
- `nft-mint-date-cache.json` — NFT mint timestamps
- `token-symbol-cache.json` — token symbol lookups

### How it works

1. Before tests: `backupProdFiles()` copies every runtime file under `app-config/` (except the tracked `api-keys.example.json`) and every `tmp/*.json` to a `mkdtempSync` directory, then `wipeRuntimeFiles()` deletes the originals so tests start from vanilla state
2. Tests run (may create, modify, or delete any of these files)
3. After tests (try/finally in `check.js`): `restoreProdFiles()` deletes any test-created files and copies the backed-up originals back into place

This is the ONLY protection mechanism. Individual test files do NOT need their own snapshot/restore logic.

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
