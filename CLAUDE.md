## 9mm v3 Position Manager — Project Summary

### Purpose
Auto-rebalancing concentrated liquidity manager for 9mm Pro (Uniswap v3 fork) on PulseChain. **V3 positions only** — V2 positions are rejected with a clear error message. Manages **one active LP position per wallet per liquidity pool**. All NFT positions for the same pool form a rebalance chain (old positions are drained, not burned). Position token type is **auto-detected**. Supports up to 300 NFT (ERC-721) and ERC-20/PRC-20 LP positions in the browser position store.

---

### Stack
- **Runtime:** Node.js ≥ 18 (no framework)
- **HTTP server:** Node built-in `http` module (`server.js`) — dashboard + bot auto-start
- **Bot loop:** `src/bot-loop.js` — shared rebalance logic (used by both server.js and bot.js)
- **Bot (headless):** `bot.js` — standalone bot without dashboard UI
- **Dashboard:** `public/index.html` + external CSS (`style.css`, `9mm-pos-mgr.css`, `fonts.css`) + 9 modular `dashboard-*.js` files bundled by esbuild into `public/dist/bundle.js`
- **Client-side routing:** Navigo (pushState) — bookmarkable URLs like `/:wallet/:contract/:tokenId`
- **Build:** esbuild bundles dashboard JS + ethers.js + navigo from npm; fonts self-hosted via `@fontsource` (no CDN dependencies)
- **On-chain:** ethers.js v6.7.1
- **Linter:** ESLint v10 flat config (`eslint.config.js`) + stylelint (`stylelint-config-standard`)
- **Dead code:** knip (devDependency)
- **Tests:** Node built-in `node:test` runner — zero external test framework
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) — lint → test (Node 18/20/22 matrix)

---

### Directory Structure

```
9mm-manager/
├── .env.example                  # All config keys with defaults and comments
├── .github/workflows/ci.yml      # CI: lint → test (Node 18/20/22 matrix)
├── eslint.config.js              # ESLint v10 flat config, complexity ≤17, max-lines ≤500
├── package.json                  # Scripts: start, dev, bot, stop, lint, lint:fix, test, test:coverage, test:watch, check
├── server.js                     # HTTP server + bot auto-start + MAIN DOCUMENTATION
├── bot.js                        # Headless bot wrapper (no dashboard UI)
├── scripts/check.sh              # Combined lint + test + coverage check
├── scripts/copy-fonts.sh         # Copies self-hosted WOFF2 fonts from node_modules to public/fonts/
├── README.md                     # Concise — refers to server.js for details
├── eslint-rules/
│   └── no-separate-contract-calls.js  # Custom rule: require multicall for atomic EVM method pairs
├── public/
│   ├── index.html                # Dashboard HTML (no inline JS or CSS)
│   ├── style.css                 # Core dashboard styles (extracted from index.html)
│   ├── 9mm-pos-mgr.css           # Semantic utility classes, all prefixed `9mm-pos-mgr-`
│   ├── fonts.css                 # Self-hosted @font-face declarations (Space Mono + Urbanist)
│   ├── fonts/                    # WOFF2 font files (gitignored, copied from node_modules)
│   ├── dist/bundle.js            # esbuild output (gitignored, built from dashboard-init.js)
│   ├── ethers-adapter.js         # ES module adapter: re-exports ethers from npm
│   ├── dashboard-helpers.js      # Shared utilities: g(), act(), fmtMs(), fmtDateTime(), fmtCountdown(), nextMidnight(), botConfig
│   ├── dashboard-wallet.js       # Wallet state, known-wallet registry, on-chain activity check, import flows
│   ├── dashboard-positions.js    # Position store (max 300), browser modal, Import+LP tab
│   ├── dashboard-throttle.js     # Trigger config, throttle state/UI, Apply All
│   ├── dashboard-optimizer.js    # LP Optimization Engine interface (probe, poll, render, apply, history)
│   ├── dashboard-data.js         # Polls /api/status, updates all KPIs, position stats, bot status
│   ├── dashboard-history.js      # Per-day P&L table (31 days), Rebalance Events table (5-year lookback)
│   ├── dashboard-router.js       # Client-side URL routing (Navigo pushState): /pulsechain/:wallet/:contract/:tokenId
│   └── dashboard-init.js         # Bootstrap: populate wallets, start router, data polling, intervals
├── src/
│   ├── bot-loop.js               # Shared bot logic: pollCycle, resolvePrivateKey, startBotLoop
│   ├── config.js                 # SINGLE SOURCE OF TRUTH for all config — reads .env
│   ├── rebalancer.js             # Core rebalance: remove liquidity → swap → mint (V3-only guard)
│   ├── event-scanner.js          # On-chain rebalance history via Transfer events (5-year lookback)
│   ├── price-fetcher.js          # USD pricing: DexScreener (primary) → DexTools (fallback) → GeckoTerminal (historical)
│   ├── hodl-baseline.js          # HODL baseline init: GeckoTerminal historical prices at NFT mint time
│   ├── throttle.js               # Timing enforcement: min interval, daily cap, doubling mode
│   ├── pnl-tracker.js            # Per-epoch and cumulative P&L accounting
│   ├── range-math.js             # Uniswap v3 tick/price math utilities
│   ├── wallet.js                 # Wallet generation, seed import, key import, on-chain activity check
│   ├── position-detector.js      # Auto-detect NFT vs ERC-20; enumerate up to 300 NFTs
│   ├── position-store.js         # In-memory store: up to 300 positions, pagination, select/remove
│   ├── ui-state.js               # Pure formatting helpers + DOM update routines
│   ├── cache-store.js             # JSON file-based disk cache with TTL (event scanner, P&L)
│   ├── key-store.js              # AES-256-GCM encrypted private key storage (PBKDF2-SHA512)
│   ├── optimizer-client.js       # HTTP client for the LP Optimization Engine API
│   ├── optimizer-applicator.js   # Applies optimizer recommendations to live BotParams
│   ├── optimizer-scheduler.js    # Toggle + 10-min polling loop + queryNow()
│   ├── residual-tracker.js       # Per-pool wallet residual tracking (tokens left after rebalance)
│   └── wallet-manager.js         # Wallet import/clear + encrypted disk persistence
└── test/
    ├── bot-loop.test.js
    ├── hodl-baseline.test.js
    ├── config.test.js
    ├── rebalancer.test.js
    ├── event-scanner.test.js
    ├── price-fetcher.test.js
    ├── throttle.test.js
    ├── pnl-tracker.test.js
    ├── range-math.test.js
    ├── wallet.test.js
    ├── ui-state.test.js
    ├── position-detector.test.js
    ├── position-store.test.js
    ├── server.test.js
    ├── server-spa-fallback.test.js   # SPA catch-all: extensionless paths → index.html, file extensions → 404
    ├── bot.test.js
    ├── cache-store.test.js
    ├── disclaimer.test.js
    ├── fund-safety.test.js
    ├── key-store.test.js
    ├── position-rangeW.test.js
    ├── optimizer-client.test.js
    ├── optimizer-applicator.test.js
    ├── optimizer-scheduler.test.js
    ├── range-math-fuzz.test.js       # Property-based fuzz tests (500 iterations × 10 properties)
    ├── rebalancer-failures.test.js   # Failure-mode tests: reverts, partial failures, malformed data
    ├── rebalancer-integration.test.js # Stateful simulation: balance tracking across remove→swap→mint
    ├── residual-tracker.test.js      # Per-pool residual tracking, capping, serialization
    ├── gitignore.test.js             # Ensures .gitignore covers sensitive files (.wallet.json, .env, etc.)
    ├── wallet-manager.test.js        # Wallet import/clear + encrypted disk persistence
    └── eslint-rules/
        └── no-separate-contract-calls.test.js  # RuleTester cases for the custom multicall rule
├── .stylelintrc.json                 # stylelint config (extends stylelint-config-standard)
└── tmp/                              # Local temp dir for tests (gitignored)
```

**653 tests passing. ESLint + stylelint: 0 errors, 0 warnings.**

---

### Key Config Keys (`.env` / `src/config.js`)

| Key | Default | Notes |
|-----|---------|-------|
| `PORT` | `5555` | Dashboard server port |
| `HOST` | `0.0.0.0` | Bind address |
| `PRIVATE_KEY` | — | Required for live bot (or use KEY_FILE) |
| `KEY_FILE` | — | Path to AES-256-GCM encrypted key file (alternative to PRIVATE_KEY) |
| `KEY_PASSWORD` | — | Decrypt password; leave blank for interactive prompt |
| `WALLET_PASSWORD` | — | Decrypt dashboard-imported wallet at startup |
| `DRY_RUN` | `false` | Read-only mode — no transactions sent |
| `RPC_URL` | `https://rpc-pulsechain.g4mm4.io` | Primary RPC; auto-fallback to official |
| `RPC_URL_FALLBACK` | `https://rpc.pulsechain.com` | Used if primary is unreachable |
| `POSITION_ID` | — | NFT token ID; blank = full wallet scan |
| `ERC20_POSITION_ADDRESS` | — | ERC-20 position token (optional fallback) |
| `REBALANCE_OOR_THRESHOLD_PCT` | `10` | % price must move beyond position boundary before rebalance triggers |
| `SLIPPAGE_PCT` | `0.5` | |
| `CHECK_INTERVAL_SEC` | `60` | On-chain poll frequency |
| `MIN_REBALANCE_INTERVAL_MIN` | `10` | |
| `MAX_REBALANCES_PER_DAY` | `20` | |
| `POSITION_MANAGER` | `0xCC05bf…` | NonfungiblePositionManager (9mm Pro V3) |
| `FACTORY` | `0xe50Dbd…` | V3 Factory (9mm Pro) |
| `SWAP_ROUTER` | `0x7bE8fb…` | V3 SwapRouter (9mm Pro) |
| `QUOTER_V2` | `0x500260…` | V3 QuoterV2 (9mm Pro) |
| `DEXTOOLS_API_KEY` | — | Optional — for USD price fallback |
| `OPTIMIZER_PORT` | `3693` | LP Optimization Engine port |
| `OPTIMIZER_URL` | `http://localhost:3693` | Built from OPTIMIZER_PORT if not set |
| `OPTIMIZER_API_KEY` | — | Bearer token (optional) |
| `OPTIMIZER_INTERVAL_MIN` | `10` | Auto-poll interval when toggle is ON |
| `OPTIMIZER_TIMEOUT_MS` | `10000` | Per-request timeout |
| `OPTIMIZER_AUTO_APPLY` | `false` | Auto-apply recommendations |

Contract address source: https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json

---

### npm Scripts

```bash
npm run build          # esbuild: bundle dashboard JS + ethers into public/dist/bundle.js
npm run build:watch    # esbuild in watch mode (rebuilds on file change)
npm run copy-fonts     # Copy WOFF2 font files from node_modules to public/fonts/
npm start              # build + node server.js  (dashboard + bot on PORT, default 5555)
npm run dev            # build + node --watch server.js
npm run bot            # node bot.js  (headless bot, no dashboard)
npm run stop           # Graceful shutdown via POST /api/shutdown
npm run lint           # ESLint (JS) + stylelint (CSS) — 0 errors required
npm run lint:fix       # ESLint + stylelint auto-fix
npm test               # node --test test/*.test.js
npm run test:coverage  # with --experimental-test-coverage (Node 20+)
npm run test:watch     # watch mode
npm run check          # Combined lint (JS+CSS) + test + coverage check
```

---

### Architecture Decisions

**V3-only:** The rebalancer only supports V3 NFT positions. `executeRebalance()` guards on `position.fee ∈ [500, 3000, 10000]` and rejects V2 positions with a clear error.

**Unified entry point:** `npm start` runs `server.js` which starts the dashboard and auto-starts the bot loop when a wallet key is available (via `PRIVATE_KEY`, `KEY_FILE`, or `WALLET_PASSWORD`). If no key is available, runs in dashboard-only mode; importing a wallet via the dashboard UI auto-starts the bot. `npm run bot` runs headless (no dashboard). `npm run stop` sends `POST /api/shutdown` for graceful shutdown of both.

**Rebalance pipeline:** `src/bot-loop.js` provides the shared bot logic used by both `server.js` and `bot.js`. It polls the pool at `CHECK_INTERVAL_SEC`, checks if the current tick is outside [tickLower, tickUpper], applies the OOR threshold check, checks throttle, then calls `executeRebalance()` which does: getPoolState → removeLiquidity → computeDesiredAmounts → swapIfNeeded → mintPosition. All functions accept injected `signer`, `ethersLib`, and config objects for testability.

**Preserve tick spread:** On rebalance, the bot preserves the existing position's tick spread (tickUpper − tickLower) and re-centers it on the current price via `rangeMath.preserveRange()`. This prevents narrow positions from being widened to match `REBALANCE_OOR_THRESHOLD_PCT`. The range width is determined by the original position, not a config setting.

**OOR threshold:** The `REBALANCE_OOR_THRESHOLD_PCT` setting (default 10) controls how far the price must move **beyond** the position boundary before triggering a rebalance. A value of 10 means the price must move 10% past tickLower or tickUpper. A value of 0 triggers immediately on any OOR. The dashboard shows an amber "WITHIN THRESHOLD" banner when OOR but within the threshold zone.

**USD pricing:** DexScreener (primary, no key) → DexTools (fallback, requires `DEXTOOLS_API_KEY`). 60s in-memory cache. See `src/price-fetcher.js`. Historical prices fetched from GeckoTerminal OHLCV API (free, no key, 30 calls/min). USD values (token prices, exit/entry amounts) are recorded in `rebalance_log.json` at rebalance time to avoid needing historical price lookups.

**Single position per pool:** The tool manages one active LP position per wallet per liquidity pool. When rebalancing, the old NFT is drained (`decreaseLiquidity` + `collect`) but NOT burned — the bot does not call `burn()`. Rebalance history is detected via consecutive mint events (Transfer from 0x0 to wallet), not burn+mint pairs. **Runtime position switching:** `POST /api/position/switch` stops the bot, clears position-specific state, and restarts on the new NFT. The dashboard calls this when the user selects a position in the Position Browser. `activePositionId` is persisted to `.bot-config.json` so the selection survives restarts. Closed positions (liquidity=0) are displayed but the bot skips rebalance checks.

**P&L breakdown:** Two components: (a) price-change P&L (position value change from token price movements, including IL), and (b) fee P&L (trading fees earned while in range). Per-day aggregation (up to 31 days) with running cumulative. Historical USD token prices stored per-epoch for accurate retrospective P&L.

**Disk cache:** `src/cache-store.js` provides JSON file-based caching with TTL for expensive blockchain queries (event scanner 5-year lookback, P&L history). App remains stateless — cache is pure performance optimisation, rebuilt from blockchain if deleted. Browser caches rebalance events in localStorage (`9mm_rebalance_events`) for instant display on page load.

**Event scanner rate limiting:** 250ms delay between RPC chunk queries (`_CHUNK_DELAY_MS`) to avoid overwhelming the endpoint. With 10,000-block chunks, a 5-year scan (~15.8M blocks) takes ~1,580 chunks. Pool-age optimisation reduces this for younger pools.

**Bot config persistence:** Dashboard settings (range width, slippage, intervals, trigger config, initial deposit, `activePositionId`) are saved to `.bot-config.json` on every `POST /api/config` or position switch, and loaded on server startup. Survives restarts.

**Pool-age optimisation:** Event scanner checks the V3 Factory's `PoolCreated` event to find when the pool was deployed, then skips all blocks before that. Can save thousands of RPC queries for pools younger than 5 years.

**CSS architecture:** All styles externalized — zero inline `<style>` blocks, near-zero inline `style="..."` (only dynamic `width` values set by JS remain). Three CSS files: `fonts.css` (self-hosted `@font-face` declarations), `style.css` (core layout/components), and `9mm-pos-mgr.css` (semantic utility classes, all prefixed `9mm-pos-mgr-`). All pass `stylelint-config-standard`. Custom CSS classes use the `9mm-pos-mgr-` namespace to avoid collisions.

**Date/time display:** All user-visible timestamps show **both UTC and local time** with timezone code, e.g. `2026-03-15 14:30 UTC (3/15/2026 10:30 AM CDT)`. Centralized via `fmtDateTime()` in `dashboard-helpers.js`. Relative times ("5s ago") are timezone-neutral with full timestamp in tooltip.

**Wallet persistence:** Encrypted wallet state (AES-256-GCM, PBKDF2-SHA512) is persisted to `.wallet.json` on disk, surviving server restarts. Plaintext private keys are never written to disk. File is gitignored. `DELETE /api/wallet` removes the file. Position store persists to localStorage in the browser.

**Dashboard modular JS:** 9 ES module source files in `public/`, bundled by esbuild into `public/dist/bundle.js` (IIFE format). Entry point: `dashboard-init.js`. `ethers` is bundled from npm — no CDN dependencies. Fonts self-hosted via `@fontsource` packages.

**Shared state:** `botConfig` (in `dashboard-helpers.js`) holds range width, current price, and tick boundaries. Updated by bot config panel, position selection, and optimizer.

**Server → Dashboard data flow:** `startBotLoop()` (in `src/bot-loop.js`) receives `updateBotState` as a callback. Dashboard polls `GET /api/status` every 3 seconds via `dashboard-data.js`.

**History tables:** Per-day P&L (31 days) and Rebalance Events (5-year lookback with copy-to-clipboard TX hash icons) rendered by `dashboard-history.js` from `/api/status` data. Historical rebalance events also populate the Activity Log on first load.

**Lifetime P&L:** User-entered "Initial deposit" (USD) is persisted to both localStorage and server `.bot-config.json`. Lifetime P&L = currentValue + fees + realized − initialDeposit. If no user-entered value, falls back to bot-detected entry value. "Realized gains" is also user-entered for coins sold out of the LP.

**Impermanent loss/gain:** Standard HODL comparison: `IL = LP_value − HODL_value` where `HODL_value = (entryValue/2 / token0PriceAtEntry) × token0PriceNow + (entryValue/2 / token1PriceAtEntry) × token1PriceNow`. Negative = loss vs holding. HODL baseline (entry prices + value) is auto-detected from GeckoTerminal historical prices at NFT mint timestamp (`src/hodl-baseline.js`). Falls back to live epoch prices if GeckoTerminal unavailable. Persisted to `.bot-config.json` via `hodlBaseline` key. Dashboard shows a confirmation dialog on first detection; shows a warning dialog if historical prices were unavailable. Displayed as a signed integer in the Net Return KPI tile.

**Wallet residual tracking:** `src/residual-tracker.js` tracks per-pool token residuals (collected − minted deltas across rebalances). Residuals are capped to actual wallet `balanceOf` when computing USD value, so sold/transferred tokens aren't over-counted. Users account for sold tokens via "Edit Realized Gains". Persisted to `.bot-config.json` via `residuals` key.

**Throttle/doubling:** 3 rebalances within 4× minInterval activates doubling mode (10m → 20m → 40m → 80m…). Clears after 4× currentWait quiet period or midnight UTC reset. All timing resets are UTC-based.

**Optimizer interface:** Three decoupled modules: `optimizer-client.js` (HTTP), `optimizer-applicator.js` (apply logic), `optimizer-scheduler.js` (toggle + polling).

**Wallet validation:** 3 states — `invalid` (red), `valid-known` (green, import immediately), `valid-new` (amber, confirmation required). On-chain activity detection via `getTransactionCount`.

**FOUC prevention:** Range status banner is hidden on page load and only shown after real price data arrives from the bot. Prevents false "OUT OF RANGE" flash on refresh.

**Help popover:** "? Help" button in the header explains the single-position-per-pool model, fund tracking/recycling, range width, and volatility doubling.

**Sync indicator:** "Done Syncing" / "Syncing..." badge at the bottom of the Cumulative P&L card tracks the 5-year event scanner progress.

**Client-side URL routing:** Navigo (~5KB) provides pushState-based routing. URLs follow the pattern `/pulsechain/:walletAddress/:nftContractAddress/:tokenId` for bookmarkable/shareable deep links. The first segment is the blockchain name (`pulsechain`). Server has a SPA catch-all: extensionless GET paths serve `index.html`; paths with file extensions that don't match a real file return 404. Deep-link resolution: if the wallet matches the loaded wallet, the router looks up the tokenId in posStore and activates it; if not found, triggers a scan and retries (up to 3 attempts at 2s intervals). Pending route targets are stored when the wallet isn't loaded yet and resolved after wallet import/restore. URL updates use `router.navigate()` with `callHandler: false` to avoid re-triggering route handlers.

**Dead code detection:** `knip` is installed as a devDependency. The 9 dashboard files show as "unused" because knip can't trace HTML `<script>` tags — these are false positives.

---

### Lint Rules

**ESLint** (`eslint:recommended` + custom):
- `complexity ≤ 17` (error)
- `max-lines ≤ 500` skipBlankLines skipComments (error)
- `eqeqeq always` + `no-var` + `prefer-const` + `strict global`
- `no-unused-vars` — `vars: 'all'` for src/test, `vars: 'local'` for dashboard
- `no-restricted-syntax` — disallows `window.*` assignments
- `9mm/no-separate-contract-calls` — custom rule requiring atomic EVM method pairs (e.g. `decreaseLiquidity` + `collect`) to use `multicall`, not separate awaits. Configurable via `pairs` option. Source: `eslint-rules/no-separate-contract-calls.js`
- `--max-warnings 0` treats warnings as errors
- No `eslint-disable` directives

**stylelint** (`stylelint-config-standard`, `.stylelintrc.json`):
- Standard CSS rules with overrides for: `selector-class-pattern` (allows `9mm-pos-mgr-` prefix), `custom-property-pattern`, `no-descending-specificity`
- Runs on `public/*.css`

---

### Constraints to Maintain
- Every `src/` and `public/dashboard-*.js` file ≤ 500 non-comment lines of code
- No function with cyclomatic complexity > 17
- No `eslint-disable` directives; no `stylelint-disable` directives
- No `window.*` property assignments
- No inline `style="..."` in HTML (except dynamic JS-set `width` values)
- All custom CSS classes prefixed with `9mm-pos-mgr-`
- All date/time displays show both UTC and local time with timezone code
- Full JSDoc on every file and exported function
- All new code covered by tests in `test/`
- `npm run check` must pass clean before any commit
- EVM addresses use EIP-55 checksummed capitalization
- All dollar amounts denominated in USD
- V3 positions only — reject V2 with helpful error message
- **Never use `npx`** — always use `npm` (e.g. `npm run lint`, not `npx eslint`)
