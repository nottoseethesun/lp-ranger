# LP Ranger — Engineering Reference

This is the canonical reference for configuration, runtime state, development
tools, and the check-report pipeline. It covers every environment variable,
every on-disk file the app reads or writes, every npm script, and the CI /
reporting workflow.

For a higher-level overview of how the bot and dashboard cooperate, see
[`docs/architecture.md`](architecture.md). The HTTP route surface is
documented interactively via Scalar — see the
[API Documentation](#api-documentation) section below for how to start it.
The execution entry point itself is described in the
[`server.js`](#serverjs) section below, which walks through the startup
sequence.

---

## Table of Contents

- [Terminology](#terminology)
- [Quick Start](#quick-start)
- [Command-Line Flags](#command-line-flags)
- [Environment Variables](#environment-variables)
- [USD Pricing](#usd-pricing)
- [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause)
- [Balanced-Band Telegram Notification](#balanced-band-telegram-notification)
- [Dust Threshold](#dust-threshold)
- [Lifetime History Lookback](#lifetime-history-lookback)
- [Client-Side URL Routing](#client-side-url-routing)
- [Development Tools](#development-tools)
  - [Build and Run](#build-and-run)
  - [Lint and Test](#lint-and-test)
  - [Wallet Management](#wallet-management)
  - [Housekeeping](#housekeeping)
  - [Utilities](#utilities)
    - [Diagnostic Utilities](#diagnostic-utilities)
      - [Scenario-Reproduction Scripts](#scenario-reproduction-scripts)
    - [Cache Utilities](#cache-utilities)
- [The app-config Directory](#the-app-config-directory)
- [Bot Config Defaults](#bot-config-defaults)
- [Security](#security)
  - [What's at Stake](#whats-at-stake)
  - [Summary of Primary Controls](#summary-of-primary-controls)
  - [Network](#network)
    - [Host Binding (Domain)](#host-binding-domain)
    - [Reverse Proxy Configuration Warning](#reverse-proxy-configuration-warning)
    - [Protocol Choice](#protocol-choice)
    - [Rate Limiting](#rate-limiting)
  - [Message Security](#message-security)
    - [CORS Origin Guard](#cors-origin-guard)
    - [CSRF Tokens](#csrf-tokens)
    - [HTTP Method Allowlist](#http-method-allowlist)
    - [Path Traversal in Static Serving](#path-traversal-in-static-serving)
  - [Authentication & Key Management](#authentication--key-management)
    - [Encryption at Rest](#encryption-at-rest)
    - [In-Memory Handling](#in-memory-handling)
    - [Secret Scanning](#secret-scanning)
    - [Gitignore Enforcement](#gitignore-enforcement)
  - [Cryptographic Primitives](#cryptographic-primitives)
    - [No Custom Crypto](#no-custom-crypto)
    - [Authenticated Encryption](#authenticated-encryption)
    - [Secure Randomness](#secure-randomness)
  - [Input Validation & Data Modeling](#input-validation--data-modeling)
    - [Composite Key Parsing](#composite-key-parsing)
    - [Config Key Allowlist](#config-key-allowlist)
    - [Checksummed Addresses](#checksummed-addresses)
    - [BIP-39 Seed Validation](#bip-39-seed-validation)
  - [Injection Prevention](#injection-prevention)
    - [`eval` / `child_process` / Dynamic `require`](#eval--child_process--dynamic-require)
    - [Prototype Pollution](#prototype-pollution)
    - [XSS (Cross-Site Scripting) / DOM Safety](#xss-cross-site-scripting--dom-safety)
  - [Filesystem Safety](#filesystem-safety)
  - [On-Chain / Transaction Security](#on-chain--transaction-security)
    - [Nonce Serialization](#nonce-serialization)
    - [TX Recovery Pipeline](#tx-recovery-pipeline)
    - [RPC Failover](#rpc-failover)
    - [Slippage Guards](#slippage-guards)
    - [Swap Gates (Dust + Gas)](#swap-gates-dust--gas)
    - [Atomic Multicall](#atomic-multicall)
    - [BigInt Precision](#bigint-precision)
  - [Supply Chain & Dependencies](#supply-chain--dependencies)
    - [Reputable-Package Philosophy](#reputable-package-philosophy)
    - [Pinned Production Releases](#pinned-production-releases)
    - [`npm audit`](#npm-audit)
    - [CI Enforcement](#ci-enforcement)
  - [Runtime Hardening](#runtime-hardening)
    - [Strict Mode Everywhere](#strict-mode-everywhere)
    - [Error Guard](#error-guard)
    - [Graceful Shutdown](#graceful-shutdown)
  - [Code Review Controls](#code-review-controls)
    - [Build and Infrastructure Scripts](#build-and-infrastructure-scripts)
    - [GitHub Actions Workflows](#github-actions-workflows)
  - [Test-Time State Protection](#test-time-state-protection)
- [Check Report Artifacts](#check-report-artifacts)
- [API Documentation](#api-documentation)
- [`server.js`](#serverjs)
- [Dead Code Detection](#dead-code-detection)
- [SVG Assets](#svg-assets)
- [Debugging](#debugging)
  - [Node Debugger (Inspector)](#node-debugger-inspector)
- [Dependency Management](#dependency-management)
  - [Philosophy](#philosophy)
  - [The Main Branch (Caret Ranges + Committed Lockfile)](#the-main-branch-caret-ranges--committed-lockfile)
  - [Overrides](#overrides)
  - [Production Releases](#production-releases)
    - [The Release Workflow](#the-release-workflow)
    - [What Ships in a Release Tarball](#what-ships-in-a-release-tarball)
    - [End-User Install Path](#end-user-install-path)
  - [Why This Is a Security Feature](#why-this-is-a-security-feature)
  - [Security Audits](#security-audits)
  - [Lifecycle Script Controls](#lifecycle-script-controls)
  - [Node.js Engine Requirement](#nodejs-engine-requirement)
  - [Dependency Inventory](#dependency-inventory)

---

## Terminology

In this codebase an **epoch** is a P&L tracking period that spans one NFT
position's lifetime — from mint to drain (rebalance). Each rebalance closes
the current epoch and opens a new one for the freshly minted NFT. This is
unrelated to the blockchain meaning of "epoch" (a fixed group of blocks used
for consensus or validator rotation).

---

## Quick Start

1. Copy `.env.example` to `.env` and fill in your values.
2. `npm install`
3. `npm start` — dashboard + bot (if wallet key available)
4. `npm run bot` — headless bot only (no dashboard)

---

## Command-Line Flags

All flags are passed through the `npm` script for the relevant entry point.
npm forwards everything after the `--` separator to the underlying Node
process unchanged, so `npm start -- --verbose` is identical to running
`node server.js --verbose` directly. Use the npm form in scripts, CI, and
documentation — the raw `node` form is an implementation detail.

| Flag | npm Invocation | Description |
| --- | --- | --- |
| `--verbose`, `-v` | `npm start -- --verbose` | Verbose logging: per-cycle fee details and out-of-range poll diagnostics that are hidden by default. Can also be set via `VERBOSE=1` in `.env` or environment. |
| `--log-file [PATH]` | `npm start -- --log-file` | Tee every byte written to `process.stdout` and `process.stderr` to a file (ANSI color escapes stripped so the on-disk log is grep-friendly). `PATH` is optional — when omitted, the path falls through to `app-config/app-defaults-for-user-configurable/logging.json` and finally to the built-in default `logs/lp-ranger.log`. With a path: `npm start -- --log-file path/to/run.log`. The file is opened in append mode (multiple runs accumulate); rotate or truncate externally if it grows unbounded. Operators who want the tee always-on can set `"enabled": true` in `logging.json` and run `npm start` with no flag. Implemented by [`src/log-file.js`](../src/log-file.js); wired into both `server.js` and `bot.js` via [`src/boot-log-file.js`](../src/boot-log-file.js). |
| `--help`, `-h` | `npm start -- --help` | Show all command-line options and exit. |
| `--start-with-price-lookups-unpaused` | `npm run bot -- --start-with-price-lookups-unpaused` | **Bot-only** (`npm run bot`). Skip the default start-paused state for headless mode (see [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause)). Use this when you want continuous P&L cache warming on a headless box. |

All flags above work with the alternate entry points too:
`npm run build-and-start -- <flags>`, `npm run dev -- <flags>`, and
`npm run bot -- <flags>` (for flags supported by the bot). The `--`
separator is required for every `npm run …` invocation as well — it is
NOT a `npm start`-only quirk. For example, to build the dashboard
bundle and then start the app with log-to-file enabled, use:

```sh
npm run build-and-start -- --log-file
```

Without the `--`, npm consumes the flag itself and forwards nothing to
the script — the tee will silently not engage.

---

## Environment Variables

**All settings in this section live in `.env`** at the project root. Copy
[`.env.example`](../.env.example) to `.env` and edit the values you need.
Every variable below is read by [`src/config.js`](../src/config.js) at
startup. Nothing in this section belongs in
`app-config/app-defaults-for-user-configurable/chains.json`, `app-config/user-configurable/bot-config.json`, or
`app-config/user-configurable/api-keys.json` — for those files, see the
[The `app-config` Directory](#the-app-config-directory) section below.

### Server (`.env`)

- `PORT` — HTTP port (default: `5555`). The CORS origin guard is locked to
  `localhost:<PORT>`, so changing this value automatically updates the
  allowed origin.
- `HOST` — Bind address (default: `127.0.0.1`, localhost only). Set to
  `0.0.0.0` for LAN access.

### Request Security

Mutating API endpoints (POST, DELETE) are protected by three layers —
network binding, CORS origin guard, and CSRF tokens. GET requests
require none of them. Full details and the lint/test enforcement behind
each layer live in the [Security](#security) section below.

### Chain Selection (`.env`)

- `CHAIN_NAME` — Blockchain to connect to (default: `pulsechain`). Set to
  `pulsechain-testnet` for PulseChain Testnet v4. `CHAIN_NAME` selects which
  entry the bot loads out of `app-config/app-defaults-for-user-configurable/chains.json`; the
  per-chain RPC endpoints, contract addresses, and gas multipliers
  themselves live in that file, not in `.env`.

### Wallet (`.env`, Required for Bot)

- `PRIVATE_KEY` — Hex private key (`0x`-prefixed)

### Position Discovery (`.env`)

- `POSITION_ID` — NFT token ID to manage (leave blank for auto-scan)
- `ERC20_POSITION_ADDRESS` — ERC-20 position token address (blank for NFT-only)

### Bot Behaviour (`.env`)

- `RPC_URL` — JSON-RPC endpoint (default: `https://rpc-pulsechain.g4mm4.io`)
- `RPC_URL_FALLBACK` — Fallback RPC (default: `https://rpc.pulsechain.com`)
- `REBALANCE_OOR_THRESHOLD_PCT` — % beyond boundary to trigger rebalance
  (default: `10`)
- `REBALANCE_TIMEOUT_MIN` — Minutes of continuous OOR before auto-rebalance
  (default: `180`, `0`=disabled)
- `SLIPPAGE_PCT` — Max slippage for txns (default: `0.5`)
- `TX_SPEEDUP_SEC` — Seconds before a pending TX is speed-up-replaced
  (default: `120`)
- `TX_CANCEL_SEC` — Seconds before a stuck TX is cancelled via 0-PLS
  self-transfer (default: `1200` = 20 min)
- `CHECK_INTERVAL_SEC` — Poll interval (default: `300`)
- `MIN_REBALANCE_INTERVAL_MIN` — Min wait between rebalances (default: `10`)
- `MAX_REBALANCES_PER_DAY` — Hard daily cap (default: `20`)
- `LOG_FILE` — JSON log path (default: `./app-data/rebalance_log.json`)

### Contract Address Overrides (`.env`)

These variables override the per-chain defaults from
`app-config/app-defaults-for-user-configurable/chains.json`. In normal operation you should
never need to set them — only edit them if you're pointing the bot at a
custom deployment of the 9mm Pro V3 contracts.

Canonical deployment addresses:
<https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json>

- `POSITION_MANAGER` — NonfungiblePositionManager (default: `0xCC05bf…`)
- `FACTORY` — V3 Factory (default: `0xe50Dbd…`)
- `SWAP_ROUTER` — V3 SwapRouter (default: `0x7bE8fb…`)

### Where Other Configuration Lives

- **Per-chain static tunables** (RPC endpoints, contract addresses, gas
  multipliers, aggregator timeouts) →
  `app-config/app-defaults-for-user-configurable/chains.json`. Tracked in git, user-editable.
- **Managed positions and per-position settings** (HODL baselines,
  thresholds, slippage overrides, auto-compound config) →
  `app-config/user-configurable/bot-config.json`. Runtime-managed, gitignored. Written by
  the dashboard and bot loops — not hand-edited.
- **Encrypted wallet** → `app-config/user-configurable/wallet.json`. Managed via the
  dashboard import flow.
- **Encrypted third-party API keys** (Moralis, etc.) →
  `app-config/user-configurable/api-keys.json`. Managed via the dashboard Settings dialog.

See the [The `app-config` Directory](#the-app-config-directory) section
below for the full inventory and the rules for where future config files
should go.

---

## USD Pricing

Token prices (for P&L display) are resolved through three sources tried in
priority order, with an in-memory 60-second cache at the top. Implementation
lives in [`src/price-fetcher.js`](../src/price-fetcher.js).

### Current Prices

`fetchTokenPriceUsd()` tries each source in order and returns the first
non-zero result:

1. **Moralis** (primary) — **the API key is free** (sign up at
   <https://moralis.io>); paste it into the dashboard Settings dialog and
   it's encrypted at rest in `app-config/user-configurable/api-keys.json`. Most reliable for
   meme tokens that the free aggregators drop.

   **Free-tier quota caveat:** the free Moralis plan has a daily compute
   quota. Very large position sets, repeated cache clears (`npm run clean`,
   `dev-clean`, or manually deleting `tmp/`), or a rapid sequence of
   "scan a fresh wallet" operations can burn through the daily budget in
   one session. Once the quota is exhausted the key returns a
   usage-exceeded error and **nothing else can be done with that key
   until the next 24-hour cycle rolls over** — the only workarounds are
   to wait it out, upgrade to a paid plan, or rely on the GeckoTerminal /
   DexScreener fallbacks below (which don't give as complete coverage on
   meme tokens).

   Quota-exhaustion errors are parsed separately from invalid-key errors
   so the dashboard shows an **orange** Moralis indicator while you're
   quota-locked, versus a **deep red** indicator for an invalid or
   unauthorized key.
2. **GeckoTerminal** — free, no key needed, but rate-limited to 30 calls/min
   (see "Rate limiting" below).
3. **DexScreener** — free, no key needed, but drops tokens with no 24h LP
   activity, which is why it's the last fallback rather than the first.

### Historical Prices

`fetchHistoricalPriceGecko()` (and the Moralis equivalent) resolves the USD
price of a token at a specific block number. This is how the HODL baseline,
P&L epoch reconstruction, and closed-position history are populated.

The historical flow is substantially more complex than current-price
fetching because GeckoTerminal's OHLCV endpoint requires a **pool address**
and a **pool-side token identifier** (`base` or `quote`) — which don't
always match the Uniswap v3 `token0`/`token1` ordering:

- **Pool orientation cache** — on first lookup per pool, a one-shot GET to
  the GeckoTerminal pool-info endpoint records whether the pool's `base`
  side is `token0` (`normal`) or `token1` (`flipped`). Persisted to
  `tmp/gecko-pool-cache.json`. Without this cache, orientation mismatches
  would produce price ratios that are inverted by orders of magnitude.
- **Block-time cache** — block number → Unix timestamp lookups are cached
  in `tmp/block-time-cache.json` so historical API calls use the correct
  timestamps without re-querying the RPC for every position.
- **Cascading OHLCV fallback** — `_fetchGeckoTerminalOhlcv` requests a day
  candle first; if none exists (e.g. pool inception, low volume), it
  cascades to hour, then minute. Each attempt uses **end-of-UTC-day** as
  the `before_timestamp` so the cascade finds any candle anywhere in the
  block's day.

Historical USD values (token prices, exit/entry amounts) are recorded in
`rebalance_log.json` at rebalance time so subsequent P&L lookups don't need
to re-query historical price APIs for events that have already occurred.

### Rate Limiting

The free GeckoTerminal API allows 30 calls/min. A centralized sliding-window
rate limiter (`geckoRateLimit()` in
[`src/gecko-rate-limit.js`](../src/gecko-rate-limit.js)) is applied to
**every** GeckoTerminal call and is shared between `price-fetcher.js` and
`gecko-pool-cache.js` so all callers (HODL baseline, epoch reconstruction,
position history, pool-orientation bootstraps) draw from a single budget.
If the window is full the caller automatically waits until a slot opens.

### In-Memory Cache

Current-price results are cached with a configurable TTL (default 120 s,
see `priceCacheTtlMs` below), keyed by `{chain}:{tokenAddress}`
(lower-cased). Historical prices have their own disk-backed cache in
`tmp/historical-price-cache.json`, keyed by block number so the cache
survives across restarts and always corresponds to a deterministic
on-chain moment.

---

## Idle-Driven Price-Lookup Pause

To stay under price-source quotas, `fetchTokenPriceUsd` and
`fetchDustUnitPriceUsd` are gated at the public API of
`src/price-fetcher.js` whenever nobody needs them. `fetchHistoricalPriceGecko`
is never gated.

**Pause sources** (each can pause on its own):

- **Server idle** — `POST /api/*` traffic resets the countdown; after 15 min
  of silence the server pauses itself.
- **Browser idle** — `public/dashboard-idle.js` posts pause after 2 min of
  blur or 15 min of no input; activity (focus / click / keydown / touch /
  pointer / scroll) posts unpause via the throttled (500 ms) handler.
- **Move scope** — every auto- and manual-triggered rebalance and compound
  runs inside `withFreshPricesAllowed(...)`, which bypasses both the pause
  flag and cache TTL for the duration and restores prior state on exit
  (success or thrown).
- **Headless `bot.js`** — starts paused by default; opt out with
  `--start-with-price-lookups-unpaused`.

`/api/*` traffic resets the server idle countdown but does NOT auto-unpause;
this prevents the 3-second `/api/status` polling loop from fighting the
browser-issued pause.

**Configuration** (in `app-config/user-configurable/bot-config.json` `global` section):

| Key | Default | Notes |
| --- | --- | --- |
| `priceCacheTtlMs` | `120000` | Current-price in-memory cache TTL (ms). |
| `dustUnitPriceCacheMultiplier` | `30` | Dust-unit-price TTL = `priceCacheTtlMs × multiplier`; runtime asserts integer multiple. |

**Two new endpoints** (idempotent, no body required):

- `POST /api/pause-price-lookups` → `{ paused: true }`
- `POST /api/unpause-price-lookups` → `{ paused: false }`

**Operator quick-check.** Manually pause for diagnostics:

```bash
curl -X POST http://127.0.0.1:5555/api/pause-price-lookups \
     -H "x-csrf-token: $(curl -s :5555/api/csrf-token | jq -r .token)"
```

When paused with an empty cache, `fetchTokenPriceUsd` returns `0` rather
than blocking — downstream consumers (gas-too-high gate, P&L snapshot)
already tolerate that.

---

## Idle-Suppressed Polling Sounds

The dashboard's master **Sounds** toggle (Settings popover) plays a jingle
on every detected rebalance / compound success, driven by the 3-second
status poll. While the user is logged out of the desktop or otherwise
idle, those events still accrue on the server side and surface on the
next poll after activity returns — without a gate, returning to a long-
untouched tab triggers a backlog of jingles in quick succession (observed
during burn-in).

`public/dashboard-sounds.js` `playSound()` reads `isBrowserPaused()` from
`public/dashboard-idle.js` and skips playback while the browser-side
idle flag is `true`. `playSoundAlways()` (About Easter Egg, LP/Ranger
title tune) is intentionally unaffected — those fire on explicit user
clicks, and any click is itself an activity event that flips
`_browserHasPaused` to `false` synchronously before the click handler
runs.

The browser idle flag is independent of the move-scope bypass
(`withFreshPricesAllowed`). That bypass lives entirely server-side in
`src/price-fetcher-gate.js` and never touches the browser, so an auto-
rebalance or compound that runs while the user is away leaves the
browser still paused and the gate suppresses the corresponding sound
until the user returns.

`isBrowserPaused` alone does not catch system-suspend or tab-discard:
when JS execution freezes the 3 s polling stops, the seen-maps stay
stale, and on wake the next poll fires sounds for every event the bot
recorded during sleep. `public/dashboard-idle.js` `_uiLastWokeUpAtMS`
advances inside `_onActivity` when an activity event (`focus` arriving
first) lands after a gap exceeding `PAUSE_AFTER_NO_INPUT_MS` (15 min);
the exported `isStaleForUiPurposes(eventMs)` consulted by
`checkRebalanceSound` and `checkCompoundSound` then filters any event
whose server timestamp predates that wake moment.

---

## Balanced-Band Telegram Notification

Optional Telegram alert that fires when a managed position drifts into
the **±2.5% USD-balanced band** (`token0_value / total ∈ [0.475, 0.525]`).
Useful as a "good time to manually rebalance" signal on positions where
50/50 composition is preferred. Edge-triggered — one notification per
FALSE→TRUE crossing, with a 30-min cooldown so a position oscillating
across the band edge cannot spam the channel.

**Enable it.** Settings → Telegram → check **Position Balanced (±2.5% of
50/50)**. Default OFF. The checkbox shows a warning + the dynamically-
computed price-fetch cadence.

**Cost.** When enabled, the notifier bypasses the
[Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause) so it
can detect band crossings even with the dashboard closed. This consumes
price-source quota continuously — operators using paid APIs (e.g.
Moralis) should ensure their plan tolerates the load.

**Configuration** (in `app-config/user-configurable/bot-config.json` `global` section,
falling back to `bot-config-defaults.json`):

| Key | Default | Notes |
| --- | --- | --- |
| `pricePauseExceptionPollWindowMultiple` | `10` | Multiplier on `CHECK_INTERVAL_SEC`. Effective fetch cadence = `CHECK_INTERVAL_SEC × multiplier` seconds. Default 10 → 50 min at the default 300 s poll. Higher = lighter load, slower band detection. Positive integer ≥ 1. |

The threshold (±2.5%) and cooldown (30 min) are code-only constants in
`src/balanced-notifier.js` (`BALANCED_THRESHOLD`, `BALANCED_COOLDOWN_MS`)
— change in code if needed.

**Notification payload.** Header lines list the blockchain
(`CHAIN.displayName`), the user-friendly NFT-issuer name resolved by
looking up the configured position-manager address in
`app-config/app-defaults-for-user-configurable/nft-providers.json` (e.g. `"9mm v3"`) — the
same single source of truth the dashboard NFT panel reads via
`GET /api/nft-providers`. Then the two token symbols (truncated to 12
chars each, second line indented 4 spaces) and the fee tier. The
`nft-providers` map is keyed by NFT-contract address so future v3+v4
coexistence on the same chain resolves the correct name per position
without restructuring. Range info, ticks, current price and the ratio
split are intentionally omitted — the alert is about the value-balance
state, not the range. Body shows both token holdings with USD values
(using human token names, not T0/T1), total value, plus unclaimed fees
and lifetime P&L when the P&L snapshot is available.

---

## Dust Threshold

Every "is this amount small enough to ignore?" decision in the rebalancer
routes through one utility: [`src/dust.js`](../src/dust.js). Callers never
hardcode a literal USD number — they `await isDust(usdAmount)` (or read
`getDustThresholdUsd()` for the live value). The primary consumer today is
the post-rebalance corrective-swap loop in
[`src/rebalancer-correct.js`](../src/rebalancer-correct.js), which stops
iterating once the remaining imbalance drops below threshold.

### Pegged to a Reference Asset, Not to USD

The threshold is denominated in abstract **units** of an inflation-resistant
reference asset (currently one troy ounce of gold, via PAXG with XAUT as a
fallback), not in USD directly:

```text
thresholdUsd = thresholdUnits × usdPerUnit(referenceAsset)
```

A USD-pegged guard would silently loosen as fiat inflates — a `$1` floor set
today would eventually stop catching real dust as token prices rose with
inflation, causing dust-loop bugs on volatile pools. Pegging to gold keeps
the threshold's *purchasing power* roughly constant instead, without any
manual re-tuning.

Default: `thresholdUnits = 1/4800 ≈ $0.70` at a gold price near $3,400/oz.
The shipped value lives in
[`app-config/app-defaults-for-user-configurable/dust-threshold.json`](../app-config/app-defaults-for-user-configurable/dust-threshold.json)
so operators can tune it without editing code. **To customize:**
copy that file to `app-config/user-configurable/dust-threshold.json`
and edit the copy. The same JSON lists the price-source tokens — to
switch reference assets (silver, a basket, etc.), swap the tokens in
the copy and pick a `thresholdUnits` consistent with the new asset's
price scale. Do NOT edit the file in
`app-defaults-for-user-configurable/` — tarball upgrades overwrite it.

### Live USD/unit Resolution

`fetchDustUnitPriceUsd()` in
[`src/price-fetcher.js`](../src/price-fetcher.js) walks the
`priceSourceTokens` list in order. For each token it tries Moralis first,
then DexScreener. The first non-zero result wins. Results are cached with a
dedicated TTL (`_DUST_UNIT_PRICE_TTL_MS`) so repeated `isDust()` calls
during a single rebalance don't hammer the price APIs.

### Fallbacks (Fail Loud, Fail Safe)

The guard is designed to never silently disable itself:

- If the JSON config is missing or malformed, `dust.js` falls back to
  `_DEFAULT_UNITS = 1/4800` and logs a warning.
- If every price source returns zero, `getDustThresholdUsd()` falls back to
  `_FALLBACK_THRESHOLD_USD = $1.00` — a conservative fixed floor rather
  than an open gate — and flags `usedFallback: true` so callers can log
  the condition.

Both paths prefer a closed door over an open one: even with no config and
no network, `isDust($0.50)` still returns `true`.

---

## Lifetime History Lookback

"Lifetime" P&L figures — total fees earned, every rebalance event, every
compound, cumulative impermanent loss/gain — are computed from the on-chain
history of the wallet's position NFTs. The question of **how far back to
scan** is answered by three layered bounds, resolved in order by
[`src/event-scanner.js`](../src/event-scanner.js):

1. **5-year maximum** (hard upper bound)

   The default `maxYears` parameter is `5`. Block depth is derived from
   PulseChain's 10-second target block time:

   ```text
   _BLOCKS_PER_YEAR = round((365.25 * 24 * 3600) / 10)  =  3,155,760
   baseFrom         = max(0, currentBlock - maxYears * _BLOCKS_PER_YEAR)
   ```

   That's the oldest block the scanner will ever touch. Positions older
   than five years are ignored — if you need a longer window, pass a
   larger `maxYears` to `scanRebalanceHistory()`.

2. **Pool-creation block** (tightens the window for young pools)

   Most pools are nowhere near five years old, so querying every chunk
   back to `baseFrom` would waste thousands of RPC calls on empty ranges.
   Before the chunk loop starts, `resolveFromBlock()` asks the V3 Factory
   for its `PoolCreated(token0, token1, fee)` event; when found, the
   block number of that event becomes the effective `fromBlock`:

   ```text
   effectiveFrom = max(baseFrom, poolCreationBlock)
   ```

   For a pool created six months ago, this collapses a 15.8 M-block scan
   down to ~1.6 M blocks — roughly a 10× speedup on a fresh install.
   `findPoolCreationBlock()` binary-searches the factory event log, so
   the lookup itself is cheap.

3. **Disk cache** (subsequent runs resume from the last scanned block)

   Results from a completed scan are persisted to
   `tmp/event-cache-{blockchain}-{contract}-{wallet}-{token0}-{token1}-{fee}.json`
   via `cache-store.js`. On the next run `loadCache()` reads the cached
   events and sets `scanFrom = lastScannedBlock + 1`, so only blocks
   produced since the previous scan are queried. A 5-year first-time
   scan issues ~1,580 chunked queries (10 k blocks per chunk with a
   250 ms rate-limit delay between them); a warm-cache rescan on the
   same wallet issues a handful.

   The cache is invalidated on every successful rebalance
   (`clearPoolCache()` in `bot-loop.js`) so the next scanner run picks
   up the newly-minted NFT's mint event.

In short: **we start as far back as 5 years ago, but never before the
pool itself was created, and never before the last cached scan.** The
three bounds compose, so the actual `fromBlock` on any given call is
`max(now - 5y, poolCreationBlock, lastCachedBlock + 1)`.

See also:

- [`src/event-scanner.js`](../src/event-scanner.js) — scanner entry point
  and cache integration
- [`src/pool-scanner.js`](../src/pool-scanner.js) — per-pool locking and
  scan orchestration
- [`src/epoch-reconstructor.js`](../src/epoch-reconstructor.js) — turns
  rebalance events into P&L epochs
- [`src/cache-store.js`](../src/cache-store.js) — disk cache with TTL

---

## Client-Side URL Routing

The dashboard uses Navigo (pushState-based router, ~5 KB) for bookmarkable,
shareable URLs that reflect the active wallet and position.

### URL Structure

- `/` — Root (no state)
- `/pulsechain/:wallet` — Wallet loaded, no position selected
- `/pulsechain/:wallet/:contract/:tokenId` — Specific NFT position deep-link

Example: `/pulsechain/0xabc123.../0xCC05bf.../157149`

### SPA Catch-All

The server serves `index.html` for any extensionless GET path that doesn't
match a known API route or static file. Paths with file extensions (e.g.
`.js`, `.css`, `.woff2`) that don't match a real file return 404. This
allows Navigo to handle routing on the client side after page load.

### Deep-Link Resolution Flow

1. Navigo parses wallet, contract, tokenId from the URL path.
2. If the wallet matches the loaded wallet → search posStore for the tokenId
   → activate if found.
3. If the wallet is not yet loaded → store as a pending route target,
   resolved after wallet import or server restore.
4. If the position is not in the store → trigger `scanPositions()` and retry
   lookup (up to 3 retries at 2-second intervals).

### URL Updates

When the user selects a position or imports/clears a wallet, the URL bar is
updated via `router.navigate()` with `callHandler: false` (no page reload,
no re-triggering of route handlers). Addresses are lowercased in URLs.

Source: [`public/dashboard-router.js`](../public/dashboard-router.js)

---

## Development Tools

All dev tools are available via npm scripts — no `npx` needed.

### Build and Run

- `npm run build` — esbuild bundle + cache-bust stamp (`bundle.js?v=<ms>`)
- `npm start` — Start server only (no build — use after `npm run build`)
- `npm run build-and-start` — Build + start in one command
- `npm run dev` — Build + start with `--watch` (auto-restart on file changes)

### Lint and Test

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

**Step 2 — run the commands:**

- `npm run lint` — ESLint — 0 warnings, complexity ≤17, max-lines ≤500
- `npm run lint:fix` — ESLint auto-fix
- `npm test` — Node.js built-in test runner (`node:test`)
- `npm run test:coverage` — Test coverage report (Node 20+,
  `--experimental-test-coverage`)
- `npm run test:watch` — Re-run tests on file changes
- `npm run test:util` — Tests for the diagnostic tools in
  `util/diagnostic/test/`. Out of CI and pre-commit; see
  [Diagnostic Utilities](#diagnostic-utilities).
- `npm run check` — Combined lint + test + 80% coverage gate + security
  audits (matches CI)
- `npm run show-dependency-cycles` — Optional diagnostic. Runs
  [`madge`](https://github.com/pahen/madge) `--circular` across every
  `.js` file in the project (`src/`, `bot.js`, `server.js`, `scripts/`,
  `eslint-rules/`, `test/`, `public/`) and lists any circular module
  imports. Not wired into `npm run check` — surface only when you want
  it. Why a CLI tool instead of an ESLint rule: the server-side code
  is CommonJS (`require`/`module.exports`) because Node loads it
  directly with no `"type": "module"` in `package.json`; the dashboard
  code under `public/dashboard-*.js` is ESM (`import`/`export`)
  because esbuild bundles it into `public/dist/bundle.js` for the
  browser. The standard ESLint cycle rules (`import/no-cycle`,
  `import-x/no-cycle`) only reliably detect ESM cycles — they cannot
  trace `require()` calls because `require` is a runtime function call,
  not a static import. `madge` traverses both `import` and `require`
  by walking the actual dependency graph, so it catches cycles in
  both halves of the codebase. Dashboard `public/` ESM cycles are
  also reported; cleaning those up is a separate nice-to-have task.

### Wallet Management

- `npm run reset-wallet` — Delete `app-config/user-configurable/wallet.json` + clear
  `WALLET_PASSWORD` from `.env`. Forces a fresh wallet import via the
  dashboard on next start.
- `npm run clean` — `reset-wallet` + delete every runtime file under
  `app-config/user-configurable/` (`bot-config.json`,
  `bot-config.backup.json`, `api-keys.json`) and `app-data/`
  (`rebalance_log.json`) plus all `tmp/` caches and the entire
  `test/report-artifacts/` directory. Full state reset.
  **Note:** browser localStorage is NOT cleared by this command — use the
  Settings gear icon → "Clear Local Storage & Cookies" in the dashboard,
  or open DevTools → Application → Local Storage → Clear All.
- `npm run dev-clean` — Same as `clean` but preserves the historical price
  cache (`tmp/historical-price-cache.json`), the block-time cache
  (`tmp/block-time-cache.json`), and the gecko-pool orientation cache
  (`tmp/gecko-pool-cache.json`) for faster restart during development.
  Avoids re-fetching GeckoTerminal data.

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

### Utilities

`util/` holds non-standard, ad-hoc Node.js tools, organized by purpose.
Sibling to `scripts/` (standard ops like `clean` and `nuke`). Every
subdirectory ships with the project, is linted by `npm run lint`, and
is intentionally **out of CI and pre-commit** so the surface can evolve
without dragging release gates.

#### Diagnostic Utilities

`util/diagnostic/` holds read-only Node.js tools for investigating
on-chain state and bot data. End users run these when something looks
wrong. All four tools take CLI args, never mutate state, and write only
to stdout (redirect to `tmp/` for logs).

- `inspect-pool.js` — Pretty-prints `app-config/user-configurable/bot-config.json` and
  `tmp/pnl-epochs-cache.json` for a position or pool fragment: status,
  hodlBaseline, residuals, lifetimeHodlAmounts, fresh deposits.
- `show-rebalance-chain.js` — Walks position-manager `Transfer` events
  for a wallet over N years, listing every NFT mint/burn/move.
- `reconcile-hodl.js` — Sums on-chain `IncreaseLiquidity` /
  `DecreaseLiquidity` / `Collect` across an NFT chain and compares to
  the cached HODL baseline.
- `wallet-token-flow.js` — Lists ERC-20 `Transfer` events for one or
  more tokens within a UTC date window, with net-flow summary.

Audited under `npm run audit:security` and `npm run audit:secrets` —
same bar as `src/`. Tests live in `util/diagnostic/test/` and run via
`npm run test:util`. Pure helpers shared across tools live in
`util/diagnostic/_helpers.js`; each tool's CLI `main()` is gated behind
`require.main === module` so requiring it from a test does not start
an RPC scan.

##### Scenario-Reproduction Scripts

Companion shell scripts (also under `util/diagnostic/`) that
**deliberately mutate local state** so a previously-observed bug can
be triggered on demand. Distinct from the read-only Node tools above:
each script backs the original up to a timestamped sibling first and
prints the exact restore command.

- `inject-stuck-lifetime-state.sh` — Mutates every pool entry in
  `tmp/pnl-epochs-cache.json` to match Prod's 2026-06-09 stuck shape:
  `freshDeposits: null`, `lifetimeHodlAmounts: null`,
  `lastNftScanBlock: 0`. Then `npm start` triggers the same lifetime-
  scan recovery path the fix in `src/bot-recorder-lifetime.js` and
  `src/bot-loop.js` exercises (see
  [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause)
  for the surrounding price-lookup gating). Used to verify the
  `lifetimeScanComplete` flag + Syncing-badge UX behave correctly
  when the cache is in the stuck shape; otherwise the bug only
  reproduces on the live Prod box.

#### Cache Utilities

`util/cache/` holds small Node.js scripts that operate on the
pool-address-keyed disk caches under `tmp/`.

- `clean-pool-cache.js` — Wipe every cached entry for one pool. Default
  behaviour is **scorched-earth**: removes pool-creation-blocks,
  gecko-pool, every matching event-cache file (one per wallet that has
  positions in the pool), matching P&L-epoch entries, matching
  `liquidity-pair-details-cache.json` scope keys (the post-first-mint
  initial-residual snapshots), and surgically filters every wallet's
  `lp-position-cache-*.json` so only entries matching this pool's
  (token0, token1, fee) are removed (other pools' entries in the same
  file are preserved; if the file's `positions[]` becomes empty after
  filtering, the file itself is deleted). Token0, token1, and fee are
  resolved via RPC (`pool.token0/1/fee()`). Caches that aren't
  pool-scoped (historical-price by token+block, nft-mint-date by
  tokenId, block-time by chain+block) are untouched.

  **`--chain` and `--nft-factory` are required** so the 5-dimensional
  pool scope (blockchain + nft-factory + token0 + token1 + fee) is
  matched exactly across every surface; wallet is the only intentionally
  wildcarded dimension. Find both in the in-app **Pool Details** dialog:
  blockchain is the subtitle beneath the title; nft-factory is the
  "NFT Contract" row. `--chain` accepts either the abbreviated key
  (e.g. `pulsechain`) or the full display name (e.g. `PulseChain`),
  case-insensitive. The set of valid chains comes from
  `app-config/app-defaults-for-user-configurable/chains.json`.

  Pass `--preserve-pool-history` to skip event-cache, P&L-epochs,
  liquidity-pair-details, and lp-position-cache surfaces — the lookup
  caches alone are cleared, no RPC needed. Use this when you want to verify a cold
  pool-creation-block resolver lookup without forcing a full event
  re-scan or losing accumulated P&L history. `--chain` and
  `--nft-factory` are still required in this mode for consistency.

  Run with `--help` for the full reference (every option, every
  combination, exit codes).

  Examples:

  ```bash
  # Full wipe (default — every pool-scoped surface, requires RPC):
  node util/cache/clean-pool-cache.js \
       0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 \
       --chain pulsechain \
       --nft-factory 0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2

  # Lookup caches only (no RPC; preserves event cache + P&L epochs):
  node util/cache/clean-pool-cache.js \
       0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 \
       --chain pulsechain \
       --nft-factory 0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2 \
       --preserve-pool-history

  # Full reference:
  node util/cache/clean-pool-cache.js --help
  ```

---

## The app-config Directory

**Read this before adding new config files.**

Every file the app reads or writes for its own configuration and runtime
state lives in ONE dedicated directory at the project root:

```text
lp-ranger/
├── app-config/
│   ├── app-defaults-for-user-configurable/  ← tracked, shipped defaults
│   │   ├── README.md         ← do-not-edit warning + override instructions
│   │   ├── chains.json       ← per-blockchain tunables (RPC, contracts, gas)
│   │   ├── bot-config-defaults.json  ← Bot Settings defaults + nested groups
│   │   ├── csrf.json         ← CSRF token TTL + refresh cadence
│   │   ├── dust-threshold.json  ← universal dust threshold (gold-pegged)
│   │   ├── evm-rpc-response-codes.json  ← RPC error-classifier substrings
│   │   ├── logging.json      ← log-to-file always-on toggle + path
│   │   ├── nft-providers.json  ← short labels for NFT issuer contracts
│   │   ├── ui-defaults.json  ← dashboard first-visit defaults
│   │   └── api-keys.example.json ← tracked format template (documentation)
│   └── user-configurable/    ← dir tracked (via README.md), CONTENTS gitignored
│       ├── README.md         ← survives tarball upgrade — operators drop
│       │                        same-named override files here; the runtime
│       │                        deep-merges them on top of the shipped
│       │                        defaults above (user wins)
│       ├── bot-config.json   ← runtime (gitignored) — managed positions
│       ├── bot-config.backup.json  ← runtime (gitignored) — auto snapshot (config-stomp safety net)
│       ├── wallet.json       ← runtime (gitignored) — encrypted wallet
│       └── api-keys.json     ← runtime (gitignored) — encrypted API keys
│                                (Moralis, Telegram bot token + chat ID)
└── app-data/                 ← per-install runtime data
    ├── README.md             ← tracked
    └── rebalance_log.json    ← runtime (gitignored) — historical P&L events
```

Pure performance caches (historical prices, block times, OHLCV pool
orientation, event scanner results, LP position enumeration) DO NOT belong
here — they live in `tmp/` and are rebuilt on demand from the blockchain or
APIs. Deleting any cache file in `tmp/` is always safe; the app will
regenerate it.

### File Inventory

- **`app-defaults-for-user-configurable/chains.json`** — Tracked
  shipped default. Per-blockchain config: RPC endpoints, contract
  addresses (PositionManager, Factory, SwapRouter), gas multipliers,
  aggregator cancel timeout, wait window, retry count. Read once at
  module load by `src/config.js` via the layered defaults+user-
  override loader. **To customize:** copy this file to
  `app-config/user-configurable/chains.json` and edit the copy
  (deep-merge — you only need to ship the keys you want to override).
  Do NOT edit the file in `app-defaults-for-user-configurable/` —
  tarball upgrades overwrite it.
- **`app-defaults-for-user-configurable/bot-config-defaults.json`** — Tracked. Default values
  for every user-editable Bot Settings input plus two server-internal nested
  groups (`lowGasThresholds`, `residualCleanup`). See
  [Bot Config Defaults](#bot-config-defaults) for the full key inventory.
- **`app-defaults-for-user-configurable/dust-threshold.json`** —
  Tracked shipped default. Universal dust threshold (in abstract
  units of an inflation-resistant reference asset) plus the list of
  tokens used to fetch the live USD/unit price. Read once at module
  load by `src/dust.js` via the layered defaults+user-override
  loader. See [Dust Threshold](#dust-threshold) for the strategy and
  rationale. **To customize** (tune the threshold or switch reference
  assets): copy this file to
  `app-config/user-configurable/dust-threshold.json` and edit the
  copy. Do NOT edit the file in `app-defaults-for-user-configurable/`
  — tarball upgrades overwrite it.
- **`app-defaults-for-user-configurable/api-keys.example.json`** —
  Tracked. Format template showing the structure of the encrypted
  `api-keys.json`. NOT a tunable, NOT a runtime file — pure
  documentation. Lives in the shipped-defaults directory because it
  ships with the app and documents the runtime sibling under
  `user-configurable/`.
- **`user-configurable/bot-config.json`** — Runtime, gitignored.
  Managed position lifecycle (`status: running/stopped`), per-position
  settings (HODL baseline, residuals, thresholds, slippage,
  auto-compound config, compound history, initial deposit overrides),
  global bot settings. Read/written by `src/bot-config-v2.js` via
  `loadConfig()` / `saveConfig()`. Atomic write (tmp + rename); every
  write is logged with the caller's stack for config-stomp debugging.
- **`user-configurable/bot-config.backup.json`** — Runtime, gitignored.
  Automatic snapshot created by bot-config-v2 on every successful load.
  Safety net for the ongoing config-stomp investigation — if
  `bot-config.json` is ever accidentally truncated, copy this file back
  over it:

  ```sh
  cp app-config/user-configurable/bot-config.backup.json app-config/user-configurable/bot-config.json
  ```

  The save guard also logs `[config] REFUSING` when it detects that
  running positions would vanish; if you see that warning, use the
  backup.
- **`user-configurable/wallet.json`** — Runtime, gitignored. Encrypted
  wallet state (AES-256-GCM with PBKDF2-SHA512 key derivation from the
  user's password). Holds address, source (generated/seed/key),
  encrypted private key and mnemonic. Plaintext secrets are NEVER
  written to disk. Read/written by `src/wallet-manager.js`. Tests
  override the path via the `WALLET_FILE_PATH` environment variable.
- **`user-configurable/api-keys.json`** — Runtime, gitignored.
  Encrypted storage for third-party API keys (Moralis, Telegram bot
  token + chat ID), using the same wallet password and encryption
  scheme as `wallet.json`. Read/written by `src/api-key-store.js`.
  Tests override the path via the `API_KEYS_FILE_PATH` environment
  variable.
- **`app-data/rebalance_log.json`** — Runtime, gitignored. JSON array
  of every rebalance event ever: timestamps, fees collected, gas cost,
  exit/entry USD values, token balances. Appended to by
  `src/bot-recorder.js`. Read by `src/position-history.js` for
  closed-position P&L display. Configurable via the `LOG_FILE`
  environment variable. Lives outside `app-config/` because it's
  per-install runtime DATA, not config.

### Rules for Where Future Config Files Should Live

1. **Shipped default for an operator-tunable value** (tracked, never
   rewritten by the app at runtime) →
   `app-config/app-defaults-for-user-configurable/<name>.json`.  Read
   via `src/load-merged-defaults.js#loadMergedDefaults("<name>.json")`
   so per-install operator overrides at
   `app-config/user-configurable/<same-name>.json` are automatically
   layered on top (deep-merged; operator values win).  This is the
   ONLY way for new operator-tunable values to ship — direct edits to
   the file in `app-defaults-for-user-configurable/` are clobbered on
   every tarball upgrade.
2. **Runtime state** (written by the app, not meant for the user to
   hand-edit) → `app-config/<name>.json` (covered by the
   `app-config/*` gitignore glob).
3. **Mixed static + dynamic** (the app also overwrites during normal
   operation) → `app-config/<name>.json` (NOT
   `app-defaults-for-user-configurable/`).  The shipped-defaults dir
   is reserved for files that are read-only at runtime — if the app
   can rewrite the file, it doesn't belong there.
4. **Format template** documenting a runtime file →
   `app-config/<name>.example.json` (tracked; add an explicit
   un-ignore rule to `.gitignore`).  Pre-dates the user-configurable
   pattern; new tunables should use rule 1 instead.
5. **Pure performance cache** (can be deleted with no loss of data;
   rebuilt on demand from the blockchain or an API) →
   `tmp/<name>.json`.  DO NOT put caches in `app-config/`.

### One-Time Migration from the Legacy Layout

Existing installations prior to this refactor kept runtime files at the
project root (`.bot-config.json`, `.wallet.json`, `api-keys.json`, etc.).
On every startup, `src/migrate-app-config.js` runs `migrateAppConfig()`
which moves any surviving legacy root file into `app-config/`. The
migration is fully idempotent:

- **Fresh install** → creates `app-config/`, moves nothing.
- **Upgrade** → `fs.renameSync` each legacy file into place, logs each move.
- **Conflict** (both root AND `app-config/` exist) → refuses, logs a
  warning, leaves both files untouched so the operator can resolve manually.
- **After a successful migration** → subsequent restarts are completely
  silent (source files no longer exist at root).

`fs.renameSync` is atomic within a single filesystem, so there is no window
where a file could be lost to an interrupted move.

### Test-Time Protection in scripts/check.js

`scripts/check.js` (which `npm run check` invokes) backs up every file
under the two operator-state directories — `app-config/user-configurable/`
and `app-data/` — before running tests, wipes them (preserving each
dir's tracked `README.md`), runs the full test suite, then restores the
originals via an `EXIT` trap. This prevents test-created fixtures from
ever clobbering live user state. The shipped-defaults directory
(`app-config/app-defaults-for-user-configurable/`, which holds the
tracked `api-keys.example.json` format template alongside the tunable
JSON defaults) is not touched at all — it's tracked repo content.

Tests that need to write config without touching the live files either
pass an explicit `dir` argument to `loadConfig(dir)` / `saveConfig(cfg, dir)`
(`bot-config-v2`), or set the `WALLET_FILE_PATH` / `API_KEYS_FILE_PATH`
environment variables to a temp path before require-ing the module.

---

## Bot Config Defaults

[`app-config/app-defaults-for-user-configurable/bot-config-defaults.json`](../app-config/app-defaults-for-user-configurable/bot-config-defaults.json)
holds the default values for every Bot Settings input the dashboard
exposes, plus two server-internal nested groups. The dashboard fetches
it at init via `GET /api/bot-config-defaults`; the server falls back to
it when `getConfig` is asked for a value the user has not overridden.
Per-user overrides live in `app-config/user-configurable/bot-config.json`.

**User-editable (top-level keys, exposed in the Bot Settings panel):**

| Key | Default | Description |
| --- | --- | --- |
| `approvalMultiple` | `20` | ERC-20 approval multiplier for swap allowances |
| `rebalanceOutOfRangeThresholdPercent` | `5` | % move past the position boundary before a rebalance triggers |
| `rebalanceTimeoutMin` | `180` | Minutes continuously OOR before forcing a rebalance (`0` = disabled) |
| `slippagePct` | `0.5` | Per-swap slippage tolerance applied to the quoted output |
| `checkIntervalSec` | `300` | On-chain poll cadence |
| `minRebalanceIntervalMin` | `10` | Minimum gap between back-to-back rebalances on the same pool |
| `maxRebalancesPerDay` | `20` | Wallet-level daily rebalance cap (UTC reset) |
| `offsetToken0Pct` | `50` | Position offset bias toward token0 (50 = balanced) |

**`lowGasThresholds`** — drives the Mission Control "Gas Running Low" /
"Gas Critical" badge in [`src/gas-monitor.js`](../src/gas-monitor.js).
Not exposed in the UI.

| Key | Default | Description |
| --- | --- | --- |
| `worstCaseGasFactor` | `91` | Worst-case rebalance gas in units of a 21k native send |
| `safetyMultiplier` | `3` | Headroom factor over the worst case |
| `standardSendGas` | `21000` | EVM constant for a no-calldata native transfer |

**`residualCleanup`** — drives the post-rebalance residual-sweep loop in
[`src/bot-cycle-residual.js`](../src/bot-cycle-residual.js). Not exposed
in the UI.

| Key | Default | Description |
| --- | --- | --- |
| `delayMs` | `600000` | Wait (ms) after a rebalance before checking residual share |
| `thresholdPct` | `5` | Residual share of the pool batch (%) that triggers a sweep |

---

## Security

### What's at Stake

LP Ranger manages your cryptocurrency. It holds the private key to
your wallet and uses it to sign transactions on the blockchain —
removing liquidity, swapping tokens, minting new positions. If an
attacker gains access to that key, or tricks LP Ranger into signing
a bad transaction, your funds can be stolen permanently. Blockchain
transactions cannot be reversed: there is no bank to call, no
chargeback to file, no undo button.

The entire purpose of this security architecture is to make that
outcome as difficult as possible, from **multiple independent
angles**, so that no single failure — a leaked password, a forged
web request, a compromised npm package — can reach your funds.

**Example — how defense in depth works in practice:** Suppose a
malicious website tries to send a command to your LP Ranger server to
rebalance your position with extreme slippage settings. To succeed,
the attacker would have to bypass **all** of these layers:

1. **Network binding** — the server only accepts connections from
   your own machine (`127.0.0.1`). The attacker can't reach it from
   the internet.
2. **CORS (Cross-Origin Resource Sharing) guard** — even from the
   local machine, the server rejects requests that didn't originate
   from the LP Ranger dashboard itself.
3. **CSRF (Cross-Site Request Forgery) token** — even if the origin
   check passed, the request must carry a one-time cryptographic
   token that only the dashboard knows. Without it, the server
   returns 403 Forbidden.
4. **Config key `allowlist`** — even if the attacker had a valid
   token, the server only accepts recognized setting names
   (like `slippagePct` or `oorThreshold`). Unknown fields are
   silently dropped.

Each layer assumes the previous one might fail. That's what
**defense in depth** means — and it's the organizing principle for
everything in this section.

All cryptography uses Node's built-in `crypto` module and vetted
open-source packages (`csrf`, `ethers`, `async-mutex`,
`@uniswap/v3-sdk`, `jsbi`). Nothing is rolled in-house.

### Summary of Primary Controls

The following is a summary of the primary controls currently in
effect:

- **Your private key is encrypted on disk** — it's never saved in
  readable form. Only your password can unlock it, and the unlocked
  key exists only briefly in the computer's memory during
  transaction signing, then it's gone. (Encryption: AES-256-GCM
  (Advanced Encryption Standard, 256-bit key, Galois/Counter Mode)
  with PBKDF2 (Password-Based Key Derivation Function 2) SHA-512
  key derivation.)
- **The server only talks to localhost** — LP Ranger binds to
  `127.0.0.1` by default. No one on the internet or your local
  network can connect unless you explicitly override this.
- **Every command requires a one-time token** — CSRF tokens prevent
  a malicious website from tricking your browser into sending
  commands to LP Ranger on the attacker's behalf.
- **Swap transactions travel over encrypted connections** — to the
  9mm DEX Aggregator API (primary path) or directly to the RPC
  endpoint (fallback). Your swap intent is never exposed to the
  public network before the transaction is submitted to the
  blockchain.
- **Only one transaction at a time** — an async-mutex rebalance
  lock serializes all transaction signing across all managed
  positions. This prevents nonce collisions (which could cause
  stuck or lost transactions when multiple positions try to send
  at the same moment).
- **Sensitive files are excluded from version control** — wallet
  state, configuration, and API keys are all gitignored so they
  can't accidentally be committed to a public repository.
- **Every code change is scanned before it can ship** — static
  analysis, secret detection, and dependency vulnerability auditing
  run on every commit (`npm run check` locally, mirrored in CI).

Code cannot be included in the `main` branch unless it passes the
rigorous security checks detailed below. And in turn, Releases cannot
be made except from code in the `main` branch.

The subsections that follow document the implementation details and
lint/test enforcement behind each of these controls.

### Network

The first line of defense is the simplest: LP Ranger's server only
listens on your own machine's internal network address. An attacker on
the internet — or even on your local Wi-Fi — simply cannot connect.
The operating system refuses the connection before LP Ranger's code is
even involved.

#### Host Binding (Domain)

`HOST` defaults to `127.0.0.1` so the kernel itself refuses connections
from outside the loopback interface. Overriding to `0.0.0.0` is
documented as a conscious LAN-exposure choice rather than the default.
The headless `bot.js` opens no inbound port at all. The Scalar API-docs
server in `scripts/api-doc.js` is likewise locked to `127.0.0.1`. Because
no application traffic crosses the public Internet in the default
deployment, eavesdropping, MITM (man-in-the-middle), and on-path
replay attacks on the dashboard's HTTP surface are structurally
impossible — TLS (Transport Layer Security) termination
becomes a concern only if a reverse proxy is introduced by the operator.

The CORS origin guard in [`src/server-cors.js`](../src/server-cors.js)
dynamically tracks whatever `PORT` is configured so the `allowlisted`
origin string always matches the actual listener. The `_isLocalhostOrigin`
helper accepts `localhost`, `127.0.0.1`, and `[::1]` (IPv4 + IPv6
loopback) but rejects every other hostname or port.

#### Reverse Proxy Configuration Warning

LP Ranger is designed to run on localhost (`127.0.0.1`) and serves
traffic exclusively over the loopback interface by default. In this
configuration, TLS is not required because all traffic is internal to
the local machine and cannot be intercepted by external parties.

If you configure a reverse proxy to make LP Ranger accessible over a
network — for example to access the dashboard remotely — you assume
full responsibility for ensuring that TLS is properly configured for
the entire request path, including the leg between the reverse proxy
and the LP Ranger server. Failure to do so will expose sensitive
application traffic including wallet commands and session tokens to
interception. The Creator provides no support for reverse proxy
configurations and strongly recommends against exposing LP Ranger to
any network outside the local machine.

#### Protocol Choice

All outbound calls to third-party services — RPC endpoints, 9mm
aggregator, DexScreener, GeckoTerminal, Moralis — use `https://` URLs by
policy; the default `RPC_URL` (`rpc-pulsechain.g4mm4.io`) and fallback
(`rpc.pulsechain.com`) both enforce TLS at the network layer. Inbound
dashboard traffic uses plain HTTP because it never leaves the loopback
interface; adding TLS to a localhost-only listener buys nothing and
complicates setup.

#### Rate Limiting

The GeckoTerminal API caps free-tier callers at 30 calls/min.
[`src/gecko-rate-limit.js`](../src/gecko-rate-limit.js) enforces a
shared sliding-window limiter across every caller (price fetches, HODL
baseline, epoch reconstruction, pool-orientation bootstraps) so a single
misbehaving code path cannot burn the budget and trigger a 429 cascade.
There is no inbound rate limit on the dashboard's own HTTP endpoints —
the localhost-only binding makes one unnecessary.

### Message Security

Even if an attacker could somehow reach the server — for example,
through a browser on the same machine running a malicious page — every
command sent to LP Ranger must pass through multiple checks before
it's acted on. These checks protect against the most common class of
web-application attacks: tricks that abuse the browser's trust
relationship with the server.

#### CORS Origin Guard

[`src/server-cors.js`](../src/server-cors.js) sets
`Access-Control-Allow-Origin: http://localhost:<PORT>` on every
response and rejects any mutating (`POST`, `DELETE`) request whose
`Origin` header resolves to a non-localhost host with a 403. Programmatic
callers (curl, `scripts/stop.js`) send no `Origin` header and pass
through. Preflight `OPTIONS` requests are answered with `204` and the
same allowed-methods/headers list. `test/server-cors.test.js` covers the
accept-localhost and reject-foreign-origin paths.

#### CSRF Tokens

[`src/server-csrf.js`](../src/server-csrf.js) uses the `csrf` package
(pillarjs) to issue cryptographically random tokens bound to a
server-generated secret. Every mutating request must carry a valid,
non-expired token in an `x-csrf-token` header. Tokens are pruned from
an in-memory issued-set when the set exceeds 500 entries.

**Lifetime and refresh cadence are tunables.**
[`app-config/app-defaults-for-user-configurable/csrf.json`](../app-config/app-defaults-for-user-configurable/csrf.json)
defines two values:

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `tokenTtlMs` | `3600000` (60 min) | Server-side token lifetime. After this, `verifyToken()` returns `Expired CSRF token` and the server responds `403`. |
| `refreshIntervalMs` | `3000000` (50 min) | Delivered to the dashboard in every `GET /api/csrf-token` response. Must be strictly less than `tokenTtlMs`; keep ≥ 10 min margin to survive clock skew and a slow fetch. |

**Dashboard refresh mechanism.** On init the dashboard calls
`refreshCsrfToken()` once (in `public/dashboard-init.js`), then
schedules `setInterval(refreshCsrfToken, csrfRefreshIntervalMs())` using
the server-delivered interval. This timer is independent of the
`/api/status` poll loop and fires regardless of poll health — which is
the whole point. On a long-running host (e.g. Raspberry Pi 5 with Heat Sink and Fan (5GB RAM, and Ethernet cable Internet connection instead of Wi-Fi) during a
multi-hour phase-2 event scan) the status poll's in-flight guard can
skip ticks for extended windows; if the CSRF refresh were tied to that
path, tokens would silently expire and auto-fired background POSTs
(silent pool-history rescans triggered by rebalance-event detection,
unmanaged-position lifetime fetches, etc.) would 403 with no user
action involved. The dedicated timer makes expiry impossible in
practice without a several-minute network outage.

To change either value, edit `csrf.json` and restart the server.
`readCsrfTunable()` is called on every `createToken()` and `verifyToken()`
so the values are always current on the server side; the client picks
up the new `refreshIntervalMs` on its next scheduled refresh.

**Silent retry on aged-out tokens.** Even with the dedicated refresh
timer, Chrome can throttle a hidden tab's `setInterval` hard enough that
the held token ages past TTL before the next scheduled refresh fires.
`fetchWithCsrf` in `public/dashboard-helpers.js` covers that case: when
a `403` body identifies the token as either `"Expired CSRF token"` or
`"Unknown CSRF token"`, the wrapper refreshes the token and retries the
original request once.

The two reasons share a root cause:

| Server reason | Meaning |
| --- | --- |
| `Expired CSRF token` | Token still in `_issued`, but past `tokenTtlMs`. |
| `Unknown CSRF token` | Token cryptographically valid (issued by this server) but no longer in `_issued` — i.e. expired *and* already pruned by `_pruneExpired` (which runs only when `_issued.size >= 500` and only deletes tokens already past TTL). |

Treating both as retryable closes the gap that previously dropped the
"Unknown" path silently — observed in burn-in logs as
`[csrf] 403 POST /api/positions/scan — Unknown CSRF token` with no
matching recovery line.

**Retry observability.** Server-side, `handleCsrf` keeps a small ring
buffer of the most recent 403 per `(method, url)` (windowed at 30 s).
When the next successful verify lands on a `(method, url)` in that
buffer, it logs `[csrf] retry succeeded for <METHOD> <url>` —
mirroring the existing
`[csrf] 403 <METHOD> <url> — <reason>` warning so the operator can
confirm from the log that the silent recovery worked. The buffer entry
is cleared on match; a second valid verify is silent.

**Lint enforcement:** The custom ESLint rule
[`9mm/no-fetch-without-csrf`](../eslint-rules/no-fetch-without-csrf.js)
flags any `fetch()` call with a mutating HTTP method (POST, DELETE,
PUT, PATCH) whose `headers` object doesn't contain a
`...csrfHeaders()` spread or an equivalent direct `csrfHeaders()`
assignment. This prevents a developer from adding a new mutating
endpoint that forgets to attach the token — the lint fails the PR before
the code can ship. `eslint-plugin-security`'s
`detect-no-csrf-before-method-override` additionally warns if Express-style
method overriding is ever introduced.

#### HTTP Method Allowlist

`server.js` dispatches only `GET`, `POST`, `DELETE`, and `OPTIONS`.
Any other verb (`PUT`, `PATCH`, `TRACE`, etc.) returns a `405 Method
Not Allowed`, so footgun methods cannot be abused to pivot around the
CORS/CSRF checks.

#### Path Traversal in Static Serving

`serveStatic()` in `server.js` resolves every request path against
`path.resolve(__dirname, 'public', relative)` and returns `403 Forbidden`
when the result does not start with the `public/` directory, blocking
the classic `../../etc/passwd` escape. All three loopback origins
(`localhost`, `127.0.0.1`, `[::1]`) go through the same guard.

### Authentication & Key Management

#### Encryption at Rest

**What the user sees:** After a server restart, the operator
provides their wallet password through one of three methods
(in order of security recommendation):

1. **Dashboard unlock dialog** (default) — open LP Ranger in a
   browser, type the password, click "Unlock."
2. **`--headless` terminal prompt** — run
   `node server.js --headless` and type the password at the
   terminal. Same security as the dashboard (password in memory
   only), no browser needed.
3. **`WALLET_PASSWORD` in `.env`** — fully unattended, for systemd /
   Docker / CI. The password lives on disk as plaintext — least
   recommended (see *Unattended-startup trade-off* below).

Whichever method is used, the same thing happens: the server
decrypts the operator's **private signing key** (stored encrypted
in `app-config/user-configurable/wallet.json` on the server — not in the browser)
and decrypts every **third-party API key** previously saved
(Moralis, Telegram, etc., in `app-config/user-configurable/api-keys.json`). One
password, entered once, brings every secret online for the session.
The password is held only in server memory and discarded when the
process exits.

**How it works:** The encryption is handled by
[`src/wallet-manager.js`](../src/wallet-manager.js) (wallet) and
[`src/api-key-store.js`](../src/api-key-store.js) (third-party API
keys), both backed by the cryptographic primitives in
[`src/key-store.js`](../src/key-store.js). All use the same scheme:

1. **Your password is not stored inside the encrypted files.** The
   encrypted `wallet.json` and `api-keys.json` files contain
   ciphertext, salts, and IVs — but not the password itself.
   Instead, your password is run through a slow, deliberate process
   called **key derivation** — specifically, PBKDF2 (Password-Based
   Key Derivation Function 2) with SHA-512, repeated **600 000
   times** — to produce the encryption key. The slowness is
   intentional: it makes brute-force password guessing impractical
   (this follows OWASP (Open Web Application Security Project) 2023
   guidance). In the default interactive flow, the password exists
   only in the server's memory for the duration of the session and
   is discarded when the process exits. (Operators who need
   unattended startup can optionally store the password in `.env` —
   see *Unattended-startup trade-off* below for the security
   implications of that choice.)
2. **The derived key encrypts your data** using **AES-256-GCM**
   (Advanced Encryption Standard, 256-bit key, Galois/Counter Mode).
   AES-256 is the same encryption standard used by governments and
   banks. The "GCM" part adds tamper detection automatically — if
   anyone modifies the encrypted file (even a single byte), the
   decrypt fails with a hard error rather than producing corrupted
   output.
3. **Each encryption is unique.** A fresh random salt (16 bytes) and
   IV (initialization vector — a one-time starting point for the
   encryption, 12 bytes per NIST (National Institute of Standards
   and Technology) recommendation) are generated every time something
   is encrypted. This means encrypting the same password or key
   twice produces completely different ciphertext — an attacker who
   sees the encrypted file learns nothing about the plaintext by
   comparing it to other encrypted files.

**One password, every secret:** Third-party API keys (Moralis,
Telegram, etc.) are encrypted with the **same wallet password** —
there is no separate "API-keys password" to manage or lose. After
the unlock, the server caches the password in the
`_sessionPassword` module-level variable in
[`src/server-routes.js`](../src/server-routes.js) (line 84) so
subsequent API-key save/reveal operations during the same session
don't re-prompt. The cache is discarded when the process exits.

**Two ways to import the wallet — same password either way:** The
encrypted `wallet.json` file can be created through either of two
workflows, depending on how you run LP Ranger:

- **Through the dashboard** (browser UI) — paste a seed phrase or
  private key into the import dialog. The server encrypts and
  saves it.
- **From the command line** (headless, no browser) — run
  `node scripts/import-wallet.js`, which prompts for a private key
  and a password, then creates the same encrypted `wallet.json`.

Both workflows produce the same file and use the same password.
There is no separate "CLI password" or "dashboard password."

[`src/bot-cycle.js`](../src/bot-cycle.js)'s `resolvePrivateKey()`
picks the signing-key source in fixed priority:
`PRIVATE_KEY` (plaintext hex in `.env` — *not recommended*) →
encrypted wallet unlocked by `WALLET_PASSWORD` env var, `--headless`
terminal prompt, or dashboard dialog.

**Three startup modes:** The modes differ only in how the password
reaches the server — the encrypted files, the decryption process,
and the in-memory handling are identical in all three cases:

| Mode | Command | Password source | On disk? |
| ---- | ------- | --------------- | -------- |
| Dashboard (default) | `node server.js` | Browser unlock dialog | No — memory only |
| `--headless` prompt | `node server.js --headless` | Terminal stdin prompt | No — memory only |
| Unattended | `WALLET_PASSWORD=pw node server.js` | `.env` file | **Yes** — plaintext |

In `--headless` mode, if the wallet can't be unlocked (no password
provided, no `WALLET_PASSWORD` in env, no wallet imported), the
server **exits with an error** rather than falling through to
dashboard-only mode — there is no browser to fall back to.

**Operator responsibilities when using `WALLET_PASSWORD`:**

- Treat `.env` as sensitive. It is already covered by `.gitignore`
  (see `test/gitignore.test.js`), but backup hygiene, file
  permissions, and disk encryption remain operator-side concerns.
- Avoid uncontrolled `.env` copies. Backup utilities, IDE workspace
  archives, and syncthing-style directory replicators can propagate
  stale plaintext passwords long after the live file has been
  rotated.
- When rotating a password, run `npm run reset-wallet` rather than
  editing `.env` by hand — the script scrubs the `WALLET_PASSWORD=`
  line and deletes `app-config/user-configurable/wallet.json` in one step, so the
  next restart forces a fresh import.

**How `reset-wallet` works:** `scripts/reset-wallet.js` (invoked via
`npm run reset-wallet`) performs two idempotent actions:

1. Delete `app-config/user-configurable/wallet.json`.
2. Remove every line matching `^WALLET_PASSWORD=` from `.env` by
   reading the file, filtering out the matching lines, writing to a
   `.tmp` sibling, and atomically renaming. File permissions are
   preserved via `fs.chmodSync` before the rename.

Both steps tolerate missing targets (no error if `.env` is absent or
the line never existed), so the script is safe to run on any system
state. `npm run clean` and `npm run dev-clean` both invoke
`reset-wallet` as their first step, so they also scrub the password
line.

Each service gets its own entry (`{service}Encrypted`) in
`app-config/user-configurable/api-keys.json` with an independently generated salt and
IV, so identical passwords still derive distinct per-entry keys and a
leaked ciphertext for one service reveals nothing about another.

`app-config/user-configurable/wallet.json` and `app-config/user-configurable/api-keys.json` are the only
on-disk homes for these secrets; both are gitignored and protected by
the `app-config/*` glob in `.gitignore`. `test/key-store.test.js`,
`test/key-migration.test.js`, and `test/wallet-manager.test.js` cover
round-trip encrypt/decrypt, wrong-password rejection, and on-disk
format stability.

#### In-Memory Handling

Plaintext keys exist only during the narrow decrypt-then-sign window
inside the bot loop. They are never written to disk unencrypted, never
returned by `GET /api/status`, and never included in any log line.

**Lint enforcement:** The custom ESLint rule
[`9mm/no-secret-logging`](../eslint-rules/no-secret-logging.js) flags
any `console.log/warn/error/info` call that references an identifier,
member expression, or template-literal expression whose name matches
`/private.?key|mnemonic|seed.?phrase|password|secret|signing.?key/i`.
String literals ("Loading private key...") are allowed because they
cannot leak a real value. The rule ships via `eslint-security.config.js`
and runs under `npm run audit:security`.

#### Secret Scanning

- **`secretlint`** (`npm run audit:secrets`) scans `src/**/*.js`,
  `server.js`, `bot.js`, `.env*`, and `*.json` with the
  `@secretlint/secretlint-rule-preset-recommend` preset, which covers
  AWS, GCP, GitHub, Slack, and generic private-key patterns.
- **`eslint-plugin-no-secrets`** (wired into
  `eslint-security.config.js`) adds entropy-based detection
  (`tolerance: 4.5`, `additionalDelimiters: ['0x']`) so novel-format
  API keys that the preset misses still surface as warnings.

#### Gitignore Enforcement

`test/gitignore.test.js` asserts that `.gitignore` covers `.env`,
`.env.*`, `*.keyfile.json`, the `app-config/*` glob, and the
`app-data/*` glob, while explicitly un-ignoring `.env.example`,
`app-defaults-for-user-configurable/`, `user-configurable/` (plus its
tracked `README.md`), and `app-data/README.md`. If a contributor
deletes one of those ignore lines, the test fails before the unsafe
change can merge.

### Cryptographic Primitives

Getting encryption wrong is one of the easiest ways to create a
vulnerability that looks secure but isn't. A home-grown cipher, a
reused random value, or a non-authenticated encryption mode can each
silently undermine everything the rest of the security architecture
provides. LP Ranger avoids these pitfalls by using only established
primitives and never inventing its own.

#### No Custom Crypto

All cryptographic operations call Node's built-in `crypto` module —
`pbkdf2`, `createCipheriv('aes-256-gcm')`, `randomBytes`. The app
never implements its own hash, cipher, or MAC (message authentication
code). The external `csrf`
package (pillarjs, widely deployed behind Express) is the single
dependency chosen to compose cryptographic tokens.

#### Authenticated Encryption

AES-**GCM** (not CBC (Cipher Block Chaining)) is used everywhere so
ciphertext integrity is verified as part of decryption. Swapping to
an unauthenticated mode (CBC, CTR (Counter mode) without HMAC
(Hash-based MAC)) would make padding-oracle or bit-flip attacks
feasible, even against a local adversary with read access to
`app-config/`.

#### Secure Randomness

All random material (PBKDF2 salt, AES-GCM IV, CSRF secret) comes from
`crypto.randomBytes()`. `Math.random()` is statistically biased and
predictable; using it for a salt or IV would reduce encryption strength
to the PRNG's (pseudorandom number generator) state-recovery
complexity.

**Lint enforcement:** `eslint.config.js` registers a
`no-restricted-syntax` pattern that bans
`Math.random()` calls project-wide with the message *"Use
crypto.randomBytes() instead of Math.random() — not cryptographically
secure."* The security lint's `security/detect-pseudoRandomBytes` rule
is also enabled as a second line of defense, catching calls to the
deprecated `pseudoRandomBytes` API.

### Input Validation & Data Modeling

Every piece of data that arrives from the outside — a config change
from the dashboard, a wallet address from a URL, a position identifier
from a deep link — must be validated before it touches internal state.
Accepting malformed or unexpected input is how bugs become
vulnerabilities: a garbled position key could route a rebalance to the
wrong pool, and an unvalidated config field could overwrite internal
bookkeeping.

#### Composite Key Parsing

LP Ranger manages multiple positions simultaneously, so every
position-specific API call must identify **which position** it's
acting on. The identifier is a composite key — a dash-separated
string like `pulsechain-0x4e448...-0xCC05b...-157149` that encodes
the blockchain name, wallet address, the contract address of the
liquidity pool provider's NFT factory, and NFT token ID. A malformed or missing key could route a config change,
a rebalance, or a stop command to the wrong position — or to no
position at all.

`parseCompositeKey()` in
[`src/bot-config-v2.js`](../src/bot-config-v2.js) validates the
format: exactly four dash-separated parts, with `0x`-prefixed wallet
and contract fields. If the key is missing or doesn't match, the
route handler returns `400` immediately. This applies to every
position-specific route (`POST /api/config`,
`DELETE /api/position/manage`, `POST /api/rebalance`,
`POST /api/compound`).

#### Config Key Allowlist

When the dashboard saves a setting — say the user changes their
slippage tolerance from 0.5% to 0.75% — the browser sends a JSON
body like `{ "slippagePct": 0.75, "positionKey": "pulsechain-0x4e4..." }`
to `POST /api/config`. A naive handler that merged every field from
that body into the config object would let an attacker inject
unexpected keys (for example, overwriting `status` to mark a
position as stopped, or polluting internal bookkeeping fields).

LP Ranger prevents this with a strict `allowlist`. The route handler
in `src/server-routes.js` walks two hardcoded arrays —
`GLOBAL_KEYS` (gas strategy, RPC URL, etc.) and `POSITION_KEYS`
(slippage, threshold, timeout, auto-compound settings, etc.) defined
in `src/bot-config-v2.js` — and copies only those recognized names
from the request body. Every other field is silently dropped. Because
the `allowlist` is a constant inside server code (never derived from
user input), the bracket access `diskConfig[k]` that merges each
field is safe — which is why `eslint-plugin-security`'s
`detect-object-injection` rule is disabled with a documented reason
in `eslint-security.config.js`.

#### Checksummed Addresses

Every wallet and contract address is normalized through ethers'
`getAddress()` (EIP-55 (Ethereum Improvement Proposal 55)
checksumming) before it becomes part of a
composite key or cache filename. Case-variant addresses therefore
cannot produce duplicate state entries or cache poisoning.

#### BIP-39 Seed Validation

Wallet import via seed phrase validates against the BIP-39 (Bitcoin
Improvement Proposal 39) word list
before key derivation runs, rejecting typos and near-matches with a
clear error rather than silently deriving a wrong key.

### Injection Prevention

Injection attacks trick a program into treating data as code. For
example, if a server builds a database query by pasting user input
directly into the query string, an attacker can type SQL commands
instead of a name and take over the database. LP Ranger doesn't use
a database, but the same class of attack applies to JavaScript's
`eval()` (which executes arbitrary code), `child_process` (which
runs shell commands), and `require()` (which loads modules). The
security lint flags any use of these that could accept untrusted
input.

#### `eval` / `child_process` / Dynamic `require`

`eslint-plugin-security` runs in `npm run audit:security` and warns on
`detect-eval-with-expression`, `detect-child-process`, and
`detect-new-buffer`. `detect-child-process` exists because spawning
subprocesses with attacker-controlled arguments is a classic
command-injection vector. LP Ranger contains exactly one
`child_process.spawn` call — the self-invocation helper in
`scripts/stop.js` that posts to `/api/shutdown` — and the command,
arguments, and URL are all hardcoded constants with no user input
reaching them. The rule stays on so that any future `spawn` / `exec`
call is flagged for review.

Two `eslint-plugin-security` rules are disabled in
`eslint-security.config.js`:

| Rule | Why disabled |
| ---- | ------------ |
| `detect-object-injection` | Bracket access on config objects is intentional; keys come from server-owned `GLOBAL_KEYS` / `POSITION_KEYS` arrays, never from the request body. Any key not in these allowlists is silently dropped before the bracket write. |
| `detect-non-literal-fs-filename` | See detailed explanation below. |

All other `eslint-plugin-security` rules — including
`detect-non-literal-require`, `detect-eval-with-expression`,
`detect-child-process`, `detect-possible-timing-attacks`,
`detect-pseudoRandomBytes`, and `detect-new-buffer` — are enabled
at `warn` severity.

**Why `detect-non-literal-fs-filename` is off:** This rule flags
every `fs` call where the path argument is a variable rather than a
string literal. In a web application that passes user input to
`fs.readFileSync()`, that's a real vulnerability — an attacker
could read `/etc/passwd` or overwrite system files. But LP Ranger
is a local-only Node server where **no user input ever reaches any
filesystem path**. Every `fs` call uses computed paths built from
`__dirname`, `path.join(cwd, CONSTANT)`, `os.tmpdir()`, or
server-owned config-scoped filenames.

The rule cannot distinguish `path.join(__dirname, "app-config",
"chains.json")` from `path.join(cwd, userInput)` — it flags both
identically. With the rule enabled, the codebase produces **~90
warnings** across `src/`, `scripts/`, and `server.js`. Suppressing
each one with a per-line `eslint-disable-next-line` directive would
add 90 noise lines without improving security, because the
underlying condition — user-controlled paths reaching `fs` — does
not exist in this architecture. The actual defense against
filesystem-escape attacks is the `serveStatic()` path-traversal
guard (see [Path Traversal in Static Serving](#path-traversal-in-static-serving)
above), which operates at the HTTP route level, not at individual
`fs` call sites.

#### Prototype Pollution

Modifying a built-in's prototype — e.g. `String.prototype.fooBar =
function myAttack() {...}` — lets an attacker change the behavior of
every string (or array, or object) in the running process from a
single assignment. ESLint's built-in `no-extend-native` rule blocks
this pattern at lint time, so any such assignment fails CI before it
can be merged. The rule is enabled in `eslint.config.js`'s shared
rules and applies to every file the linter sees.

#### XSS (Cross-Site Scripting) / DOM Safety

The dashboard's rendered HTML is built from trusted sources only: the
Uniswap v3 SDK's numeric output, server JSON, on-chain event data, and
user-entered amounts that are either numeric or already-validated
addresses. There is no external script tag in
`public/index.html` — fonts are self-hosted via `@fontsource`, and the
only bundled JavaScript is `public/dist/bundle.js` produced by esbuild
from the audited `public/dashboard-*.js` sources. Copy-to-clipboard
operations use `textContent`, never `innerHTML`, so pasted wallet
addresses cannot be reflected as executable markup. The custom rule
[`9mm/no-interpolated-innerhtml`](../eslint-rules/no-interpolated-innerhtml.js)
blocks any new `innerHTML` / `outerHTML` / `insertAdjacentHTML`
assignment whose right-hand side is an interpolated template literal
or a `+`-concatenated string — the specific sink patterns that turn
untrusted data into executable markup. Static string literals and
trusted-constant references (e.g. the disclosure HTML) remain
allowed, since those carry no attacker-controlled input.
`html-validate` (run as part of `npm run lint`) enforces structural
HTML correctness on every commit.

### Filesystem Safety

LP Ranger reads and writes files — config, caches, encrypted keys —
so it's important that an attacker can't trick it into reading or
writing files outside its own directory (for example, reading
`/etc/passwd` or overwriting a system file).

Every `fs.readFileSync` / `fs.writeFileSync` call in `src/` resolves
its path via `path.join(process.cwd(), CONSTANT)` — no user-controlled
path component ever reaches the filesystem layer. Atomic writes
(`.tmp` + `rename`) prevent partial-file corruption from an interrupted
shutdown. The static-file serving guard (described in **Path Traversal
in Static Serving** above) provides the equivalent protection on the
inbound side.

### On-Chain / Transaction Security

LP Ranger's core job is sending blockchain transactions — removing
liquidity, swapping tokens, minting positions. Each of these
transactions costs real money (gas fees), moves real funds, and is
irreversible once confirmed. A stuck transaction, a duplicated
transaction, or a swap executed at a bad price can all cause financial
loss. The controls in this section protect the transaction pipeline
itself.

#### Nonce Serialization

A single async-mutex rebalance lock in
[`src/rebalance-lock.js`](../src/rebalance-lock.js) serializes every
transaction across every managed position. Only one position signs at a
time (same wallet = same nonce). The lock has no timeout because
blockchains can hold a TX pending for days — a timeout would free the
lock while the nonce is still occupied and cause every subsequent TX to
fail with "could not replace existing tx." The holder runs the TX
recovery pipeline to completion before releasing.

#### TX Recovery Pipeline

`_waitOrSpeedUp()` in `src/rebalancer.js` wraps every `tx.wait()` in a
four-phase pipeline: **wait → speed-up (1.5× gas) → wait → auto-cancel
(0-PLS self-transfer)**. Stuck nonces therefore always free themselves
within `TX_CANCEL_SEC` (default 20 min) instead of blocking the wallet
indefinitely. Every phase logs its state so post-mortem analysis of a
stuck TX is deterministic.

#### RPC Failover

All TX-sending paths route through
[`src/send-transaction.js`](../src/send-transaction.js), which holds
both the primary and fallback providers built at boot. On `estimateGas`
failure against the primary, the module retries against the fallback;
on success it engages a sticky one-hour failover window so subsequent
broadcasts, receipts, and nonce lookups also flow through the fallback.
The window self-heals — `getCurrentRPC()` reverts to primary once the
timer expires. Broadcast failover requires the signer to be a
`FailoverNonceManager` that lazily rebinds on RPC change. No-op when
the configured primary and fallback URLs are identical.

Reads use the same window. `getManagedReadProvider()` returns a Proxy
that delegates each call to `getCurrentRPC()` and retries failover-
eligible errors (`SERVER_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, 5xx) via
`failoverToNextRPC()`. Boot reachability is `ensureReachable()`. One
sticky failover state covers both sides.

#### Slippage Guards

Swap `amountOutMinimum` is derived from a `staticCall` quote
(`_checkSwapImpact()` in `src/rebalancer-pools.js`), not spot price. If
the quoted price impact exceeds the user's slippage setting, the swap
aborts and the bot pauses until the user resolves the condition. This
prevents low-liquidity pools or aggressive aggregator routes from
silently draining the position on a single TX.

#### Swap Gates (Dust + Gas)

Every swap call site (initial rebalance swap, post-swap corrective loop,
and the new ratio-correcting compound swap) routes through a single
helper, `shouldSkipSwap()` in [`src/swap-gates.js`](../src/swap-gates.js).
Two gates run in a fixed order:

1. **Dust gate (first).** Skip when the swap value (in USD) is below the
   gold-pegged dust threshold. The dust gate runs first because a failure
   there is cheaper and more reliable to detect than the gas-gate, and a
   dust-skip short-circuits the more expensive gas estimate. Running dust
   first also minimises the latency between the gas-price read and the
   actual swap broadcast: when dust skips the swap entirely, no gas read
   happens at all, and when dust passes, the gas read is the very next
   step — so any drift in the gas-price between the read and the swap
   submission is kept as small as possible.
2. **Gas gate.** Skip when estimated gas cost exceeds **1%** of the swap
   value. The threshold is exposed as a module-level
   `MAX_SWAP_GAS_RATIO = 0.01` so every consumer references the same
   constant. Comparison is strict `>`, so a ratio of exactly 1% still
   passes.

When either gate trips, the caller proceeds without swapping. For
rebalance, that means minting with the unswapped balances and letting
the corrective loop or the post-rebalance residual sweep handle any
leftover. For compound, that means depositing only the side that fits
the current tick ratio and tracking the rest as a wallet residual to be
folded back in on the next rebalance.

The gas estimate uses `provider.getFeeData()` × a configurable swap-gas
units estimate (`config.CHAIN.aggregator.estimatedSwapGasUnits`,
default 500_000). When `getFeeData()` throws or returns nothing usable,
`estimateSwapGasUsd()` returns 0 — the gas gate degrades to a no-op
rather than blocking swaps on a flaky RPC.

#### Atomic Multicall

The 9mm Pro `NonfungiblePositionManager` requires
`decreaseLiquidity` and `collect` to execute atomically — between them,
any other transaction could reprice or front-run the liquidity that was
just accounted for.

**Lint enforcement:** The custom ESLint rule
[`9mm/no-separate-contract-calls`](../eslint-rules/no-separate-contract-calls.js)
(configured with the pair `[["decreaseLiquidity", "collect"]]`) walks
each function scope and errors if both calls appear as separate
`await`ed transactions. Wrapping them inside `encodeFunctionData(...)`
for `multicall` is recognized as the safe pattern and exempted. Any new
atomic pair can be added to the rule's `pairs` option in one line.

#### BigInt Precision

EVM (Ethereum Virtual Machine) token amounts in 18-decimal tokens
routinely exceed JavaScript's
2⁵³ integer precision. Silent truncation there would under-report
balances and, worse, under-request minimum-out in swap calldata.

**Lint enforcement:** The custom ESLint rule
[`9mm/no-number-from-bigint`](../eslint-rules/no-number-from-bigint.js)
blocks unsafe casts *from* a BigInt *to* a JavaScript `Number`. The
BigInt is the value being cast — it holds the full-precision integer
returned from an on-chain read (wei amounts, pool liquidity, reserve
balances). The rule flags the four JavaScript constructs that perform
this cast: `Number(x)`, `parseFloat(x)`, `parseInt(x)`, and unary `+x`.

To tell which variables hold such a BigInt without requiring a
full type inference, the rule matches variable *names* against the
regex `/^(liquidity|rawBalance|reserve[s]?|weiAmount)$/i`. These are
the four names this codebase uses by convention for wei-scale BigInts
straight from the chain. Casting any of them silently rounds the
value to the nearest IEEE-754 double — under-reporting balances and,
worse, under-requesting minimum-out in swap calldata — so the rule
errors at lint time.

The correct pattern is to keep the BigInt through all arithmetic and
only convert at the very end, after scaling down with
`ethers.formatUnits(bigint, decimals)` (which returns a decimal
string) and then calling `parseFloat` on that string. Per-line
`eslint-disable-next-line` directives are allowed only with a
`-- Safe: <reason>` comment documenting why float math is acceptable
at that call site (currently: three sites doing approximate
sqrtPrice display math).

### Supply Chain & Dependencies

LP Ranger depends on third-party npm packages for cryptography, EVM
(Ethereum Virtual Machine) math, and other core functions. A
compromised package — one where an attacker publishes a malicious
update — could steal your private key at runtime without changing a
single line of LP Ranger's own code. This section describes how the
dependency surface is kept small, audited, and pinned so that known-
good versions can't be silently replaced.

#### Reputable-Package Philosophy

LP Ranger deliberately prefers well-vetted npm packages over in-house
implementations for every security-sensitive concern: `csrf` for
tokens, `ethers` for EVM math and checksumming, `async-mutex` for the
rebalance lock, `@uniswap/v3-sdk` + `jsbi` for exact sqrtPrice
arithmetic, and `navigo` for client-side routing. The reasoning is
that rolled-in-house crypto or lock implementations are almost always
worse than the widely-deployed alternative, and a CVE (Common
Vulnerabilities and Exposures advisory) in a popular package is
discovered and patched far faster than one in a one-off module. The
`"dependencies"` block in `package.json` is intentionally
small (9 packages) so the review surface stays tractable.

When a transitive dependency has a known issue, the first response is
to **delete `package-lock.json` and regenerate it** (`npm install`).
Stale lockfiles pin old transitive versions even when the parent's
caret range already accepts the fix — most advisories resolve this
way without any code change. `"overrides"` in `package.json` are a
last resort, used only when the parent's declared range genuinely
excludes the patched version (e.g. an exact pin like `"1.0.0"`).

#### Pinned Production Releases

End-user installs are a **supply-chain security boundary**. The
release workflow in `.github/workflows/release.yml` rewrites every
entry in `package.json` from a caret range (e.g. `"csrf": "^3.1.0"`)
to an exact version (`"csrf": "3.1.0"`), reading the version to pin
from the resolved entries in `package-lock.json` — so the pinned
`package.json` captures the exact tree that `main` was tested
against, not whatever the caret range might newly resolve to at
release time. The workflow then regenerates
`package-lock.json` against the pinned `package.json` with
`--ignore-scripts`, writes an `.npmrc` with `save-exact=true`, and
ships a prebuilt `public/dist/bundle.js` so the end user's machine
never runs esbuild on potentially-compromised source. The tarball
users download from GitHub Releases is therefore byte-identical
across installs on the same tag.

The install instructions in [`README.md`](../README.md) mandate
`npm ci` (not `npm install`) — `npm ci` verifies the lockfile's
integrity hashes, refuses to mutate the lockfile, and deletes any
stray `node_modules` before installing. Combined, these steps close
off three concrete supply-chain attack classes: compromised newer
versions (like the `event-stream` / `ua-parser-js` / `colors.js`
pattern), transitive typosquatting/version confusion, and
reproducibility drift between the graph the maintainer tested and
the graph the user receives. See
[Dependency Management](#dependency-management) for the full release
workflow, lockfile controls, lifecycle-script handling
(`--ignore-scripts` usage), and inventory of runtime vs devDependency
packages.

#### `npm audit`

`npm run audit:deps` runs `npm audit --audit-level=high --json` and
writes the full report to
`test/report-artifacts/raw-data/npm-audit.json`. The threshold is
`high` so pre-existing moderate advisories don't fail CI, but the
severity breakdown (critical / high / moderate / low / info) is
displayed in the check-report summary and PDF on every run so nothing
moderate sits unnoticed for long.

One known ecosystem-wide advisory is accepted rather than patched: the
`elliptic` package (reachable transitively through `@uniswap/v3-sdk`)
carries a long-standing timing-side-channel finding in its ECDSA
(Elliptic Curve Digital Signature Algorithm) signing path. The advisory has no fix available from the upstream
maintainer, and the vulnerable function is not on any code path we
exercise — LP Ranger uses `ethers` for wallet signing, not
`@uniswap/v3-sdk`'s internal ECDSA helpers. The residual risk is
accepted here rather than patched in-house because override-forking
`elliptic` would fork every Uniswap SDK consumer that depends on it.
The advisory is re-checked on every release; if a fix lands upstream,
a lockfile regeneration or (if needed) an override is the path to
pin the update.

#### CI Enforcement

The security audits run as three independent jobs in
`.github/workflows/security-audit.yml` (`audit:deps`, `audit:security`,
`audit:secrets`) so each one can be individually required in branch
protection. All three also run locally under `npm run check`.

### Runtime Hardening

Even with good architecture, a running process can fail in ways that
either crash silently (hiding bugs) or stay alive in a broken state
(hiding worse bugs). These measures ensure the process fails loudly
on real errors, shuts down cleanly when asked, and doesn't leave
transactions hanging.

#### Strict Mode Everywhere

`"use strict"` is required at the top of every source and test file,
enforced by ESLint's `strict: ["error", "global"]` rule. This eliminates
silent global-variable creation, accidental octal literals, and other
non-strict footguns.

#### Error Guard

[`src/server-error-guard.js`](../src/server-error-guard.js) installs
`uncaughtException` and `unhandledRejection` handlers that downgrade
transient RPC errors (`TIMEOUT`, `NETWORK_ERROR`, `SERVER_ERROR`) to a
non-fatal warning but still crash the process on any other uncaught
error, so real bugs are never silently swallowed.

#### Graceful Shutdown

`POST /api/shutdown` (CSRF-protected like every other mutating route)
calls `positionMgr.stopAll()` and then exits cleanly so nonces are not
left hanging. The `scripts/stop.js` helper fetches a fresh token before
calling the endpoint.

### Code Review Controls

Security bugs hide most easily in large, complex files that no single
reviewer can hold in their head. The rules in this section keep files
small and functions simple, so every change is reviewable — and
enforce that security-sensitive deviations are documented rather than
silently introduced.

The `max-lines: 500` (skipBlankLines, skipComments) and
`complexity: 17` ESLint rules keep every file and function small
enough that a human reviewer can hold the whole control flow in their
head. Files that exceed the limits must be split — they cannot be
silenced with `eslint-disable`, because `reportUnusedDisableDirectives`
is configured to flag any stray directive that doesn't suppress a
real warning. Custom security rules (`9mm/no-secret-logging`,
`9mm/no-number-from-bigint`) may use per-line
`eslint-disable-next-line` **only** with a `-- Safe: <reason>`
comment documenting why the deviation is intentional. Current
exceptions:

| File | Line | Rule | Reason |
| ---- | ---- | ---- | ------ |
| `src/hodl-baseline.js` | 37 | `9mm/no-number-from-bigint` | Approximate float math for sqrtPrice display |
| `src/range-math.js` | 294 | `9mm/no-number-from-bigint` | Approximate float math for sqrtPrice display |
| `src/position-detector.js` | 169 | `9mm/no-number-from-bigint` | Zero-check only |

Whole files are never excluded from linting. Every exception is a
single `eslint-disable-next-line` comment. It sits on the exact line
that needs it. It must carry a `-- Safe: <reason>` note explaining
why.

A few paths do bypass ESLint. Generated and third-party output is
skipped: `node_modules/`, `coverage/`, `public/dist/`, and
`*.min.js`. The two hand-authored HTML files — `public/index.html`
(the dashboard) and `public/help-and-user-manual.html` (the user manual) — are also
outside ESLint's scope, but that's because they're markup, not
JavaScript. They aren't left unchecked. Both are linted by
`html-validate` as part of `npm run lint`.

ESLint runs in two passes against the same source files. Each pass
uses a different config. Other lint tools run alongside, including
stylelint, html-validate, markdownlint-cli2, and secretlint. Those
are separate programs. "Two passes" here refers only to ESLint.

The main pass is invoked as part of `npm run lint`. It uses
`eslint.config.js`. It enforces code-quality and non-security rules.
The full set: `complexity <= 17`, `max-lines <= 500`,
`max-len <= 80`, `no-unused-vars`, `no-var`, `prefer-const`,
`eqeqeq`, `strict`, `no-extend-native`, a `no-restricted-syntax`
ban on `window.*` assignment and `Math.random`, plus the custom
rules `9mm/no-separate-contract-calls` and
`9mm/no-fetch-without-csrf`.

The security pass runs via `npm run audit:security`. It is driven
by `eslint-security.config.js`. This pass is what actually enforces
the security rules. Those rules come from three sources:
`eslint-plugin-security`, `eslint-plugin-no-secrets`, and the custom
`9mm/no-secret-logging` / `9mm/no-number-from-bigint`. This pass
is also what decides whether a per-line exception stands.

The main config does one slightly odd thing to make this two-pass
setup work. It loads `eslint-plugin-security` without enabling any
of the plugin's rules.

First, some terminology. "Loading" a plugin means telling ESLint the
plugin exists. That in turn registers the names of every rule the
plugin provides. After that, ESLint knows what
`security/detect-unsafe-regex` refers to. "Severity" is a separate
concept. Severity lives on individual rules. It decides whether a
rule actually produces errors or warnings. A rule can be known to
ESLint but have no severity set. In that case it simply doesn't
fire.

Two security rules are pinned to severity `off` in the main config:
`security/detect-unsafe-regex` and
`security/detect-possible-timing-attacks`. Those are the two rules
referenced by per-line directives in this repo. The rest of the
plugin's rules are unconfigured there — which is also effectively
off.

Why load the plugin at all if none of its rules will fire? Because
of the disable directives. Developers write
`eslint-disable-next-line security/detect-unsafe-regex -- Safe: ...`
comments in the source code. Those comments are meant for the
security pass. But the main pass reads the same files and sees them
too. If the main pass didn't recognize the rule name, it would
error out with "Definition for rule not found."

The fix is to load the plugin and not enable the rules. The main
pass now recognizes every rule name. It sees the disable comment,
does nothing with it, and moves on.

The security pass is different. There, the rules are turned on.
Every rule listed in `eslint-security.config.js` is set to severity
`warn`. The `npm run audit:security` command passes
`--max-warnings 0`, which turns each warning into a build failure.
So a security finding is effectively an error in CI.

This is where the per-line disable directive earns its keep. Every
so often a rule flags code that looks dangerous but is actually
safe in context. Two examples from this repo: `detect-unsafe-regex`
firing on a regex that only ever runs against a known local file,
and `detect-possible-timing-attacks` firing on a string comparison
that confirms two copies of a user-entered password rather than
verifying a secret against a stored value. In those cases a false
positive would block the build. The directive tells the security
pass to skip that one line, and the `-- Safe: <reason>` comment
explains why it's safe. The rule stays on for the rest of the file
and the rest of the codebase.

#### Build and Infrastructure Scripts

The `scripts/` directory contains 15 Node modules that drive the
build pipeline (`build-info.js`, `cache-bust.js`), the check/report
pipeline (`check.js`, `check-report.js`, `check-report-parse.js`,
`check-report-pdf.js`, `check-report-md.js`), font management
(`copy-fonts.js`), state management (`wipe-settings.js`,
`restore-settings.js`, `reset-wallet.js`), server lifecycle
(`stop.js`), and auxiliary tools (`api-doc.js`,
`clear-pool-cache.js`, `telegram-send.js`). All 15 are subject to
the **same checks** as application source code:

- **ESLint (main)** — `scripts/**/*.js` is in the section 1 file
  list and section 3 Node-source config, so every script is held
  to the same `complexity <= 17`, `max-lines <= 500`, `strict`,
  `no-var`, `eqeqeq`, `prefer-const`, and `no-restricted-syntax`
  (Math.random ban) rules as `src/` and `server.js`.
- **Security lint** (`eslint-plugin-security` +
  `eslint-plugin-no-secrets` + custom `9mm/*` rules) — the
  `eslint-security.config.js` `files[]` array includes
  `scripts/**/*.js`, and `npm run audit:security` passes `scripts/`
  on the command line.
- **Secret scanner** (`secretlint`) — `npm run audit:secrets`
  includes the `scripts/**/*.js` glob.
- **Prettier** — `format` and `format:check` include
  `scripts/**/*.js`; the pre-commit hook (`husky` + `lint-staged`)
  auto-formats on every commit.

The `eslint-plugin-security` plugin is loaded in the main ESLint
config — the same loaded-but-silent pattern described in detail
above. Loading the plugin is what registers every one of its rule
*names* so that a per-line `// eslint-disable-next-line
security/detect-unsafe-regex` directive doesn't trip the main lint
pass with "Definition for rule not found." Two of the plugin's rules
are additionally pinned to severity `off` in the main config
(`security/detect-unsafe-regex` and
`security/detect-possible-timing-attacks`) because those are the two
rules actually referenced by per-line directives in the repo; the
rest of the plugin's rules aren't listed in the main config at all
and remain unconfigured (effectively `off`) there. (Strictly speaking,
a plugin is loaded, and severity lives on individual rules. Phrases
like "the plugin is registered at `off`" are shorthand.) The
security pass (`eslint-security.config.js`) loads the same plugin
with each rule set to `warn` — that's the pass in which the
directives actually suppress findings.

Four such directives currently exist in `scripts/`:

| File | Line | Rule | `-- Safe:` reason |
| ---- | ---- | ---- | ----------------- |
| `scripts/cache-bust.js` | 14 | `security/detect-unsafe-regex` | Input is local `index.html`, not user-supplied |
| `scripts/cache-bust.js` | 16 | `security/detect-unsafe-regex` | Input is local `index.html`, not user-supplied |
| `scripts/check-report-parse.js` | 183 | `security/detect-unsafe-regex` | Input is deterministic TAP v14 from `node --test` |
| `scripts/import-wallet.js` | 98 | `security/detect-possible-timing-attacks` | Comparing two user-entered password strings for confirmation, not verifying a secret |

This means a compromised or careless infrastructure script cannot
silently bypass the same quality and security gates that protect
the application code — there is no "scripts are just tooling"
carve-out.

#### GitHub Actions Workflows

The `.github/workflows/*.yml` files that drive CI are themselves
held to two `npm run check` gates: Prettier `--check` for shape and
formatting, and `actionlint` for workflow correctness. The
`actionlint` binary is installed as a devDependency
(`github-actionlint`, an npm wrapper that downloads the official
`rhysd/actionlint` Go binary at install time) so that every check
run on every developer machine and in CI uses the same pinned
version. There are no rule-selection knobs — actionlint runs its
full default rule set on every workflow file, and any new finding
fails `npm run check`.

The security-relevant checks actionlint performs are:

- **Script-injection detection** — flags `${{ ... }}` expressions
  containing untrusted inputs (e.g. `github.event.issue.title`,
  `github.head_ref`, PR body, branch names) interpolated directly
  into a `run:` block. This is the standard GitHub Actions
  command-injection vector: an attacker who controls a PR title
  could inject shell metacharacters that execute on the runner with
  whatever permissions the workflow has. actionlint forces the
  workflow to route untrusted input through an environment variable
  instead, where shell quoting is the runner's job, not the YAML
  templater's.
- **Hardcoded credentials** — flags plaintext secrets in
  `services:` and `container:` configurations (database passwords,
  registry credentials), pushing them through `${{ secrets.* }}`
  instead.
- **Permissions and `GITHUB_TOKEN` scope sanity** — surfaces
  workflows that grant broader token permissions than the steps
  appear to need.

Beyond security, actionlint also catches the everyday workflow
bugs that would otherwise only surface as a red CI run: unknown
context fields, invalid `runs-on:` labels, broken `needs:`
references, malformed cron expressions, deprecated action versions,
and YAML syntax that GitHub will silently accept but never execute
correctly. Catching these in `npm run check` instead of in CI keeps
the feedback loop local and prevents a broken-workflow commit from
reaching `main`.

### Test-Time State Protection

`scripts/check.js` backs up every top-level file in `app-config/`
(plus `tmp/*.json`) to a `mktemp -d` directory, wipes the live files,
runs the test suite against vanilla state, and restores the originals
via an `EXIT` trap. This prevents a test that creates a stub config or
keyfile from ever clobbering live user state, and it means a test that
believed it had written to `app-config/user-configurable/wallet.json` was actually
writing to a scratch copy. Tests that need explicit paths instead use
the `WALLET_FILE_PATH` / `API_KEYS_FILE_PATH` environment variables or
pass a `dir` argument to `loadConfig` / `saveConfig` directly.

---

## Check Report Artifacts

`npm run check` (via `scripts/check.js`) runs lint + tests + coverage +
security audits and writes a full set of report artifacts to
`test/report-artifacts/`. The whole directory is gitignored — timings and
machine-specific data are noisy and not worth committing.

### Layout

```text
test/report-artifacts/
├── report.pdf                Unified PDF of all results (pdfmake + Roboto)
├── tests.tap                 Raw TAP v14 from `node --test`
├── text-reports/             Human-readable text outputs
│   ├── summary.txt               Overall overview (cli-table3, no ANSI)
│   ├── summary.md                Same overview, GitHub-flavored markdown
│   │                              (CI appends it to $GITHUB_STEP_SUMMARY)
│   ├── tests-summary.txt         Test rollup: slowest, failures, coverage
│   ├── eslint-timing.txt         ESLint TIMING=1 slowest-rules capture
│   └── markdownlint.txt          markdownlint-cli2 stylish text output
└── raw-data/                 Machine-readable tool outputs
    ├── eslint.json               eslint --format json-with-metadata
    ├── stylelint.json            stylelint --formatter json
    ├── html-validate.json        html-validate -f json
    ├── npm-audit.json            npm audit --json
    ├── security-lint.json        eslint -c eslint-security.config.js --format json
    ├── secretlint.json           secretlint --format json
    └── exit-codes.json           Per-tool exit codes captured by check.js
```

### What's in the Summary / PDF

- Overall PASS / FAIL
- Per-check result row (pass/fail + one-line detail: error counts, rules
  loaded, files scanned, duration, coverage %)
- Slowest 5 ESLint rules (from `TIMING=1`)
- Slowest 5 tests (parsed from TAP per-test `duration_ms`)
- Test failures (name + count, up to 10)
- npm audit severity breakdown (critical / high / moderate / low / info)

### Workflow

1. `npm run check` runs each tool, writes its raw output into `raw-data/`
   (and the two text-only captures directly into `text-reports/`), then
   runs `scripts/check-report.js` which parses everything, prints the
   terminal summary, and writes `text-reports/summary.txt`,
   `text-reports/summary.md`, `text-reports/tests-summary.txt`, and
   `report.pdf`.
2. `npm run view-report` opens the PDF (uses `xdg-open`; Linux dev box).
3. To re-render the summaries and PDF **without** re-running any tools
   (e.g. after tweaking `scripts/check-report-pdf.js`), just run
   `node scripts/check-report.js` — the aggregator reads the
   previously-captured `raw-data/` files and regenerates everything.
4. GitHub Actions (`.github/workflows/ci.yml`) runs `npm run check` on the
   Node 22/24 matrix, appends `text-reports/summary.md` to
   `$GITHUB_STEP_SUMMARY` so the rollup renders inline on every run page,
   and uploads the whole `test/report-artifacts/` directory as a
   downloadable workflow artifact (`check-report-node-<ver>`). Reviewers
   can read the summary without clicking anywhere, and download the PDF +
   raw data when they need to dig deeper.

### Adding a New Tool to the Report

1. Add the tool invocation to `scripts/check.js` with its JSON/TAP
   formatter flag, redirecting stdout into `raw-data/<tool>.json`.
2. Capture its exit code into `exit-codes.json` alongside the others.
3. Add a parser function to `scripts/check-report-parse.js`.
4. Wire it into `loadResults()` in `scripts/check-report.js` and add a
   row to `overviewRows`.
5. Add a section (or table row) to `scripts/check-report-pdf.js` if it
   deserves its own block in the PDF.

The aggregator never re-runs tools itself, and `check.js` never parses
JSON — keeping the two concerns separate means a broken PDF template
can't corrupt raw tool data, and a broken parser can't corrupt a
previously-good PDF.

---

## API Documentation

The authoritative reference for every HTTP route, request/response schema,
and status code the server exposes is the **OpenAPI 3.0 spec** in
[`docs/openapi.json`](openapi.json), rendered as an interactive explorer
by a lightweight local HTTP server that uses **[Scalar](https://scalar.com)**
(`@scalar/api-reference`) as the renderer. Scalar has a polished native
dark theme that matches the rest of LP Ranger's palette, plus interactive
"Try it out" support — it's a modern replacement for the old Swagger UI.
The brief ROUTES list in [`server.js`](../server.js)'s file-header is a
human-readable index, not the full spec.

### Starting the Local API Reference Server

```sh
npm run api-doc
```

This runs [`scripts/api-doc.js`](../scripts/api-doc.js), which starts a
standalone HTTP server on **<http://localhost:5556>**. The server is
independent of the main dashboard — you can run it alongside
`npm start` (which uses port 5555) without conflict. (The script was
called `npm run swagger` before the Scalar migration; the old name no
longer exists.)

How it works:

- `scripts/api-doc.js` serves an `index.html` shim that loads Scalar's
  standalone browser bundle from
  `node_modules/@scalar/api-reference/dist/browser/standalone.js` via
  a `/scalar-standalone.js` route.
- The shim passes `data-url="/openapi.json"` and
  `data-configuration='{"darkMode":true,…}'` to Scalar's bootstrap
  `<script id="api-reference">` element.
- `/openapi.json` streams `docs/openapi.json` from disk on every request
  — no caching, no build step, no code generation.

The whole server is ~70 lines of hand-written Node HTTP with three
routes (`/`, `/openapi.json`, `/scalar-standalone.js`). Everything else
404s.

Stop the server with `Ctrl-C`. There is no shared PID file or `npm run
stop` integration for it — it's a dev tool, not part of the bot's
runtime.

### Updating the Spec When the API Changes

The spec is a single hand-maintained file at
[`docs/openapi.json`](openapi.json). There's **no code generation** —
route handlers do not auto-publish their schemas — so any route change
in `src/server-routes.js`, `src/server-positions.js`, or
`src/server-scan.js` must be mirrored by hand into `openapi.json`.

Typical workflow when you add, rename, or change an API route:

1. **Make the code change** in the appropriate `src/server-*.js` file
   and its call-site in `server.js`. Add/update the test in
   `test/server-*.test.js`.
2. **Open [`docs/openapi.json`](openapi.json)** and find (or add) the
   entry for the affected path under the top-level `paths` object. The
   file is organised by path first, then HTTP method:

   ```json
   "paths": {
     "/api/position/manage": {
       "post": { "tags": [...], "summary": "...", "requestBody": {...}, "responses": {...} },
       "delete": { ... }
     }
   }
   ```

3. **Update the fields that changed:**
   - `summary` and `description` — human-readable route purpose.
   - `tags` — one of the top-level tags declared in the `tags` array
     (`Status`, `Config`, `Wallet`, `Positions`, `Rebalance`,
     `Compound`, `System`). Add a new tag if the route doesn't fit any
     existing category.
   - `requestBody.content.application/json.schema` — the JSON shape of
     the expected request body, either inline or as a `$ref` into
     `components.schemas`.
   - `responses` — at minimum a `200` (or `201`/`204`) success case and
     the error cases the handler actually returns (`400`, `401`, `404`,
     `409`, `500`). Each response's `content.application/json.schema`
     documents the return shape.
4. **Reuse component schemas where you can.** Common shapes live under
   `components.schemas` at the bottom of the file (positions, wallet
   status, etc.). Add new shared shapes there rather than inlining the
   same object in multiple routes.
5. **Verify the spec renders.** Either:
   - Start Scalar with `npm run api-doc` and open
     <http://localhost:5556> — every path should render in the sidebar
     under the correct tag. Invalid spec structure surfaces as a Scalar
     runtime error in the browser console.
   - Or validate headlessly: `node -e "JSON.parse(require('fs').readFileSync('docs/openapi.json'))"`
     will at least catch JSON syntax errors. For a full OpenAPI 3.0
     validation pass, paste the file into
     <https://editor.swagger.io> — it's browser-side and doesn't
     require installing anything.
6. **Click through the affected route in Scalar's "Try it out"
   panel** to confirm the request body, response codes, and
   content-types render as expected.
7. **Run `npm run check`.** `docs/openapi.json` is not linted (it's a
   generated-style artifact even though it's hand-edited), but the
   file must still parse as valid JSON or Scalar will fail to load
   `/openapi.json`.
8. **Commit the spec change in the same commit as the route change**
   — this keeps the spec and the implementation from drifting in
   reviewable diffs.

### Reference

- `info.title` / `info.version` — bump `info.version` when you ship a
  breaking API change.
- `servers[]` — the local dev server URL. Not exercised in production
  (there's no hosted instance), but the value matters for Swagger UI's
  "Try it out" feature: requests go to whatever URL is listed here.
- `components.schemas` — shared request/response shapes.
- `tags[]` — category labels that group routes in the UI sidebar. Add
  a new tag only when a route genuinely doesn't fit an existing one.

---

## `server.js`

`server.js` is the execution entry point for the dashboard+bot process
(`npm start` / `npm run build-and-start`). The headless-bot variant
(`npm run bot`) is a thin wrapper around the same internals; see
[`bot.js`](../bot.js) for that path.

What happens when the process starts, in order:

1. **Colored logging is installed.** `installColorLogger()` from
   [`src/logger.js`](../src/logger.js) wraps `console.log`/`warn`/`error`
   so bracketed prefixes like `[server]`, `[bot]`, `[rebalance]` render
   in distinct colors and module-specific emoji IDs.
2. **`--help` / `-h` short-circuit.** If the flag is on `argv`,
   [`src/cli-help.js`](../src/cli-help.js) prints the usage text and the
   process exits with status 0 — nothing below runs.
3. **Core modules are required.** `http`, `fs`, `path`, then the app's
   own modules: `config` (env-var parsing), `walletManager`,
   `position-history`, `rebalance-lock`, `position-manager`,
   `bot-config-v2`, `migrate-app-config`. Requiring `src/config.js`
   also loads `app-config/app-defaults-for-user-configurable/chains.json` for the current
   `CHAIN_NAME`.
4. **Legacy config migration runs once.** `migrateAppConfig()` moves
   any surviving legacy root-level config files (`.bot-config.json`,
   `.wallet.json`, `api-keys.json`, `rebalance_log.json`) into
   `app-config/`. Idempotent — a no-op after the first successful run.
   See the [The `app-config` Directory](#the-app-config-directory)
   section for details.
5. **Module-level singletons are created.** A single `rebalanceLock`
   (async mutex) and a single `positionManager` are instantiated and
   shared by every route handler and bot loop in the process.
6. **On-disk bot config is loaded.** `loadConfig()` reads
   `app-config/user-configurable/bot-config.json`. Every managed position's composite
   key and `status` is logged so config-stomp incidents are visible in
   the console at boot. A successful load also writes the sibling
   `app-config/user-configurable/bot-config.backup.json` as a safety net.
7. **The HTTP server is created.** `http.createServer(handleRequest)`
   builds the server object; `requestTimeout` is raised to
   `config.SCAN_TIMEOUT_MS` so lifetime P&L scans (which can take
   5+ minutes on older pools) don't get cut off by Node's default
   300-second timeout.
8. **If run directly (`require.main === module`)**:
   1. `start()` calls `server.listen(PORT, HOST)` and logs the
      blockchain name, NFT factory, wallet address (or `(not loaded)`),
      dashboard URL, `/api/status` URL, port, and `/health` URL.
   2. `_tryResolveKey()` tries to obtain the wallet private key —
      either from `PRIVATE_KEY` in `.env`, from a
      `WALLET_PASSWORD`-decrypted `app-config/user-configurable/wallet.json`, or from
      an interactive prompt.
      - On success: `_autoStartManagedPositions()` spins up one bot
        loop per position whose v2 config has `status: 'running'`.
        Multi-position staggering inserts
        `CHECK_INTERVAL_SEC / N` ms between loop starts so they don't
        all poll the RPC on the same tick.
      - If the wallet is locked: logs
        `Wallet locked — unlock via dashboard to start bot.` and
        enters dashboard-only mode until the user unlocks via
        `POST /api/wallet/unlock`.
      - If no wallet exists: logs `No wallet key — dashboard-only mode`.
   3. `SIGINT` and `SIGTERM` handlers are installed. Each calls
      `_positionMgr.stopAll()` (which drains every bot loop through
      the rebalance lock) and then closes the HTTP server. A 3-second
      watchdog `setTimeout` forces exit if graceful shutdown hangs.
   4. A diagnostic `process.on('exit', …)` handler logs the final
      count of positions in memory vs. positions in `status: 'running'`
      — this catches config-stomp bugs where positions silently vanish
      mid-run.
9. **If imported as a module (e.g. from a test)**: nothing in step 8
   runs. The caller controls `start()` / `stop()` lifecycle explicitly.

The dashboard is served as static files from `public/` by `serveStatic()`;
all JSON APIs are dispatched by `handleRequest()` through a route table
that maps method+path to handlers defined in
[`src/server-routes.js`](../src/server-routes.js) and
[`src/server-positions.js`](../src/server-positions.js). The full route
surface is covered by the Swagger spec (see
[API Documentation](#api-documentation) above).

---

## `getPoolState` Validation + RPC Retry

`getPoolState` in `src/rebalancer-pools.js` is the single entry point
for reading pool / token state from on-chain contracts (slot0, decimals,
tickSpacing, derived price). Because the value it returns flows into
every downstream P&L, IL, rebalance, and lifetime-deposit calculation,
a silent bad return from a flaky RPC call can poison every consumer
with `NaN` and never recover &mdash; the original `0.8.0` Prod incident
where one position's `decimals0` came back `undefined` and produced a
`$NaN` lifetime-deposit total that stuck the "Syncing&hellip;" badge in
a forever-rescan loop.

### Validation

Every successful RPC return is validated field-by-field before being
handed back. Each predicate covers **not-null + correct datatype +
value range**. Validation logic lives in `src/pool-state-validate.js`
(error classes + predicates) so `rebalancer-pools.js` stays under the
500-line cap. Predicates:

- `poolAddress` &mdash; non-null 40-hex string AND not `ZeroAddress`
- `tickSpacing` &mdash; finite positive integer
- `tick` &mdash; any integer (signed int24)
- `decimals0` / `decimals1` &mdash; integer in `[0, 77]` (ERC-20 spec
  cap)
- `sqrtPriceX96` &mdash; coerces cleanly to BigInt `> 0n`
- `price` &mdash; finite number `> 0`

First failure throws `PoolStateInvalidError(field, value, rpcUrl)` so
the eventual user-facing modal can name exactly which field was bad
and which RPC produced it.

### Retry

`getPoolState` iterates `[config.RPC_URL, config.RPC_URL_FALLBACK]`,
constructing a fresh `JsonRpcProvider` for each attempt. Each RPC is
tried up to 2 times with a 3-second wait between retries. Any failure
(invalid response, RPC error, network timeout) counts as an attempt
failure. After exhausting every configured RPC, throws
`PoolStateUnavailableError(attempts, lastError)` wrapping the most
recent cause.

The orchestrator bypasses `sendTx`'s managed-provider proxy on
purpose: targeting a specific RPC URL per attempt would otherwise
require mutating `sendTx`'s sticky 1-hour failover state, which would
affect every other concurrent read. Worst-case latency for an
exhaustion is `2 URLs × 2 attempts + 3 waits = ~10 s` &mdash;
acceptable for a one-shot setup operation like position-manage.

### User-facing failure path

When `_tryInitPnlTracker` (`src/bot-loop-detect.js`) sees a Pool*Error
from `getPoolState`, it **re-throws** (the catch otherwise swallows
everything and returns null). The throw propagates to `handleManage`
in `src/server-positions.js`, which:

1. Discriminates the error type and returns **`HTTP 503`** with body
   `{ ok: false, error: "pool-info-unavailable", message: err.message, tokenId }`.
2. Runs the existing cleanup (drops the in-memory bot state, restores
   prior disk-config status, clears the `_starting` Set guard), so a
   subsequent Manage click starts from a clean slate.

The dashboard's `_handleManageFailure` in
`public/dashboard-events-manage.js` recognizes the
`pool-info-unavailable` code and renders the warning modal via the
existing `_createModal` template, injecting the raw `err.message` into
a 250&times;100 scrollable code block (`.9mm-pos-mgr-err-scroll`) via
`textContent` (not `innerHTML`) so any markup in the error message is
neutralized.

### Retry behaviour on subsequent Manage clicks

`getPoolState` is **never cached** (see the function's own JSDoc).
Each Manage click triggers a fresh full retry chain &mdash; if the
underlying RPC issue was transient and has cleared, the next click
succeeds; if the issue persists, the same modal appears. No app
restart is needed.

## Closed-position Re-open Flow

When a position auto-retires (drained for ≥ 30 min, see
`src/bot-cycle-drain.js`), its `cfg.positions[key].status` flips to
`stopped`, the bot loop stops, and the NFT is left intact (not
burned). To bring such a position back to life, the user clicks
**Manage** on its row in the dashboard. For closed positions, the
Manage button drives a guided three-step flow instead of starting the
bot loop directly:

1. **Wallet-token dust check.** Dashboard POSTs
   `/api/position/can-reopen` with the pair's two token addresses.
   Server reads on-chain `balanceOf` + token decimals + Moralis price
   for each, compares each to `getDustThresholdUsd()` from
   `src/dust.js`, and returns `{ canReopen, balances, dustThresholdUsd }`.
   `canReopen` is true when at least one of the two tokens is above
   the dust threshold.

   Reads are wrapped in a retry orchestrator that mirrors the
   `getPoolState` contract (PR #137): both tokens must read cleanly
   in a single attempt &mdash; partial failure (one token reads, the
   other throws) counts as a complete attempt failure to avoid mixing
   verified + unverified balances in the response. Each configured
   RPC is tried up to 2 times with a 3 s wait between retries; on
   exhaustion the handler throws `WalletReadUnavailableError`,
   mapped to HTTP 503 + `{ error: "wallet-read-unavailable",
   message }`. The dashboard recognizes the code and shows a
   dedicated "try again in 10+ minutes" modal with the raw error in
   the scrollable code box. The `fetchTokenPriceUsd` call is part
   of the all-or-nothing read &mdash; silently zeroing a missing price
   would risk a confidently-wrong `isDust: true` verdict.
2. **Intro modal.** If `canReopen`, dashboard shows a modal explaining
   that re-open requires a rebalance to seed liquidity from the
   wallet. Buttons: **OK** (the standard modal close &mdash; user can
   edit settings and re-click Manage) and **Re-open Position**
   (proceed).
3. **Range modal + atomic re-open.** "Re-open Position" opens the
   existing `rebalanceRangeModal` (the same one the Rebalance button
   uses for healthy positions); the modal derives "re-open context"
   purely from position state (closed + not actively managed) rather
   than from any flag passed in &mdash; impossible to get out of sync.
   The Confirm button POSTs `/api/position/manage` (NOT
   `/api/rebalance` &mdash; that route requires a running bot loop)
   with `{ tokenId, contract, forceRebalance: true, customRangeWidthPct }`.
   `liquidity` is deliberately omitted: `handleManage`'s
   autoCompound-default branch keys off `body.liquidity === "0"` and
   would persist `autoCompoundEnabled: false`, wrong for an
   actively-managed re-open.
   `handleManage` stamps `forceRebalance` + `customRangeWidthPct` on
   the fresh `posBotState` BEFORE starting the bot loop (via
   `_stampReopenFlags`), so the bot's first `pollCycle` sees the flag
   and `bot-cycle-drain.js`'s drain guard lets the rebalance pipeline
   run on the drained NFT in lieu of arming a new 30-min retire
   timer.
   If the position is ALREADY running (e.g. the user comes back to
   Manage after a prior re-open's swap aborted on slippage),
   `handleManage`'s "already running &mdash; skipping" short-circuit
   instead routes through `_stampReopenFlagsOnLive`, which stamps the
   flag onto the live posBotState AND clears
   `rebalancePaused` / `rebalanceFailedMidway` / `rebalanceError` so
   the next poll runs a fresh rebalance. Liquidity flips from 0 to
   positive; position is alive again.

When `!canReopen`, the dashboard shows a single-button modal listing
the current per-token wallet balances + the dust threshold so the
user knows exactly what they need to fund. No state change.

UI state for closed positions is also inverted from the prior
catch-22: **Rebalance is disabled** (cannot rebalance a drained NFT
directly &mdash; there's no liquidity to remove), **Manage is enabled**
and routes through the flow above. See `public/dashboard-data.js`
`_updateRebalanceButtons` and `public/dashboard-manage-badge.js` for
the button-state logic.

## Dead Code Detection

- `npm run knip` — [Knip](https://knip.dev) — finds unused exports, files,
  and dependencies. Note: the 8 `public/dashboard-*.js` files are false
  positives because knip cannot trace HTML `<script>` tags.

---

## SVG Assets

**Rule:** every SVG icon in the dashboard lives as a standalone `.svg`
file under `public/icons/`. No inline `<svg>` markup in HTML or JS.
Two categories exist because two different rendering shapes are needed;
the file-per-icon convention and the shared validation pipeline are
identical for both.

### Category 1 — Activity-Log icons (`act-*.svg`)

Prefix: `act-`. Loaded via **`<img src="icons/act-<name>.svg">`**.
Registered as URL strings in the `ACT_ICONS` map in
`public/dashboard-helpers.js`.

**Why `<img>`.** An icon that renders in dozens of log entries used to
be dozens of cloned copies of the same inline `<svg>` in the DOM, so
every `id=""` inside the SVG (for example the `<defs><path id="rope">`
inside `act-lasso.svg`) collided across copies. `<img>` renders each
instance in its own isolated document context, so ids are per-file and
can never collide.

**No `currentColor`.** `<img>`-loaded SVGs don't inherit the parent
page's `color`, so every stroke and fill in `act-*.svg` uses an
explicit hex value. Outline icons hard-code `stroke="#e0eaf4"` (the
resolved value of `--text` on the dark chip background); the two
colour icons (`act-acorn.svg`, `act-lasso.svg`) hard-code their
whites and dark green. Don't casually re-introduce `currentColor` on
these files — the log renders them via `<img>` and it won't cascade.

### Category 2 — UI icons (`ui-*.svg`)

Prefix: `ui-`. Loaded via **`fetch()` + DOMParser inline injection**
into `data-svg="…"` placeholder elements in `public/index.html`.
Injector lives in `public/dashboard-ui-icons.js`; `loadAllUiIcons()`
is called once from `dashboard-init.js` at page load.

**Why inline injection (not `<img>`).** These icons live inside
buttons and the wallet strip where their stroke needs to cascade from
the parent's `color` — `stroke="currentColor"` (or, for `ui-wallet.svg`,
`stroke="var(--accent)"`) resolves against the enclosing `.9mm-pos-mgr-icon-btn`,
`.pos-browser-btn`, `.ws-reveal-btn`, or `.modal-logo-icon` styles. That
cascade only works if the SVG is inline in the same DOM as its parent
— `<img>` isolates it.

**No ids anywhere.** LP Ranger icons forbid `id=` attributes outright,
enforced by `scripts/lint-svg.js`. Both rendering shapes (`<img>` for
act-*, inline injection for ui-*) work without ids, and forbidding
them removes an entire class of latent bugs where a `<use>` reference
silently picks the wrong element when the icon is cloned. Anything
that would have needed `<defs>` + `<use>` (e.g. drawing the same path
three times with different strokes for a layered rope effect) should
just inline the path three times instead. See `act-lasso.svg` for the
reference implementation.

**Placeholder shape.** A placeholder in HTML looks like

```html
<span data-svg="icons/ui-gear.svg" data-w="27" data-h="27"></span>
```

`data-w` / `data-h` are optional; the injector applies them as
`width` / `height` on the injected `<svg>` so the same file renders
at multiple sizes across the app (e.g. `ui-lock.svg` at 14 in the
reveal-key button and 24 in the wallet-unlock modal).

### Adding a new icon

1. Create `public/icons/<prefix>-<name>.svg` (`act-` for log entries,
   `ui-` for HTML-embedded icons).
   - Root `<svg>` MUST have `xmlns="http://www.w3.org/2000/svg"` and a
     `viewBox`.
   - `act-*` files: no `currentColor` — hard-code every colour.
   - `ui-*` files: `currentColor` and `var(--…)` both work.
   - No `id=` attributes anywhere in the file.  Repeat shapes
     inline if you'd otherwise reach for `<defs>` + `<use>`.
2. Register it:
   - `act-*` → add `<name>: "icons/act-<name>.svg",` to the
     `ACT_ICONS` object in `public/dashboard-helpers.js`, then call
     `act(ACT_ICONS.<name>, …)` from a call site.
   - `ui-*` → put a `<span data-svg="icons/ui-<name>.svg" data-w=".." data-h="..">…</span>`
     placeholder into `public/index.html`.
3. Run `npm run check`.

### Validation

Enforced at lint time by `scripts/lint-svg.js` (invoked from
`npm run lint`). Fails on: malformed XML, missing root `<svg>`,
missing `xmlns` / `viewBox`, or any `id=` attribute anywhere in a
file.

A separate smoke test (`test/icons-files.test.js`) fails if:

- an `ACT_ICONS` entry has no matching file on disk,
- a `data-svg="icons/…"` placeholder in `index.html` has no matching
  file on disk, or
- a file under `public/icons/` isn't referenced from either registry.

Both checks run under `npm run check`.

`scripts/lint-svg.js` uses `@xmldom/xmldom` (devDependency) so
validation runs in pure Node — CI doesn't need `xmllint` installed.

---

## Debugging

Server logs are printed to the terminal (stdout/stderr) with bracketed
prefixes like `[bot]`, `[server]`, `[rebalance]`, `[compound]`,
`[event-scanner]`. Use `--verbose` (`-v`) for additional per-cycle detail.

Browser console logs use the `[lp-ranger]` prefix with a colored log-type
signifier, e.g. `[lp-ranger] [scan]`, `[lp-ranger] [unmanaged]`.
High-frequency per-poll-cycle logs (`[poll]`, `[update]`, `[skip]`,
`[deposit]`) use `console.debug` and are hidden by default in Chrome
DevTools. To see them, open DevTools → Console → click the log-level
dropdown (defaults to "Default levels") and enable "Verbose".

### Node Debugger (Inspector)

For step-through debugging of `server.js` (dashboard + bot) or `bot.js`
(headless), use the `debug` / `debug-bot` npm scripts. Both launch the
Node inspector bound to `127.0.0.1:9229` &mdash; local-only by design.

| Script | Command | Use when |
| ------ | ------- | -------- |
| `npm run debug` | `node --inspect server.js` | Start a fresh dashboard + auto-started bot with the inspector pre-attached |
| `npm run debug-bot` | `node --inspect bot.js` | Start a fresh headless bot with the inspector pre-attached |
| `npm run debug-attach` | `node scripts/debug-attach.js` | Attach the inspector to an **already-running** dashboard server (no restart) |
| `npm run debug-attach-bot` | `node scripts/debug-attach-bot.js` | Attach the inspector to an **already-running** headless bot (no restart) |

`debug` / `debug-bot` use `--inspect` (not `--inspect-brk`) so the
process **starts running immediately** and you attach whenever.
`--inspect-brk` would freeze the bot loop until a debugger connects,
which is the wrong default on a Production box.

`debug-attach` / `debug-attach-bot` are the recovery / burn-in path:
they locate the running process (by listening port for the server, by
`pgrep` for the headless bot) and send `SIGUSR1`. Node treats that
signal as a request to start the V8 inspector on `127.0.0.1:9229`
&mdash; no restart, so a stuck-syncing state or in-flight rebalance is
preserved for inspection. Override the lookup with
`LP_RANGER_PID=<pid> npm run debug-attach` when multiple node
processes are running.

Both attach scripts share the heavy lifting via
`scripts/_debug-attach.js` (PID resolution, signal dispatch, connect
instructions); the leading underscore marks it as an internal helper.

#### Server vs bot: when each `debug-attach*` script applies

LP Ranger has two run modes that determine whether the bot is its own
OS process:

| Run mode | What's running | Which attach script applies |
| -------- | -------------- | --------------------------- |
| `npm start` | One Node process &mdash; `server.js` serves the dashboard AND auto-starts the bot **in the same V8 isolate** | `npm run debug-attach` (only). The single `server.js` target in `chrome://inspect` already exposes every bot module &mdash; set a breakpoint in `src/bot-loop.js`, `src/bot-cycle.js`, etc. on that target and it hits as the in-process bot polls. `debug-attach-bot` will correctly report "no node bot.js process via pgrep" because there is no separate bot process. |
| `npm run bot` | One Node process &mdash; `bot.js`, headless, no dashboard | `npm run debug-attach-bot` (only). |
| `npm start` AND `npm run bot` simultaneously (rare &mdash; two terminals) | Two Node processes that would both try to bind inspector port `9229` &mdash; the second one's inspector start fails silently and stays invisible in `chrome://inspect` | Start one of them with `INSPECTOR_PORT=9230` baked in (`INSPECTOR_PORT=9230 node --inspect-port=9230 bot.js`) so the two inspectors don't collide; then attach each on its own port. |

#### Connecting from `chrome://inspect`

1. Run `npm run debug-attach` (server) or `npm run debug-attach-bot`
   (headless bot). The terminal prints the PID it signalled and the
   default WS endpoint `ws://127.0.0.1:9229`.
2. Open `chrome://inspect` in a local Chrome / Chromium tab.
3. Under **Remote Target**, the Node process should appear within a
   second or two. Click the blue **inspect** link below it. A
   dedicated DevTools window opens connected to the process.
4. **Sources** tab &rarr; navigate the project tree (`src/`,
   `public/`, etc.) and set breakpoints. They hit on the next code
   path that runs (e.g. the next poll cycle for bot code).

Stale entries in the **Target discovery settings** dialog (e.g. a
`localhost:9222` left over from a prior session) are harmless &mdash;
no live inspector is bound to them and they will show no targets
underneath. Remove them with the X next to each entry or ignore them.

#### Log timestamp prefix

The `src/log.js` module exports an opt-in `log` object with `info` /
`warn` / `error` methods that prepend a UTC timestamp to every line
&mdash; `log.info("[bot] OOR but within 5% threshold")` emits
`[bot] [2026-06-16 20:32:02] OOR but within 5% threshold`. When the
first argument doesn't start with a `[tag]` prefix, the timestamp is
prepended bare. The browser-side dashboard ships an ES-module mirror
at `public/dashboard-log.js`.

The wrapper is **opt-in** &mdash; modules that want timestamped output
`require("./log")` and call `log.info(...)` instead of
`console.log(...)`. The global `console` object is **never modified**
(monkey-patching standard JS globals risks clashing with other
libraries and is a security concern). Existing `console.log` call
sites continue to work unchanged; migrate them to `log.info` as you
touch surrounding code.

#### Attaching from Chrome / Chromium DevTools

1. Open `chrome://inspect` in a Chrome or Chromium tab on the **same
   machine** running LP Ranger.
2. Under **Remote Target**, click **inspect** next to the Node target.
   DevTools opens with full Sources / Console / Profiler / Memory access.
3. If the target doesn't appear, click **Configure...** and confirm
   `localhost:9229` is in the discovery list.

#### Production debugging (Pi 5 over RealVNC)

Production runs with SSH disabled for security &mdash; all remote
access is via RealVNC. Debugging happens entirely inside the Pi's
RealVNC desktop session, with no port tunneling involved.

1. In the Pi terminal: stop the running LP Ranger, then `npm run debug`.
2. In the Pi's local Chromium: `chrome://inspect` → **inspect** under
   Remote Target.

The default `127.0.0.1` binding keeps the inspector unreachable from
the LAN. **Never** change the bind to `--inspect=0.0.0.0:...` &mdash;
that would let anyone on the network execute arbitrary code inside the
bot process, including signing transactions with the loaded wallet.

---

## Dependency Management

LP Ranger's npm dependencies flow through three distinct install modes,
each with a different posture on version pinning. Understanding which
mode you're in matters because one of them (production release) is a
**security boundary** — end-users install exactly the versions the
maintainer tested, with zero resolution latitude.

| Mode | Command | `package.json` ranges | Lockfile used? | Audience |
| ---- | ------- | --------------------- | -------------- | -------- |
| Development (feature work on `main`) | `npm install` | Caret `^` (e.g. `"csrf": "^3.1.0"`) | Updated opportunistically | Contributors |
| CI (every PR and push) | `npm ci` | Caret `^` | Yes, exact | GitHub Actions matrix |
| Production release (user install) | `npm ci` | **Exact** (e.g. `"csrf": "3.1.0"`) | Yes, exact + regenerated from pinned `package.json` | End users |

### Philosophy

The `"dependencies"` block in `package.json` is intentionally small
(9 packages as of this writing) so the review surface stays tractable.
Every runtime dependency is well-vetted:

- **Cryptography / tokens** — Node's built-in `crypto` module plus
  `csrf` (pillarjs, widely deployed behind Express).
- **EVM math** — `ethers` v6, `@uniswap/v3-sdk`, `jsbi`.
- **Concurrency** — `async-mutex`.
- **Config** — `dotenv`.
- **Client-side routing** — `navigo` (~5 KB).
- **Fonts** — `@fontsource/rye` (self-hosted, no CDN dependency).

Rolled-in-house crypto, lock, or EVM-math implementations are almost
always worse than the widely-deployed alternative, and a CVE in a
popular package is discovered and patched far faster than one in a
one-off module. When a direct dependency is genuinely small and
focused (a single function), we still prefer importing it over
copy-pasting, so dependency-bot updates apply.

### The Main Branch (Caret Ranges + Committed Lockfile)

During day-to-day development, `package.json` uses caret (`^`) ranges
for every entry. Caret ranges allow npm to pick any minor/patch version
compatible with the range at install time — so a contributor running
`npm install` on a fresh clone might get a slightly newer patch than
the last committed lockfile specifies.

The committed [`package-lock.json`](../package-lock.json) (lockfile
v3) pins the exact resolved graph that was tested at each commit.
**CI always uses `npm ci`**, never `npm install`, so every merge-gate
run installs the exact tree recorded in the lockfile. That's why the
three security-audit jobs, the pages build, and every matrix test job
begin with `- run: npm ci`.

**Lockfile regeneration is mandatory during development:** The
lockfile exists so every developer and CI run shares an identical
dependency tree — but it must be **periodically deleted and
regenerated** (`rm package-lock.json && npm install`) to pick up
patched transitive dependencies. A stale lockfile pins old versions
even when the parent's caret range already accepts a newer release.
Most `npm audit` findings in transitive deps resolve with a lockfile
refresh alone, no code change or override needed. This regeneration
is a development-only practice — production installs always use
`npm ci` against the committed lockfile.

### Overrides

Overrides are a **last resort**. Before adding one, delete
`package-lock.json` and run `npm install` — if the patched version
satisfies the parent's declared caret range, the lockfile
regeneration alone resolves the issue and no override is needed.
Only add an override when the parent's range genuinely excludes the
fix (an exact pin, a range ceiling, or a dependency that needs to be
neutralized entirely).

The top-level `"overrides"` object in `package.json` currently
contains two entries:

| Override | Reason |
| -------- | ------ |
| `@uniswap/v3-staker: 1.0.2` | The parent (`@uniswap/v3-sdk`) declares an exact pin `"1.0.0"`, not a caret range. npm cannot resolve `1.0.2` without the override. No advisory — just a minor bugfix version. |
| `@uniswap/swap-router-contracts` → `hardhat-watcher` → `hardhat: npm:empty-npm-package@1.0.0` | Hardhat is a ~200 MB Solidity compiler toolchain required as a peer dep by `hardhat-watcher`, which is itself a transitive dep of the Uniswap SDK. LP Ranger never compiles Solidity. This override replaces the entire package with an empty stub so nothing downloads. |

Each override decouples the dependency graph from upstream's own
review, so the rationale belongs inline in a commit message and in
this table. If you can remove an override by regenerating the
lockfile, do so — fewer overrides means fewer surprises.

### Production Releases

This is where the pinning discipline becomes a **security feature**.

#### The Release Workflow

`.github/workflows/release.yml` is the sole path for cutting a release.
It's `workflow_dispatch`-only (manual, no push triggers) and takes a
semver string as input. Summary of its steps:

1. **Checkout `main`** (never modified — release branches are siblings).
2. **Set up Node.js 24**, then **`npm ci`** (exact install from the
   committed lockfile — no range drift).
3. **`npm run check`** — full lint + test + coverage + security
   audit must pass. A failing main blocks the release.
4. **Create `release-x.y.z` branch** off main.
5. **Pin every dependency version** — an inline Node script walks
   `package.json`'s `dependencies` and `devDependencies`, reads the
   exact resolved version from `package-lock.json`, and rewrites each
   entry to a bare version string (no `^`, no `~`, no range).
6. **Add `.npmrc` with `save-exact=true`** — if the user ever runs
   `npm install <pkg>` after the fact, they get an exact pin rather
   than a caret range.
7. **Regenerate `package-lock.json`** via
   `npm install --package-lock-only --ignore-scripts` — so the
   lockfile's top-level ranges now match the pinned `package.json`.
   `--ignore-scripts` prevents lifecycle scripts from running during
   lockfile regeneration (relevant for supply-chain safety).
8. **Build the bundle** — `npm run build` produces `public/dist/bundle.js`.
9. **Bump `package.json` version** via `npm version --no-git-tag-version`.
10. **Commit** the pinned `package.json`, regenerated lockfile, the
    new `.npmrc`, and the built bundle to the release branch.
11. **Tag** `v<version>` and push tag + release branch.
12. **Create GitHub Release** from the release branch via
    `softprops/action-gh-release`; the generated source tarball is
    what end-users download.

The release branch exists **only** to carry the pinned artifacts —
`main` never sees the edit to `package.json`. This means:

- `main` keeps the caret-range ergonomics for contributors.
- Every release is reproducible from its exact tagged branch.
- If a release needs a hotfix, the `release-x.y.z` branch is
  modified directly and a new tag is cut; `main` is only touched for
  the underlying source fix.

#### What Ships in a Release Tarball

A user who downloads `lp-ranger-X.Y.Z.tar.gz` gets:

- `package.json` — every dependency version **exact**, not `^X.Y.Z`.
- `package-lock.json` — regenerated against that pinned
  `package.json`, so the entire transitive graph is also frozen.
- `.npmrc` — `save-exact=true`, so any subsequent local
  `npm install` also produces exact pins.
- `public/dist/bundle.js` — **prebuilt** browser bundle, so the
  user's machine never runs esbuild on potentially compromised source.
- All `src/`, `public/`, `docs/`, config — as committed to the
  release branch.

#### End-User Install Path

The [`Install` section of `README.md`](../README.md) prescribes
exactly two commands:

```bash
npm ci                    # install exact pinned dependencies
npm start                 # launch (pre-built bundle ships with the release)
```

`npm ci`'s guarantee is strict: **it fails** if `package.json` and
`package-lock.json` disagree on any version; **it refuses** to write
to `package-lock.json`; **it deletes** any existing `node_modules`
before installing. The result is that two users on two different
machines who install the same tagged release get byte-identical
`node_modules` trees.

`npm install` (the loose cousin) is explicitly discouraged in the
production path — a caret-range leak into a hypothetical `package.json`
could otherwise pull a newer patch that the maintainer never tested.

### Why This Is a Security Feature

Three distinct supply-chain attack classes that pinning closes off:

- **Compromised newer version.** An attacker who publishes a
  malicious patch release of a legitimate package (the
  `event-stream` / `ua-parser-js` / `colors.js` pattern) cannot
  reach end-users, because the pinned version was resolved and
  tested before the malicious release existed.
- **Version confusion / typo-squatting transitives.** A transitive
  dep's maintainer rotating ownership (or a squatter sliding in on
  a version range boundary) cannot slip in at install time — the
  lockfile's integrity hashes are verified by `npm ci` before any
  code runs.
- **Reproducibility gap.** A maintainer who tested
  `package@1.2.3-resolved-at-t0` and a user who installs at `t1`
  with caret ranges can end up with `package@1.2.7` —
  quietly-introduced behavioral differences become supply-chain
  mysteries. Pinning eliminates the gap so the tested graph equals
  the installed graph.

Combined with `npm audit --audit-level=high` running on every merge
(documented in [Security](#security) § Supply Chain & Dependencies)
and the `--ignore-scripts` flag during lockfile regeneration, the
end-user install is about as tight as npm's own tooling allows.

### Security Audits

`npm run audit:deps` (part of `npm run check`) runs
`npm audit --audit-level=high --json` and writes the full report to
`test/report-artifacts/raw-data/npm-audit.json`. The threshold is
`high` so pre-existing moderate advisories don't fail CI, but the
full severity breakdown (critical / high / moderate / low / info)
appears in the check-report summary and PDF so nothing at the
moderate tier sits unnoticed for long. See
[Security § `npm audit`](#npm-audit) for the detailed rationale on
the one currently-accepted ecosystem-wide advisory
(`elliptic` reachable transitively through `@uniswap/v3-sdk`).

The security audits run as three independent jobs in
`.github/workflows/security-audit.yml` (`audit:deps`,
`audit:security`, `audit:secrets`) so each one can be individually
required in branch protection.

### Lifecycle Script Controls

`package.json` declares two lifecycle scripts:

- **`postinstall: node scripts/copy-fonts.js`** — copies self-hosted
  WOFF2 fonts from `node_modules/@fontsource/*` into `public/fonts/`
  so the dashboard serves them without a CDN dependency. Runs on
  both `npm install` and `npm ci`.
- **`prepare: husky`** — installs the git hooks configured under
  `.husky/` (lint-staged Prettier pre-commit). This is developer
  tooling; end-user tarball installs run it harmlessly (no-op if
  `.husky/` is absent).

The release workflow regenerates the lockfile with
`npm install --package-lock-only --ignore-scripts` because that step
is purely metadata-shaping — actually executing `postinstall` during
lockfile regeneration would waste a minute and, more importantly,
would run third-party install scripts against a half-pinned graph.
The GitHub Pages workflow uses `npm ci --ignore-scripts` for the same
reason: it only needs `node_modules/@fontsource/*` as filesystem
inputs for the site assembly, not any script execution.

### Node.js Engine Requirement

`"engines": { "node": ">=22.0.0" }` in `package.json` pins the
minimum runtime. CI runs the Node 22/24 matrix on every PR, and the
release workflow uses Node 24 specifically. End users who try to
install on an older Node are told so by `npm ci` before anything
downloads.

### Dependency Inventory

**Production runtime (`"dependencies"`)** — 9 packages, all vetted
per the Philosophy section above:

- `@fontsource/rye` — self-hosted display font for the disclaimer modal.
- `@uniswap/v3-periphery` — V3 reference contract ABIs.
- `@uniswap/v3-sdk` — exact 160-bit sqrtPrice math
  (`maxLiquidityForAmounts`, `SqrtPriceMath`).
- `async-mutex` — rebalance lock.
- `csrf` — CSRF token generation/verification (pillarjs).
- `dotenv` — `.env` file loading.
- `ethers` — EVM math, address checksumming, transaction signing.
- `jsbi` — BigInt shim the Uniswap SDK requires for exact arithmetic.
- `navigo` — client-side router for deep-link URLs.

**Development and CI (`"devDependencies"`)** — tooling only, not
shipped to users at runtime:

- `eslint` (v10), `@eslint/js`, `globals`, `eslint-config-prettier`,
  `eslint-plugin-security`, `eslint-plugin-no-secrets` — ESLint flat
  config in [`eslint.config.js`](../eslint.config.js).
- `stylelint` + `stylelint-config-standard` — CSS linter.
- `html-validate` — HTML linter for `public/*.html`.
- `markdownlint-cli2` — Markdown linter.
- `prettier` — formatter (integrated via `eslint-config-prettier`).
- `secretlint` + `@secretlint/secretlint-rule-preset-recommend` —
  secret-leakage scanner.
- `husky` + `lint-staged` — pre-commit hook runner.
- `knip` — dead-code / unused-export detector.
- `esbuild` — browser bundler.
- `@scalar/api-reference` — Scalar OpenAPI renderer
  (`npm run api-doc`).
- `cli-table3` + `pdfmake` — check-report terminal tables and PDF
  generation.
- `@fontsource/space-mono` + `@fontsource/urbanist` — additional
  self-hosted UI fonts (dev-dep so they're copied at install time
  via `postinstall`).
