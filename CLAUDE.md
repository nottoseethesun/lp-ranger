## 9mm v3 Position Manager — Project Summary

### Purpose

Auto-rebalancing concentrated liquidity manager for 9mm Pro (Uniswap v3 fork) on PulseChain. **V3 positions only** — V2 positions are rejected with a clear error message. Manages **multiple LP positions simultaneously** across different pools from a single wallet, with per-position start/stop lifecycle (two states: `'running'` and `'stopped'`). All NFT positions for the same pool form a rebalance chain (old positions are drained, not burned). Position token type is **auto-detected**. Supports up to 300 NFT (ERC-721) and ERC-20/PRC-20 LP positions in the browser position store.

Security audit guide: [docs/claude/CLAUDE-SECURITY.md](docs/claude/CLAUDE-SECURITY.md)
CI and merge protocol: [docs/claude/CLAUDE-CI.md](docs/claude/CLAUDE-CI.md)
Code style and formatting: [docs/claude/CLAUDE-CODE-STYLE.md](docs/claude/CLAUDE-CODE-STYLE.md)
Best practices: [docs/claude/CLAUDE-BEST-PRACTICES.md](docs/claude/CLAUDE-BEST-PRACTICES.md)
Testing: [docs/claude/CLAUDE-TESTING.md](docs/claude/CLAUDE-TESTING.md)

---

### Stack

- **Runtime:** Node.js ≥ 22 (no framework)
- **HTTP server:** Node built-in `http` module (`server.js`) — dashboard + bot auto-start
- **Bot loop:** `src/bot-loop.js` — shared rebalance logic (used by both server.js and bot.js)
- **Bot (headless):** `bot.js` — standalone bot without dashboard UI
- **Dashboard:** `public/index.html` + external CSS (`style.css`, `9mm-pos-mgr.css`, `fonts.css`) + 20 modular `dashboard-*.js` files bundled by esbuild into `public/dist/bundle.js`
- **Client-side routing:** Navigo (pushState) — bookmarkable URLs like `/:wallet/:contract/:tokenId`
- **Build:** esbuild bundles dashboard JS + ethers.js + navigo from npm; fonts self-hosted via `@fontsource` (no CDN dependencies)
- **On-chain:** ethers.js v6.7.1, @uniswap/v3-sdk ~3.28.0 + jsbi (exact ratio math)
- **Concurrency:** async-mutex (rebalance lock for nonce-safe TX serialization across positions)
- **Formatting:** Prettier (pre-commit hook via husky + lint-staged)
- **Linter:** ESLint v10 flat config (`eslint.config.js`) + stylelint (`stylelint-config-standard`)
- **Dead code:** knip (devDependency)
- **Tests:** Node built-in `node:test` runner + ganache (in-memory EVM for blockchain mocks)
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) — lint → test (Node 22/24 matrix)

---

### Directory Structure

```text
9mm-manager/
├── .env.example                  # All config keys with defaults and comments
├── .github/workflows/ci.yml      # CI: lint → test (Node 22/24 matrix)
├── eslint.config.js              # ESLint v10 flat config, complexity ≤17, max-lines ≤500
├── package.json                  # Scripts: start, dev, bot, stop, lint, lint:fix, test, test:coverage, test:watch, check
├── server.js                     # HTTP server + bot auto-start + MAIN DOCUMENTATION
├── bot.js                        # Headless bot wrapper (no dashboard UI)
├── scripts/check.sh              # Combined lint + test + coverage check
├── scripts/copy-fonts.sh         # Copies self-hosted WOFF2 fonts from node_modules to public/fonts/
├── scripts/stop.sh               # Graceful shutdown helper (POST /api/shutdown)
├── scripts/api-doc.js            # Scalar API reference server (npm run api-doc → :5556)
├── scripts/wipe-settings.sh      # Back up user settings to tmp/.settings-backup/ (fresh-install sim)
├── scripts/restore-settings.sh   # Restore settings backed up by wipe-settings.sh
├── README.md                     # Concise — refers to server.js for details
├── app-config/                   # ALL app-managed config + state (see server.js file-header for rules)
│   ├── static-tunables/          #   Tracked, user-editable tunables (never rewritten at runtime)
│   │   └── chains.json           #     Per-blockchain tunables (aggregator cancel gas, wait timeout, retry count)
│   ├── api-keys.example.json     #   Tracked format template for the encrypted api-keys.json
│   ├── .bot-config.json          #   Gitignored. Managed positions, HODL baselines, per-position settings
│   ├── .bot-config.backup.json   #   Gitignored. Automatic snapshot created on every load
│   ├── .wallet.json              #   Gitignored. AES-256-GCM encrypted wallet state
│   ├── api-keys.json             #   Gitignored. AES-256-GCM encrypted third-party API keys (Moralis, etc.)
│   └── rebalance_log.json        #   Gitignored. JSON array of historical rebalance events
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
│   ├── dashboard-wallet.js       # Wallet state, known-wallet registry, on-chain activity check
│   ├── dashboard-wallet-import.js # Wallet import flows (seed, private key), key reveal modal, wallet clear
│   ├── dashboard-positions.js    # Position activation, browser modal, shared _activateCore helper
│   ├── dashboard-positions-store.js # In-browser position store with localStorage persistence, rendering
│   ├── dashboard-unmanaged.js    # One-shot detail fetch for unmanaged LP positions
│   ├── dashboard-throttle.js     # Trigger config, throttle state/UI
│   ├── dashboard-throttle-rebalance.js # Rebalance with Updated Range modal
│   ├── dashboard-compound.js     # Compound button handlers, auto-compound toggle, threshold save
│   ├── dashboard-data.js         # Polls /api/status, updates position stats, bot status, resetHistoryFlag
│   ├── dashboard-data-status.js  # Bot status display, alerts, modals, position context helpers
│   ├── dashboard-data-kpi.js     # KPI calculation and display (price, range, fees, P&L)
│   ├── dashboard-data-range.js   # Position range visual rendering (bar, handles, price marker)
│   ├── dashboard-data-deposit.js # Deposit, realized gains, and shared localStorage helpers
│   ├── dashboard-history.js      # Per-day P&L table (11/page) with Residual column, Rebalance Events (4/page, 5-year lookback)
│   ├── dashboard-router.js       # Client-side URL routing (Navigo pushState): /pulsechain/:wallet/:contract/:tokenId
│   ├── dashboard-events.js       # DOM event wiring: clicks, pagination, copy icons
│   ├── dashboard-events-manage.js # Privacy toggle, pool details modal, manage-position toggle
│   ├── dashboard-il-debug.js     # IL/G debug popover: shows calculation inputs for current and lifetime IL
│   ├── dashboard-price-override.js # Manual token price override for positions where auto-detection fails
│   ├── dashboard-closed-pos.js   # Closed-position history view: fetches and displays P&L for drained NFTs
│   └── dashboard-init.js         # Bootstrap: populate wallets, start router, data polling, intervals
├── src/
│   ├── bot-loop.js               # Shared bot logic: startBotLoop, provider/signer setup, epoch cache restore
│   ├── bot-cycle.js              # Poll cycle, execution gates, config reload, private key resolution
│   ├── bot-pnl-updater.js        # P&L snapshot computation (extracted from bot-loop for line-count)
│   ├── bot-recorder.js           # Logging, epoch closing, history scanning, rebalance recording, HODL baseline
│   ├── bot-provider.js           # RPC provider with automatic fallback and fee data patching
│   ├── bot-config-v2.js          # V2 config: load/save app-config/.bot-config.json (global + per-position)
│   ├── migrate-app-config.js     # One-time migration of legacy root config files into app-config/
│   ├── config.js                 # SINGLE SOURCE OF TRUTH for all config — reads .env
│   ├── cli-help.js               # Print --help text for server.js or bot.js
│   ├── logger.js                 # Colored console logging for server-side log prefixes
│   ├── pm-abi.js                 # Single source of truth for the NonfungiblePositionManager ABI
│   ├── position-manager.js       # Multi-position orchestrator: start/stop per position
│   ├── rebalance-lock.js         # Async mutex (via async-mutex) for nonce-safe TX serialization
│   ├── compounder.js             # Compound execution: collect fees → increaseLiquidity + historical detection
│   ├── rebalancer.js             # Core rebalance: remove liquidity → SDK ratio swap → mint (V3-only guard)
│   ├── rebalancer-aggregator.js  # 9mm DEX Aggregator swap path with cancel-and-requote + revert retry
│   ├── rebalancer-swap.js        # Swap orchestration: aggregator (primary) → V3 router (fallback)
│   ├── rebalancer-pools.js       # ABIs, constants, helpers, pool state, and liquidity removal
│   ├── server-positions.js       # Multi-position API route handlers + per-position state management
│   ├── server-routes.js          # Route handler functions extracted from server.js
│   ├── server-scan.js            # LP position scan route handlers with cache integration + symbol resolution
│   ├── event-scanner.js          # On-chain rebalance history via Transfer events (5-year lookback)
│   ├── pool-scanner.js           # Consolidated entry point for pool rebalance history scan with per-pool locking
│   ├── price-fetcher.js          # USD pricing: DexScreener (primary) → GeckoTerminal (historical)
│   ├── hodl-baseline.js          # HODL baseline init: deposited amounts from IncreaseLiquidity + GeckoTerminal for deposit auto-detect
│   ├── il-calculator.js          # Consolidated IL/G math: calcIlMultiplier, estimateLiveValue, computeHodlIL
│   ├── epoch-reconstructor.js    # Reconstructs historical P&L epochs from on-chain rebalance chain
│   ├── epoch-cache.js            # Disk cache for P&L epochs, keyed by pool identity (blockchain.contract.wallet.token0.token1.fee)
│   ├── throttle.js               # Timing enforcement: min interval, daily cap, doubling mode
│   ├── pnl-tracker.js            # Per-epoch and cumulative P&L accounting
│   ├── range-math.js             # Uniswap v3 tick/price math utilities (nearestUsableTick via @uniswap/v3-sdk, tick containment guard)
│   ├── wallet.js                 # Wallet generation, seed import, key import, on-chain activity check
│   ├── position-detector.js      # Auto-detect NFT vs ERC-20; enumerate up to 300 NFTs
│   ├── position-details.js       # One-shot position detail computation for unmanaged positions with full lifetime P&L
│   ├── position-store.js         # In-memory store: up to 300 positions, pagination, select/remove
│   ├── lp-position-cache.js      # Disk cache for LP position scan results, scoped by blockchain/contract/wallet
│   ├── ui-state.js               # Pure formatting helpers + DOM update routines
│   ├── cache-store.js            # JSON file-based disk cache with TTL, scoped filenames (blockchain/contract/wallet)
│   ├── key-store.js              # AES-256-GCM encrypted private key storage (PBKDF2-SHA512)
│   ├── residual-tracker.js       # Per-pool wallet residual tracking (tokens left after rebalance)
│   ├── wallet-manager.js         # Wallet import/clear + encrypted disk persistence
│   └── position-history.js       # Historical data lookup for closed NFT positions (rebalance log, events, prices)
└── test/
    ├── bot-loop.test.js
    ├── bot-loop-pnl.test.js         # IL/PnL override, throttleState, gas deferral, pnlSnapshot, OOR timeout
    ├── bot-config-v2.test.js        # V2 config: load, save, migrate v1→v2, composite keys
    ├── hodl-baseline.test.js
    ├── config.test.js
    ├── rebalancer.test.js
    ├── rebalancer-mint.test.js      # mintPosition, balance-diff swapIfNeeded, _ensureAllowance, executeRebalance
    ├── rebalancer-failures.test.js   # Failure-mode tests: reverts, partial failures, malformed data
    ├── rebalancer-integration.test.js # Stateful simulation: balance tracking across remove→swap→mint
    ├── event-scanner.test.js
    ├── price-fetcher.test.js
    ├── throttle.test.js
    ├── pnl-tracker.test.js
    ├── range-math.test.js
    ├── range-math-fuzz.test.js       # Property-based fuzz tests (500 iterations × 10 properties)
    ├── wallet.test.js
    ├── ui-state.test.js
    ├── il-calculator.test.js
    ├── position-detector.test.js
    ├── position-store.test.js
    ├── position-manager.test.js     # Multi-position orchestrator: start/stop, dedup guard, key migration
    ├── position-rangeW.test.js
    ├── server.test.js
    ├── server-routes.test.js        # Route handler functions
    ├── server-positions.test.js
    ├── server-scan.test.js          # LP position scan handlers
    ├── server-spa-fallback.test.js   # SPA catch-all: extensionless paths → index.html, file extensions → 404
    ├── bot.test.js
    ├── cache-store.test.js
    ├── lp-position-cache.test.js
    ├── disclaimer.test.js
    ├── fund-safety.test.js
    ├── key-store.test.js
    ├── key-migration.test.js        # Composite key migration on rebalance → new tokenId
    ├── rebalance-lock.test.js       # Async mutex: FIFO ordering, pending count, serialization
    ├── residual-tracker.test.js      # Per-pool residual tracking, capping, serialization
    ├── gitignore.test.js             # Ensures .gitignore covers sensitive files (.wallet.json, .env, etc.)
    ├── wallet-manager.test.js        # Wallet import/clear + encrypted disk persistence
    ├── token-symbols.test.js         # Guards against contract addresses leaking into display names
    ├── closed-position-history.test.js # Closed position data fetch + rendering
    ├── epoch-reconstructor.test.js   # Historical P&L epoch reconstruction from chain events
    ├── compounder.test.js           # Compound execution mocks, config keys, atomic write, P&L math
    ├── compound-cycle.test.js       # pollCycle compound gates, config defaults, P&L integration
    ├── compound-coverage.test.js    # Force/auto-compound trigger paths, state persistence, residuals
    └── eslint-rules/
        └── no-separate-contract-calls.test.js  # RuleTester cases for the custom multicall rule
├── .stylelintrc.json                 # stylelint config (extends stylelint-config-standard)
└── tmp/                              # Local temp dir for tests + disk caches (gitignored)
```

**883 tests passing. ESLint + stylelint + Prettier: 0 errors, 0 warnings.**

---

### Key Config Keys (`.env` / `src/config.js`)

| Key | Default | Notes |
| --- | ------- | ----- |
| `CHAIN_NAME` | `pulsechain` | Blockchain: `pulsechain` or `pulsechain-testnet` |
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
| `REBALANCE_TIMEOUT_MIN` | `180` | Minutes of continuous OOR before auto-rebalance (0 = disabled) |
| `SLIPPAGE_PCT` | `0.75` | |
| `TX_SPEEDUP_SEC` | `120` | Seconds before a pending TX is speed-up-replaced with higher gas |
| `TX_CANCEL_SEC` | `1200` | Seconds before a stuck TX is cancelled via 0-PLS self-transfer (20 min) |
| `CHECK_INTERVAL_SEC` | `60` | On-chain poll frequency |
| `MIN_REBALANCE_INTERVAL_MIN` | `10` | |
| `MAX_REBALANCES_PER_DAY` | `20` | |
| `POSITION_MANAGER` | `0xCC05bf…` | NonfungiblePositionManager (9mm Pro V3) |
| `FACTORY` | `0xe50Dbd…` | V3 Factory (9mm Pro) |
| `SWAP_ROUTER` | `0x7bE8fb…` | V3 SwapRouter (9mm Pro) |
| `AGGREGATOR_URL` | `https://api.9mm.pro` | 9mm DEX Aggregator API (0x v1 fork) |
| `AGGREGATOR_API_KEY` | *(built-in)* | 0x-api-key header for aggregator quotes |

Contract address source: <https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json>

---

### npm Scripts

```bash
npm run build          # esbuild bundle + cache-bust stamp (bundle.js?v=<ms>)
npm run build:watch    # esbuild in watch mode (rebuilds on file change)
npm run copy-fonts     # Copy WOFF2 font files from node_modules to public/fonts/
npm start              # node server.js only (no build — run `npm run build` first)
npm run build-and-start # build + start in one command
npm run dev            # build + node --watch server.js
npm run bot            # node bot.js  (headless bot, no dashboard)
npm run stop           # Graceful shutdown via POST /api/shutdown
npm run lint           # ESLint (JS) + stylelint (CSS) — 0 errors required
npm run lint:fix       # ESLint + stylelint auto-fix
npm test               # node --test test/*.test.js
npm run test:coverage  # with --experimental-test-coverage (Node 20+)
npm run test:watch     # watch mode
npm run check          # Combined lint (JS+CSS) + test + coverage check
npm run reset-wallet   # Delete app-config/.wallet.json + clear WALLET_PASSWORD from .env
npm run clean          # reset-wallet + delete bot config, epoch cache, rebalance log, event cache
                       # NOTE: also clear browser localStorage via Settings gear → "Clear Local Storage & Cookies"
npm run nuke           # Delete node_modules + package-lock.json for a clean reinstall
npm run wipe-settings  # Back up user settings to tmp/.settings-backup/ (fresh-install simulation)
npm run restore-settings # Restore settings backed up by wipe-settings
npm run api-doc        # Start Scalar API reference at http://localhost:5556 (API docs)
```

---

### Architecture Decisions

**V3-only:** The rebalancer only supports V3 NFT positions. `executeRebalance()` guards on `position.fee ∈ [100, 500, 2500, 3000, 10000]` and rejects V2 positions with a clear error.

**Unified entry point:** `npm start` runs `server.js` which starts the dashboard, resolves the private key, and auto-starts all managed positions with `status: 'running'` from v2 config. If no key is available, runs in dashboard-only mode; importing a wallet via the dashboard resolves the key for future position starts. `npm run bot` runs headless (no dashboard). `npm run stop` sends `POST /api/shutdown` which calls `positionMgr.stopAll()` for graceful shutdown.

**Rebalance pipeline:** `src/bot-loop.js` provides the shared bot logic used by both `server.js` and `bot.js`. It polls the pool at `CHECK_INTERVAL_SEC`, checks if the current tick is outside [tickLower, tickUpper], applies the OOR threshold check, checks throttle, then calls `executeRebalance()` which does: getPoolState → removeLiquidity → computeDesiredAmounts → swapIfNeeded → mintPosition. All functions accept injected `signer`, `ethersLib`, and config objects for testability.

**DEX Aggregator swap (primary):** `src/rebalancer-aggregator.js` implements the 9mm DEX Aggregator swap path (fork of 0x API v1). `swapIfNeeded` tries the aggregator first (lowest slippage, multi-hop routing across all PulseChain DEXes), falling back to the V3 SwapRouter on failure. The aggregator's `_sendWithRetry` handles two failure modes: (a) **timeout** — TX not confirmed in `waitMs` → cancel nonce at chain-configured gas multiplier, re-quote with fresh calldata, retry; (b) **on-chain revert** (CALL_EXCEPTION, status=0) — route's encoded pool states went stale → nonce already consumed, skip cancel, re-quote immediately, retry. Up to `maxAttempts` (default 3). Chain-specific tunables (`cancelGasMultiplier`, `waitMs`, `maxAttempts`) live in `config/chains.json`, loaded via `config.CHAIN.aggregator`. Uses `quote.gas` (API-provided with buffer) for gasLimit per 0x docs. HTTP error responses are parsed for `reason`, `validationErrors`, and `issues` (balance/allowance).

**PulseChain gas price patch:** PulseChain supports EIP-1559 but ethers.js v6's `getFeeData()` intermittently returns null/0 for all fee fields, causing TXs with 0 gas price that sit pending forever. `createProviderWithFallback()` in `bot-loop.js` patches `provider.getFeeData()` at creation time: if the original returns zero/null, it falls back to a raw `eth_gasPrice` RPC call. This ensures ALL transactions (multicall, swap, mint) automatically get proper gas pricing — no per-call-site overrides needed.

**TX speed-up + auto-cancel:** `_waitOrSpeedUp()` in `rebalancer.js` wraps every `tx.wait()` call with a 4-phase recovery pipeline. **Phase 1:** wait for confirmation up to `TX_SPEEDUP_SEC` (default 120s). **Phase 2:** speed-up — fetch current gas price, take the higher of current vs original, bump by 1.5×, resend at the same nonce. **Phase 3:** wait for either original or replacement to confirm up to `TX_CANCEL_SEC` (default 1200s = 20 min total). **Phase 4:** auto-cancel — send a 0-PLS self-transfer at the stuck nonce with 50 Gwei gas to free the nonce, then throw a `cancelled: true` error so the bot resumes polling. All four TX types are covered: approve, multicall (removeLiquidity), swap, and mint. Each phase logs clearly to the server console.

**SDK ratio math:** `computeDesiredAmounts` uses `@uniswap/v3-sdk` exact 160-bit sqrtPrice math (`maxLiquidityForAmounts` + `SqrtPriceMath`) to determine the precise token ratio the Position Manager needs for the target tick range, then computes the swap to convert excess into the deficient token. Falls back to a 50/50 USD value split when no tick range is provided (e.g. price-only callers). The SDK path requires `jsbi` (direct dependency).

**Quote-based swap slippage:** Before executing a swap, the bot simulates it via `staticCall` to get the real expected output (accounting for price impact). The user's slippage % is applied to the *quoted* output, not the spot price — so `amountOutMinimum` is realistic for the pool's actual liquidity. The safety guard aborts the swap when price impact exceeds the user's slippage setting — user must increase slippage and manually rebalance. When a swap abort pauses the bot, it stops retrying until the user changes slippage (which auto-clears the pause) or triggers a manual rebalance.

**Preserve tick spread:** On rebalance, the bot preserves the existing position's tick spread (tickUpper − tickLower) and re-centers it on the current price via `rangeMath.preserveRange()`. This prevents narrow positions from being widened to match `REBALANCE_OOR_THRESHOLD_PCT`. The range width is determined by the original position, not a config setting.

**Tick containment:** `computeNewRange` includes a post-rounding check that ensures `lowerTick < currentTick < upperTick`. When coarse tick spacing (e.g. 50 for fee tier 10000) causes both rounded ticks to land on the same side of the current tick, the range is shifted to contain it. This prevents minting out-of-range positions that accept only one token.

**OOR threshold:** The `REBALANCE_OOR_THRESHOLD_PCT` setting (default 10) controls how far the price must move **beyond** the position boundary before triggering a rebalance. A value of 10 means the price must move 10% past tickLower or tickUpper. A value of 0 triggers immediately on any OOR. The dashboard shows an amber "WITHIN THRESHOLD" banner when OOR but within the threshold zone.

**OOR timeout:** `REBALANCE_TIMEOUT_MIN` (default 180, i.e. 3 hours) triggers a rebalance after the position has been continuously OOR for the configured duration, even if the price hasn't crossed the OOR threshold bars. The bot tracks `oorSince` (timestamp of first OOR detection). When the timeout expires, the rebalance falls through to the existing throttle + execution path — no special bypass. `oorSince` is cleared when the price returns to range or after a successful rebalance. Set to 0 to disable. The dashboard shows a countdown ("Timeout: MM:SS") in the "WITHIN THRESHOLD" banner. The setting has its own Save button and is persisted to `.bot-config.json`.

**USD pricing:** DexScreener (primary, no key). 60s in-memory cache. See `src/price-fetcher.js`. Historical prices fetched from GeckoTerminal OHLCV API (free, no key, 30 calls/min). USD values (token prices, exit/entry amounts) are recorded in `rebalance_log.json` at rebalance time to avoid needing historical price lookups.

**Multi-position management:** The tool manages **multiple LP positions simultaneously** across different pools from a single wallet. Each managed position gets its own independent `startBotLoop()` instance sharing a single provider/signer. A **rebalance lock** (`src/rebalance-lock.js`, backed by `async-mutex`) ensures only one position sends transactions at a time (same wallet = same nonce), while all positions continue polling independently. The `src/position-manager.js` orchestrator tracks all managed positions with start/stop lifecycle (two states: `'running'` and `'stopped'`). When rebalancing, the old NFT is drained (`decreaseLiquidity` + `collect`) but NOT burned. Rebalance history is detected via consecutive mint events. Closed positions (liquidity=0) are displayed but the bot skips rebalance checks.

**Position key format:** All per-position state is keyed by a **composite key**: `blockchain-wallet-contract-tokenId` (dash-separated). Example: `pulsechain-0x4e448...-0xCC05b...-157149`. Built/parsed by `compositeKey()` / `parseCompositeKey()` in `src/bot-config-v2.js`. The same components appear in the URL path.

**Position lifecycle:** `POST /api/position/manage { tokenId }` starts a new bot loop. `DELETE /api/position/manage { key }` stops and removes from management (sets `status: 'stopped'`, keeps config data for history). No pause/resume — only start and stop. On server restart, all positions with `status: 'running'` in config auto-start. Focus is client-side (URL determines which position a browser tab shows) — the server does NOT track focus. The `handleManage` start path uses a `_starting` Set guard + try/catch/finally to prevent duplicate bot loops and ensure cleanup on failure.

**Rebalance lock:** No timeout-based release — blockchains can hold a TX pending indefinitely. If stuck, the lock holder speed-ups (1.5× gas) then sends a 0-PLS self-cancel at the stuck nonce. Lock only releases after TX confirmation. This guarantees the nonce is always clear before the next position rebalances.

**Throttling:** Per-position throttle (independent doubling mode per pool), but **wallet-level daily cap** (default 20, shared across all positions). A volatile pool's doubling doesn't slow a stable pool.

**Compounding:** `src/compounder.js` collects unclaimed fees via `pm.collect()` then re-deposits them as liquidity via `pm.increaseLiquidity()` on the same NFT — no swap, no range change, no new NFT. Mission Control panel in the dashboard provides manual "Compound Now" (disabled when fees < `COMPOUND_MIN_FEE_USD`, default $1) and auto-compound (toggle + USD threshold, default $5). Auto-compound checks every poll cycle when in-range, throttled to `max(5 × CHECK_INTERVAL_SEC, 300s)` between executions. Compound amounts are tracked in `totalCompoundedUsd` (per-position in `.bot-config.json`) and subtracted from both Net P&L Return and Profit to avoid double-counting fees. "Fees Earned" includes compounded fees (hover text explains). Historical compounds are detected by scanning `IncreaseLiquidity` events for all NFTs in the rebalance chain (first event = mint deposit, subsequent = compounds), capped by total `Collect` amounts. Config write uses atomic temp-file + rename to prevent empty-file corruption from shutdown races.

**Atomic config write:** `saveConfig` writes to `app-config/.bot-config.json.tmp` first, then atomically renames to `app-config/.bot-config.json`. Prevents empty-file corruption if the process exits mid-write (SIGINT race during shutdown).

**App-managed config layout:** All runtime state files and static tunables live under `app-config/`. See the `app-config/` section of `server.js`'s file-header JSDoc for the full layout, file inventory, migration behavior, and the rules for where future config files should go.

**Post-rebalance key migration:** When a position rebalances and mints a new NFT, the composite key changes (new tokenId). `position-manager.migrateKey()` and `bot-config-v2.migratePositionKey()` carry over HODL baseline and residuals from the old key to the new key. P&L epochs do NOT need migration — they're keyed by pool identity, not tokenId (see epoch cache below).

**P&L breakdown:** Two components: (a) price-change P&L (position value change from token price movements, including IL), and (b) fee P&L (trading fees earned while in range). Per-day aggregation (up to 31 days) with running cumulative. Historical USD token prices stored per-epoch for accurate retrospective P&L.

**Gas tracking:** All gas costs are tracked in USD per P&L epoch via `pnl-tracker.addGas()`. Three sources: (a) **rebalance gas** (remove + swap + mint TXs) recorded on epoch close in `_closePnlEpoch`; (b) **compound gas** (collect + increaseLiquidity TXs) added to the live epoch in `_recordCompound`; (c) **initial mint gas** extracted from the mint TX receipt during HODL baseline initialization (`hodl-baseline.js` stores `mintGasWei`), converted to USD and applied once to the first epoch via `_applyMintGas` in `bot-pnl-updater.js`. Speed-up replacement TXs use the same nonce, so the confirmed receipt already reflects the actual gas paid.

**Disk cache:** `src/cache-store.js` provides JSON file-based caching with TTL for expensive blockchain queries (event scanner 5-year lookback, P&L history). Cache filenames are scoped by `blockchain-contract-wallet-pool` to isolate data across chains, contracts, and wallets. App remains stateless — cache is pure performance optimisation, rebuilt from blockchain if deleted. **Event cache is invalidated after every successful rebalance** (`clearPoolCache(position, walletAddress)` in bot-loop.js) so the next scanner run finds the new NFT mint event. Browser caches rebalance events in localStorage (`9mm_rebalance_events`) for instant display on page load; this localStorage cache is cleared on position switch via `resetHistoryFlag()`.

**Event scanner rate limiting:** 250ms delay between RPC chunk queries (`_CHUNK_DELAY_MS`) to avoid overwhelming the endpoint. With 10,000-block chunks, a 5-year scan (~15.8M blocks) takes ~1,580 chunks. Pool-age optimisation reduces this for younger pools.

**Bot config persistence (v2):** `.bot-config.json` has two sections: `global` (gas strategy, trigger type) and `positions` (per-composite-key config: status, threshold, timeout, slippage, HODL baseline, residuals). The `positions` object is the **single source of truth** — managed positions are derived via `managedKeys(cfg)` which returns keys where `status === 'running'`. No separate `managedPositions` array (eliminated to prevent sync bugs). P&L epochs are stored separately in the epoch cache (see below), not in bot-config. `POST /api/config` **requires** a fully-qualified `positionKey` (validated by `parseCompositeKey`) when sending position-specific keys (`POSITION_KEYS`) — requests without it are rejected with 400. Global-only keys (`GLOBAL_KEYS`) do not require `positionKey`. Managed by `src/bot-config-v2.js`.

**Pool-age optimisation:** Event scanner checks the V3 Factory's `PoolCreated` event to find when the pool was deployed, then skips all blocks before that. Can save thousands of RPC queries for pools younger than 5 years.

**CSS architecture:** All styles externalized — zero inline `<style>` blocks, near-zero inline `style="..."` (only dynamic `width` values set by JS remain). Three CSS files: `fonts.css` (self-hosted `@font-face` declarations), `style.css` (core layout/components), and `9mm-pos-mgr.css` (semantic utility classes, all prefixed `9mm-pos-mgr-`). All pass `stylelint-config-standard`. Custom CSS classes use the `9mm-pos-mgr-` namespace to avoid collisions. **Global UI scale:** `body { zoom: 1.5 }` in `style.css` scales all elements uniformly — fonts, margins, icons, modals, popovers.

**Date/time display:** All user-visible timestamps show **both UTC and local time** with timezone code, e.g. `2026-03-15 14:30 UTC (3/15/2026 10:30 AM CDT)`. Centralized via `fmtDateTime()` in `dashboard-helpers.js`. Relative times ("5s ago") are timezone-neutral with full timestamp in tooltip.

**Wallet persistence:** Encrypted wallet state (AES-256-GCM, PBKDF2-SHA512) is persisted to `.wallet.json` on disk, surviving server restarts. Plaintext private keys are never written to disk. File is gitignored. `DELETE /api/wallet` removes the file. Position store persists to localStorage in the browser.

**Dashboard modular JS:** 17 ES module source files in `public/`, bundled by esbuild into `public/dist/bundle.js` (IIFE format). Entry point: `dashboard-init.js`. `ethers` is bundled from npm — no CDN dependencies. Fonts self-hosted via `@fontsource` packages.

**Shared state:** `botConfig` (in `dashboard-helpers.js`) holds range width, current price, and tick boundaries. Updated by bot config panel and position selection.

**Server → Dashboard data flow:** Each bot loop receives a position-scoped `updateBotState` callback (in `src/server-positions.js`) that writes to the per-position state map, persists to v2 config, and syncs P&L epochs to the epoch cache. `GET /api/status` returns `{ global: {...}, positions: { [compositeKey]: {...} } }` — each browser tab reads its own position's data by key. Dashboard polls every 3 seconds via `dashboard-data.js`. The `keyRef = { current: key }` pattern in `server-positions.js` allows composite keys to mutate during a position's lifetime (e.g. after rebalance mints a new tokenId) — all closures automatically use the updated key without rebuilding callbacks.

**History tables:** Per-day P&L (8 per page, up to 31 days) and Rebalance Events (8 per page, 5-year lookback with copy-to-clipboard TX hash icons) rendered by `dashboard-history.js` from `/api/status` data. Both tables have Prev/Next pagination pinned to the card bottom. Historical rebalance events also populate the Activity Log once the event scanner completes (gated by `rebalanceScanComplete` to avoid stale localStorage cache).

**Lifetime P&L:** User-entered "Initial deposit" (USD) is persisted to both localStorage and server `.bot-config.json`. Lifetime P&L = currentValue + fees + realized − initialDeposit. If no user-entered value, falls back to bot-detected entry value. "Realized gains" is also user-entered for coins sold out of the LP.

**Impermanent loss/gain:** All IL/G math is consolidated in `src/il-calculator.js` — single source of truth, no duplication. Three exported functions: `calcIlMultiplier(priceRatio)` (v2 formula), `estimateLiveValue(entryValue, priceRatio)` (v3 estimate), and `computeHodlIL({ lpValue, hodlAmount0, hodlAmount1, currentPrice0, currentPrice1 })` (HODL comparison using actual deposited token amounts). The HODL comparison uses **only current prices** for valuation — the original deposited token amounts (from the `IncreaseLiquidity` event on the mint TX) determine the HODL portfolio. No historical USD prices are needed for IL. `IL = LP_value − (amount0_deposited × currentPrice0 + amount1_deposited × currentPrice1)`. Negative = loss vs holding. Two separate IL values: `snap.totalIL` (current position, from `hodl-baseline.js`) and `snap.lifetimeIL` (from first epoch's deposited amounts). HODL baseline stores actual deposited amounts (`hodlAmount0`, `hodlAmount1`) plus historical prices only for initial deposit auto-detection. Persisted to `.bot-config.json` via `hodlBaseline` key.

**Wallet residual tracking:** `src/residual-tracker.js` tracks per-pool token residuals (collected − minted deltas across rebalances). Residuals are capped to actual wallet `balanceOf` when computing USD value, so sold/transferred tokens aren't over-counted. Users account for sold tokens via "Edit Realized Gains". Persisted to `.bot-config.json` via `residuals` key.

**Throttle/doubling:** 3 rebalances within 4× minInterval activates doubling mode (10m → 20m → 40m → 80m…). Clears after 4× currentWait quiet period or midnight UTC reset. All timing resets are UTC-based.

**Epoch cache (pool-keyed P&L):** `src/epoch-cache.js` stores P&L epochs in `tmp/pnl-epochs-cache.json`, keyed by **pool identity** (`blockchain.contract.wallet.token0.token1.fee`) instead of by tokenId. This means P&L history survives rebalances (which mint new tokenIds) without migration. On bot loop start, `getCachedEpochs()` restores the tracker state; `setCachedEpochs()` persists after each update via `_persistEpochCache()` in `server-positions.js`. Supports both full tracker state `{ closedEpochs, liveEpoch }` and legacy array format.

**Cache scoping pattern:** All disk caches use a consistent scoping pattern for multi-chain/multi-wallet isolation:

- **Event cache:** `event-cache-{blockchain}-{contract}-{wallet}-{token0}-{token1}-{fee}.json`
- **LP position cache:** `lp-position-cache-{blockchain}-{contract}-{wallet}.json`
- **Epoch cache:** keyed by `blockchain.contract.wallet.token0.token1.fee` within a single JSON file

All use abbreviated prefixes (first 5-6 chars) to keep filenames manageable.

**Position switch consolidation:** All position activation paths (user selection, deep link, bot sync) flow through a single `_activateCore(idx, opts)` helper in `dashboard-positions.js`. This ensures consistent state cleanup on every switch: exits closed-position view, clears localStorage rebalance event cache (`resetHistoryFlag()`), resets config sync flag (`_configSynced`), updates the position store, applies config, syncs the URL, and fires an immediate status poll (`pollNow()`) so the new position's server data appears instantly without waiting for the 3-second interval. `resetHistoryFlag()` in `dashboard-data.js` is a standalone function that can be called independently without resetting all polling state.

**Wallet validation:** 3 states — `invalid` (red), `valid-known` (green, import immediately), `valid-new` (amber, confirmation required). On-chain activity detection via `getTransactionCount`.

**FOUC prevention:** Range status banner is hidden on page load and only shown after real price data arrives from the bot. Prevents false "OUT OF RANGE" flash on refresh.

**Closed position viewing:** Users can browse closed positions (liquidity=0) in the Position Browser. `dashboard-closed-pos.js` manages a "history viewing mode" that fetches historical P&L data via `GET /api/position/:tokenId/history` (backed by `src/position-history.js`) and displays it without disrupting the bot's active position. An amber banner shows "Viewing closed position NFT #..." with a "Return to Active Position" button. KPI updates are paused in closed-view mode (`isViewingClosedPos()` gate in poll handler).

**Help popover:** "? Help" button in the header explains the single-position-per-pool model, fund tracking/recycling, range width, volatility doubling, gas cost protection, closed positions, and troubleshooting (rebalance timing).

**Sync indicator:** "Done Syncing" / "Syncing..." badge at the bottom of the Cumulative P&L card tracks the 5-year event scanner progress.

**Client-side URL routing:** Navigo (~5KB) provides pushState-based routing. URLs follow the pattern `/pulsechain/:walletAddress/:nftContractAddress/:tokenId` for bookmarkable/shareable deep links. The first segment is the blockchain name (`pulsechain`). Server has a SPA catch-all: extensionless GET paths serve `index.html`; paths with file extensions that don't match a real file return 404. Deep-link resolution: if the wallet matches the loaded wallet, the router looks up the tokenId in posStore and activates it via `activateByTokenId()` (display-only — does NOT trigger server position switch). If not found, triggers a scan and retries (up to 3 attempts at 2s intervals). Pending route targets are stored when the wallet isn't loaded yet and resolved after wallet import/restore. URL updates use `router.navigate()` with `callHandler: false` to avoid re-triggering route handlers. `syncRouteToState()` updates the URL when the bot's active position changes (e.g. after rebalance), allowing the update when the URL's tokenId differs from the active position's tokenId.

**Dead code detection:** `knip` is installed as a devDependency. The 17 dashboard files show as "unused" because knip can't trace HTML `<script>` tags — these are false positives.

**Rebalance diagnostic logs:** Step-by-step console logs trace the entire rebalance pipeline: Steps 1 (getPoolState), 2 (ownerOf), 3 (readLiquidity), 3a (removeLiquidity), 6 (swap), 7a (allowance), 7b (mint TX submit), 7c (mint TX confirm). Each TX confirmation logs `gasUsed`, `gasPrice`, and `blockNumber`. Every `getFeeData()` call logs the returned `gasPrice`, `maxFeePerGas`, and `maxPriorityFeePerGas` values. Speed-up replacements log original/current/bumped gas and the replacement TX hash. Position detection, bot state changes, and `activePositionId` transitions are also logged. These logs are permanent — not removed after debugging.

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
- No `eslint-disable` directives for main lint rules; no `stylelint-disable` directives. Security lint rules (`9mm/no-number-from-bigint`, `9mm/no-secret-logging`) may use per-line `eslint-disable-next-line` with a documented `-- Safe: <reason>` comment
- Never exclude entire files from any lint pass — use per-line directives for specific exceptions
- No `window.*` property assignments
- Full JSDoc on every file and exported function
- All new code covered by tests in `test/`
- `npm run check` must pass clean before any commit
- EVM addresses use EIP-55 checksummed capitalization
- All dollar amounts denominated in USD
- V3 positions only — reject V2 with helpful error message

See [docs/claude/CLAUDE-BEST-PRACTICES.md](docs/claude/CLAUDE-BEST-PRACTICES.md) for coding, testing, formatting, UI, and workflow best practices.
