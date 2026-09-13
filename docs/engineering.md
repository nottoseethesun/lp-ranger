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
  - [Configuration Precedence](#configuration-precedence)
- [RPC Request Pacing and Log Chunking](#rpc-request-pacing-and-log-chunking)
- [USD Pricing](#usd-pricing)
- [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause)
- [Idle-Suppressed Polling Sounds](#idle-suppressed-polling-sounds)
- [Impermanent Loss Guard](#impermanent-loss-guard)
- [Poll-Result Recovery Signal](#poll-result-recovery-signal)
- [Balanced-Band Telegram Notification](#balanced-band-telegram-notification)
- [Dust Threshold](#dust-threshold)
- [Lifetime History Lookback](#lifetime-history-lookback)
- [Client-Side URL Routing](#client-side-url-routing)
- [Shared Help Copy](#shared-help-copy)
- [Development Tools](#development-tools)
  - [Build and Run](#build-and-run)
  - [Lint and Test](#lint-and-test)
  - [Wallet Management](#wallet-management)
  - [Housekeeping](#housekeeping)
  - [Utilities](#utilities)
    - [Diagnostic Utilities](#diagnostic-utilities)
      - [Verifying a Reported USD Figure](#verifying-a-reported-usd-figure)
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
- [`getPoolState` Validation + RPC Retry](#getpoolstate-validation--rpc-retry)
- [Closed-position Re-open Flow](#closed-position-re-open-flow)
- [Error Log & Reload Current Position](#error-log--reload-current-position)
- [Dead Code Detection](#dead-code-detection)
- [SVG Assets](#svg-assets)
- [CSS Class-Name Escapes](#css-class-name-escapes)
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

### Configuration Precedence

Three layers, lowest to highest. [`src/config.js`](../src/config.js)
composes them at startup and every consumer reads the result:

1. **Shipped default** — the single literal, in a tracked JSON file
   under `app-config/app-defaults-for-user-configurable/`.
2. **Operator override** — the matching file under
   `app-config/user-configurable/`, deep-merged over the shipped
   defaults by `loadMergedDefaults()`. Gitignored and
   tarball-upgrade-safe.
3. **Environment variable** — read from `.env`, layered on top of the
   merged result.

The layer that surprises people is the third. `.env.example` documents
only runtime flags and secrets, but `config.js` also accepts an env
override for most Bot Settings tunables, which is how a **headless
install sets them at all** — there is no Bot Settings panel to press
Save in when running `npm run bot` on a Raspberry Pi:

| Env var | Overrides |
| --- | --- |
| `REBALANCE_OOR_THRESHOLD_PCT` | `rebalanceOutOfRangeThresholdPercent` |
| `REBALANCE_TIMEOUT_MIN` | `rebalanceTimeoutMin` |
| `IMPERMANENT_LOSS_GUARD_PCT` | `impermanentLossGuardPct` |
| `SLIPPAGE_PCT` | `slippagePct` |
| `CHECK_INTERVAL_SEC` | `checkIntervalSec` |
| `MIN_REBALANCE_INTERVAL_MIN` | `minRebalanceIntervalMin` |
| `MAX_REBALANCES_PER_DAY` | `maxRebalancesPerDay` |
| `RESCAN_PRICES_DEFAULT_DAYS` | `rescanPricesDefaultDays` |
| `REBALANCE_RETRY_SWAP_LIMIT` | Consecutive swap-backoff retries before pausing |
| `DEADLINE_SEC` | Swap/mint transaction deadline |
| `TX_CANCEL_SEC` | Seconds before a stuck TX is cancelled at its nonce |
| `AGGREGATOR_URL` / `AGGREGATOR_API_KEY` | 9mm DEX Aggregator endpoint and key |
| `DRY_RUN`, `VERBOSE`, `POSITION_ID`, `ERC20_POSITION_ADDRESS` | Runtime flags — no JSON default |

A **per-position value saved in Bot Settings still wins over all three**.
The layers above decide only what a position that has never had a value
saved falls back to.

**Two rules follow from this, both learned the hard way:**

- A value that is both *displayed* and *acted on* must resolve through
  the **same expression**, not merely the same file. Two readers of one
  JSON file still disagree if one of them layers `.env` and the other
  does not — `IMPERMANENT_LOSS_GUARD_PCT=30` once showed 30 on the
  dashboard badge while the bot enforced 50.
- `GET /api/bot-config-defaults` serves `readBotConfigDefaults()` —
  layers 1 and 2 only, since the browser cannot see the server's
  environment. That endpoint fills a Bot Settings input **before the
  first `/api/status` poll arrives**; from the first poll onward the
  input shows the fully-layered figure, because `buildStatusPositions`
  spreads the env-aware `posDefaults` into every position payload. Do
  not mistake the pre-poll value for a second source of truth.

---

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

- `RPC_URL` — first JSON-RPC endpoint (default:
  `https://rpc-pulsechain.g4mm4.io`)
- `RPC_URL_FALLBACK` — second endpoint (default: `https://rpc.pulsechain.com`)
- `RPC_URL_FALLBACK_2` — third endpoint (default: `https://rpc.pulsechain.box`;
  free tier, 50 requests per 10 seconds per IP)

The shipped list lives in `chains.json` under `rpc.urls`; the three variables
override it positionally, so setting only `RPC_URL` leaves the endpoints behind
it intact. See
[RPC Request Pacing and Log Chunking](#rpc-request-pacing-and-log-chunking).

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

### Contract Addresses

**These are not editable from the dashboard, by design.** The Bot
Settings panel once offered Position Manager and Factory fields; they
have been removed. See [why](#why-contract-addresses-are-not-editable)
below.

The shipped addresses live in
`app-config/app-defaults-for-user-configurable/chains.json`, per chain:

```json
"contracts": {
  "positionManager": { "address": "0xCC05bf…", "mintGasLimit": 600000 },
  "factory": "0xe50Dbd…",
  "swapRouter": "0x7bE8fb…"
}
```

Canonical deployment addresses:
<https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json>

Two ways to override them, both read once at startup:

1. **`app-config/user-configurable/chains.json`** — deep-merged over the
   shipped defaults, gitignored, and preserved across upgrades.
2. **`.env`** — `POSITION_MANAGER`, `FACTORY`, `SWAP_ROUTER`. These win
   over both JSON layers.

In normal operation you should never set either. Only do so to point the
bot at a different deployment of the 9mm Pro V3 contracts.

#### Why contract addresses are not editable

Changing the Position Manager or Factory mid-life does not just change
where transactions go — it invalidates everything already on disk. Both
addresses are part of the scope key for every cache:

- the event cache (`event-cache-{chain}-{contract}-{wallet}-…`)
- the LP position cache (`lp-position-cache-{chain}-{contract}-{wallet}`)
- the epoch cache, keyed by `blockchain.contract.wallet.token0.token1.fee`
- per-position config in `bot-config.json`, keyed by a composite that
  includes the contract address

Change the address and every one of those keys stops matching. The old
entries are not wrong, they are simply unreachable — so the app would
rescan five years of history from scratch while the previous results sat
there orphaned, and any position keyed to the old contract would read as
missing.

**To change them, start from a fresh install of LP Ranger** rather than
editing an existing one: extract a new release into its own directory,
set the addresses there, and let it build its own caches. Do not carry
the old `app-config/user-configurable/` and `tmp/` contents across with
`migrate-app-state.js`, since those are exactly the files scoped to the
addresses you are leaving behind.

A `positionManager` or `factory` value left in an existing
`bot-config.json` from an older release is inert: nothing reads it, and
`POST /api/config` no longer accepts either key.

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

## RPC Request Pacing and Log Chunking

Two settings govern how LP Ranger talks to an RPC endpoint. Both live in
`app-config/app-defaults-for-user-configurable/bot-config-defaults.json`, both
are deliberately **absent from the dashboard**, and they only make sense as a
pair: the chunk size decides how many requests a scan produces, the interval
decides how fast they leave.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `getLogsChunkSize` | `7500` | Maximum block span per `eth_getLogs` call |
| `globalRPCRequestRateIntervalMS` | `250` | Minimum gap between *any* two requests |

They are not exposed in the GUI because they should never need changing in
normal operation, and they are not in `GLOBAL_KEYS`, so they never reach
`POST /api/config` or the OpenAPI schema. Override them by editing the file
under `app-config/user-configurable/` and restarting.

### Why chunking exists

RPC endpoints cap how wide a single log query may be. `rpc-pulsechain.g4mm4.io`
rejects anything over 10,000 blocks with JSON-RPC `-32602`, "eth_getLogs is
limited to a 10000 block range". A five-year history scan asks for ~15.8M
blocks, so without splitting, the query simply fails.

`src/get-logs-chunked.js` is the only place that arithmetic lives. Callers hand
it a range and a query function; it walks the range in capped windows. The
default of 7,500 is 75% of the strictest cap observed, and the margin is
deliberate: endpoint operators leave some limits unpublished on purpose, so an
observed ceiling is not a promise.

**Failures propagate.** A chunk that fails fails the scan, unless a call site
explicitly opts into `bestEffort`. Several scans used to swallow query errors
and return an empty array, which reads as "this wallet has no deposits" rather
than "we could not read" — the two lead to opposite conclusions, and that
confusion is what kept a real outage invisible. When an endpoint does reject a
range, the error names the span, the cap and this setting, instead of the raw
multi-line ethers dump that used to reach the Activity Log.

### Why pacing is global

Rate limits are published per IP, not per endpoint object or per scan. This
process may hold three providers and run a history scan while the bot polls, all
from one address. `src/rpc-request-manager.js` is therefore a single FIFO queue
for the whole process: every request enqueues and is released one at a time on a
fixed schedule.

It is **agnostic to request content** — it never inspects the method, the params
or the caller. That is the design, not an omission: a uniform release schedule is
the only thing that actually guarantees a rate, and every exception (a fast path
for reads, a priority lane for transactions) is a hole the rate escapes through.
If something needs to go sooner, the answer is a shorter interval.

It is wired in by `buildProvider` (`src/bot-provider.js`), which wraps ethers'
`send()` — the single funnel all JSON-RPC traffic passes through, reads and
writes alike. Anything added later is paced automatically, with nothing to
remember at the call site.

A per-chunk delay preceded this and could not do the job: a chunk fires two to
four queries in parallel, so a delay between chunks never bounded the request
rate it appeared to bound.

### Cost

Serializing removes parallelism, so scan time is roughly *requests x interval*.
A full five-year scan is ~2,100 chunks / ~4,200 requests, about 18 minutes at the
defaults. Raising `getLogsChunkSize` (up to the 10,000 cap) is the single lever
if that is too slow; lowering it is the fix if an endpoint rejects a query.

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

## Impermanent Loss Guard

A ceiling on how much value a position may have lost before the bot
stops rebalancing it. Before every **automatic** rebalance the guard
compares the hypothetical post-rebalance position against the USD value
of the NFT currently held, measured at that NFT's own mint, and rejects
the rebalance when the projection falls more than
`impermanentLossGuardPct` below it.

**Read-only by construction.** Both inputs are already computed earlier
in the same poll cycle — `snap.currentValue` plus `snap.residualValueUsd`
from `updatePnlAndStats`, and `hodlBaseline.entryValue` — so evaluating
the guard performs no chain read and sends no transaction. The gate runs
inside `_checkRebalanceGates` (`src/bot-cycle.js`), which returns before
`executeRebalance` is called, so there is no path from a rejection to
`decreaseLiquidity` or `collect`. A rejected position is left exactly as
it was found. `test/il-guard.test.js` drives the gate with a `deps` whose
provider and signer throw on any property access, so a future chain read
here fails the suite rather than shipping.

**Slippage is excluded.** A rebalance moves the same dollars from one
tick range to another, so the projection is the position's present worth:
its LP value plus the pool-scoped wallet residual that the rebalance
would fold back in. `entryValue` is likewise the minted position alone,
so the comparison is like for like.

**Two consequences.** A rejection can only clear on price — the baseline
is reset by `_updateHodlBaseline` when a rebalance mints a new NFT, so a
rejected position cannot rebalance, cannot mint, and cannot get a new
baseline. And it bites while the position is idle, since the guard only
comes up when a rebalance was due, which usually means the position is
out of range and earning nothing. Hence the loose shipped default of 50.

**Skipped for manual rebalances.** Like every other gate in
`_checkRebalanceGates`, a user-forced **Rebalance Now** bypasses it — and
that path already shows its own impermanent-loss confirmation.

**Fails open.** A guard percentage outside its bounds, a projection that
cannot be computed, or a baseline the mint scan has not resolved yet all
allow the rebalance and log why. Freezing the bot because a figure has
not finished loading would do more harm than the case being guarded
against.

**Retry backoff.** After a rejection the position is left alone rather
than re-decided every poll: 4 h, then doubling on each consecutive
rejection — 8 h, 16 h, 32 h — held at one week. The ladder resets the
moment the guard lets a rebalance through. The `ilGuardRejected` Telegram
alert rides the same timestamp, so a position blocked for a long stretch
reports on a widening interval instead of every `CHECK_INTERVAL_SEC`. The
backoff state (`_ilGuardRejectedAt`, `_ilGuardRejectCount`) is transient
per-position bot state, so a restart re-evaluates immediately.

**A rejection is not a rebalance.** `throttle.recordRebalance()` and
`_recordPoolRebalance()` both live in `_handleRebalanceSuccess`, reached
only after `executeRebalance` returns, so a rejected rebalance never
counts toward Max Rebalances / Day and never advances doubling mode.

**A rejection is not a recovery either.** An ILG rejection reports the
same shape as a quiet poll while meaning the opposite, which used to
raise a "Position Recovered" modal beside the block modal. See
[Poll-Result Recovery Signal](#poll-result-recovery-signal).

**Reported on screen as well as by Telegram.** A rejection would
otherwise be invisible: the position sits out of range, nothing happens,
and no reason is given. `_publishBlocked` emits `ilGuardBlocked` on the
FALSE→TRUE transition and nulls it when the guard next lets the position
through, so the common path adds no per-poll churn to `/api/status`.
What travels is the composed message, not the raw figures —
`_ilGuardMessage` writes the wording once and both channels use it, the
Telegram alert with a manual link appended and
`_showIlGuardModal` rendering each blank-line block as a paragraph via
`textContent`. Two hand-kept copies of those sentences drifted the
moment either was copy-edited.

**Config.** `impermanentLossGuardPct` (default 50) is a `POSITION_KEYS`
entry — per position, settable in Bot Settings → Execution, and shown as
a badge in Auto-Rebalance Settings. Its input bounds live beside it in
`bot-config-defaults.json` as `impermanentLossGuardPctMin` /
`impermanentLossGuardPctMax` (1 / 100), which are the single source for
the input's `min`/`max` (stamped on by `dashboard-init.js`), the Save
handler's clamp, and the server-side clamp — the same arrangement
`gasFeePctMin` / `gasFeePctMax` uses. `saveIlGuard` clamps to those
bounds and writes the clamped figure back into the field, matching
`saveOorThreshold`: a Save click always saves something and always shows
what it saved.

The shipped default layers env-over-JSON like every tunable around it
(see the `src/config.js` header): shipped default, operator override,
then `IMPERMANENT_LOSS_GUARD_PCT` on top. That layer is what makes the
setting reachable on a headless install, where there is no Bot Settings
panel to press Save in. `src/il-guard.js` reads the same
`config.IMPERMANENT_LOSS_GUARD_PCT` export for its own fallback, so the
badge and the enforced threshold resolve through one expression —
reading `bot-config-defaults.json` directly there is what made
`IMPERMANENT_LOSS_GUARD_PCT=30` display 30 while the bot enforced 50.

The Bot Settings input is not a third resolution path, despite prefilling
from `/api/bot-config-defaults`: `buildStatusPositions` spreads
`posDefaults` into every position payload, so the first `/api/status`
poll overwrites the box with the same `config.*` figure the badge and the
bot use. The endpoint value only paints the field in the moment before
position data arrives. Retry pacing is the server-internal
`ilGuardRetry` group (`baseMs`, `maxMs`), operator-tunable through the
layered defaults file only, like `residualCleanup`.

Note that `readConfigValue` returns `undefined` for a key never saved and
does **not** consult the layered defaults file — `src/il-guard.js` applies
the shipped default itself, the way `bot-cycle-opts.js` does for slippage
and approval multiple. Without that the guard would be inert on every
position until the user pressed Save.

## Poll-Result Recovery Signal

`_processPollResult` in [`src/bot-loop.js`](../src/bot-loop.js) decides
whether a poll means the position's price came back. When it says yes,
`_handleRecovery` clears `rebalanceError`, `rebalancePaused` and
`rebalanceFailedMidway`, and raises the **Position Recovered** modal.

It used to decide by elimination: a poll reporting no rebalance, no
error and no gas deferral was assumed to be a recovery. That inference
only holds if every "nothing happened" result names a reason, and five
shapes did not:

| Result shape | Returned by |
| --- | --- |
| `{rebalanced: false}` | throttle, pool daily cap, dry run, aborted-and-drained short-circuit, drain timer |
| `{…, withinThreshold: true}` | out of range but inside the OOR threshold |
| `{…, priceVolatile: true}` | volatile-price deferral |
| `{…, scanRunning: true}` | scan in progress |
| `{…, swapBackoff: true}` | swap backoff |

Every one read as a recovery. A position that was out of range and
blocked would be announced as recovered, and the error explaining why it
was stuck was discarded. Only `paused` and `retired` were ever guarded,
because those two were the cases someone happened to hit.

`isRecoveryResult` now asserts the signal instead of enumerating the
blockers:

```js
result.inRange === true &&
!botState.rebalanceFailedMidway &&
!botState.rebalancePaused
```

`inRange` is set by `_checkRangeAndThreshold`
([`src/bot-cycle.js`](../src/bot-cycle.js)), which runs **before** any
gate, so no blocked result can carry it. Adding a clause per gate would
have left the next gate to repeat the bug — which is how it reached
five. The two `botState` clauses stay: they hold a position that is back
in range but still mid-recovery or swap-aborted, and the second one is
what stops a paused-and-aborted position from clearing its own pause
flag and skipping its scheduled retire.

One accepted cost: when a residual-cleanup rebalance sets
`forceRebalance`, an in-range position skips the `inRange` return that
poll, so a pending recovery fires one cycle later.

The predicate is exported and driven directly by
`test/il-guard-gate.test.js`, one case per distinct result shape —
extracted from the `startBotLoop` closure for the same reason
`createBotPollScheduler` was.

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
(`CHAIN.displayName`), the user-friendly LP-provider name resolved by
looking up the configured (pool-factory + position-manager) pair in
`app-config/app-defaults-for-user-configurable/lp-providers.json` (e.g.
`"9mm v3"`) — the same single source of truth the dashboard NFT panel
reads via `GET /api/lp-providers`. Then the two token symbols
(truncated to 12 chars each, second line indented 4 spaces) and the
fee tier. The `lp-providers` map is keyed by
`<poolFactoryAddress>_<positionManagerAddress>` in EIP-55 checksum
casing so future v3+v4 coexistence on the same chain — and the same
factory+PM hash deployed on multiple chains via v3-fork clones —
resolve the correct name per position without restructuring.  Each
entry also carries a `supportedBlockchainsByLpRangerAndLpProvider`
array of canonical chain IDs (KEY of chains.json, e.g. `"pulsechain"`)
so the app can gate the label to the deployments we've verified. Range info, ticks, current price and the ratio
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

   The cache is **not** invalidated on rebalance. A successful
   rebalance sets `_needsFullRescan` (`src/bot-recorder.js`), and the
   30-minute `lifetimeRescanTimer` in `src/bot-loop.js` runs the event
   and lifetime scans together to pick up the newly-minted NFT's mint
   event. `clearPoolCache()` exists but runs only from the Reload
   Current Position handler (`src/server-reload-position.js`).

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

## Shared Help Copy

Some help text has to appear in two places at once: the circle-i dialog
beside a setting in Bot Settings, and the corresponding section of the
User Manual that GitHub Pages publishes. Written twice, the two drift on
the first copy-edit — and the Telegram alert links readers to the
published page, so a stale manual is what the operator reads when
something has already gone wrong.

[`public/shared-help-content.json`](../public/shared-help-content.json)
is the single source. Two consumers read it and neither holds its own
wording:

- [`public/param-help-content.js`](../public/param-help-content.js)
  imports it for the in-app dialog. The import needs the
  `with { type: "json" }` attribute — esbuild bundles a bare JSON import
  happily, but Node's native ESM loader, which the test suite uses to
  import the module directly, rejects it with
  `ERR_IMPORT_ATTRIBUTE_MISSING`.
- [`scripts/build-manual-content.js`](../scripts/build-manual-content.js)
  renders it into `public/help-and-user-manual.html` between per-entry
  marker comments, on every `npm run build`, `npm run lint` and
  `npm run check`:

```html
<!-- HELP:inIlGuard:START -->
...generated, do not edit...
<!-- HELP:inIlGuard:END -->
```

The manual is rewritten in place rather than generated as a separate
artifact the way `build-disclosure-content.js` does, because it is a
hand-written document that the Pages build copies verbatim — the
rendered section has to live in the file itself. The build is
idempotent, so running it twice produces the same file.

Two deliberate failure choices:

- A key in the JSON with no matching markers in the HTML is an **error**,
  not a silent skip. That combination means someone added shared copy
  expecting it in the manual, and it would never appear.
- Help entries are selected by **shape** — an object carrying a
  `sections` array — not by a naming convention. The file also holds
  `_comment` keys and `manualBaseUrl`, and an earlier
  "everything not underscore-prefixed" filter swept `manualBaseUrl` in
  and crashed the build the moment it was added.

`manualBaseUrl` plus an entry's `manualAnchor` is also where
[`src/il-guard.js`](../src/il-guard.js) builds the deep link its Telegram
alert carries, so the anchor exists in exactly one place. That read is
guarded: an unguarded `require` of a file under `public/` would let a
malformed help file take `bot-cycle` down with it and stop the bot from
starting at all. A missing or broken file degrades to an alert without a
link.

---

## Development Tools

All dev tools are available via npm scripts — no `npx` needed.

### Build and Run

- `npm run build` — esbuild bundle + cache-bust stamp (`bundle.js?v=<ms>`)
- `npm start` — Start server only (no build — use after `npm run build`)
- `npm run build-and-start` — Build + start in one command
- `npm run dev` — Build + start with `--watch` (auto-restart on file changes)
- `npm stop` (alias `npm run stop`) — Clean shutdown without switching to the server's terminal. Reads the server PID from `tmp/lp-ranger.pid` (written on startup by `src/server-pid.js`) and sends **SIGTERM** — the same handler as Ctrl+C, so it stops all managed positions, closes the HTTP server, and removes the PID file. Escalates to SIGKILL if the process does not exit within ~3 s, and falls back to an lsof-by-port lookup when no PID file is present. Both SIGINT and SIGTERM run the one `shutdown` handler in `server.js`.

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
- `npm run test:util` — Runs ONLY the `util/diagnostic/test/` suites,
  for a fast loop while working on a diagnostic tool. These suites also
  run as part of plain `npm test` and `npm run check`, and count toward
  the 80% coverage gate — `util/` is held to the same bar as `src/`.
  See [Diagnostic Utilities](#diagnostic-utilities).
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

### Previewing the Screenshot Gallery

```sh
npm run show-gallery
```

Serves the Screenshot Gallery at **<http://127.0.0.1:5557/screenshot-gallery.html>**
exactly as GitHub Pages will publish it. Independent of the dashboard
(port 5555) and the API reference (5556), so all three can run at once.

**Why a script is needed at all.** The gallery cannot be opened straight
off disk. Its three inputs live in three places — the page and CSS in
`public/`, the self-hosted fonts under `node_modules/@fontsource`, and
every screenshot in `docs/images/` — and the page references images as
`images/…`, which resolves next to the HTML rather than into `docs/`.
Opening `public/screenshot-gallery.html` in a browser therefore shows a
page with no images whatsoever.

[`scripts/build-pages-site.js`](../scripts/build-pages-site.js) assembles
those pieces into a target directory, rewriting the absolute CSS hrefs
(`/style.css`) to relative ones.
[`scripts/show-gallery.js`](../scripts/show-gallery.js) calls it with
`tmp/gallery-preview/` (gitignored) and serves the result. What you see
locally is what Pages will show — literally, because the deploy runs the
same builder.

It also lists any image the page references that is missing from
`docs/images/`, printed before the URL:

```text
[show-gallery] 2 referenced image(s) missing from docs/images:
  - dashboard-screenshot-bot-configuration.png
  - dashboard-screenshot-action-dialog-pool-details-3.png
```

A broken gallery is the exact failure this exists to catch, because the
page deploys publicly and nothing else validates that its `<img>` targets
resolve.

**One spec, one builder, two callers.** What gets published is declared
in [`.github/pages-site.yml`](../.github/pages-site.yml) — the pages,
each page's stylesheet, the shared absolute-to-relative href rewrites,
the flat assets, the fonts, and the directory trees. Nothing in that list
is restated in JavaScript: `build-pages-site.js` parses the spec and
executes it, so there is exactly one place to add a page or an asset.

The deploy workflow calls the same builder:

```yaml
- name: Assemble site
  run: |
    npm ci --ignore-scripts
    npm run copy-fonts
    node scripts/build-pages-site.js _site
```

This replaced a block of `sed` and `cp` inside the workflow that the
preview script mirrored in JS — the same page list in two languages,
free to drift, which is the one failure a preview exists to prevent.
Only the two genuinely-CI steps remain in YAML: `npm ci` and
`copy-fonts` populate `public/fonts/`, which the builder then copies. A
preview must not run those, because `npm ci` wipes and reinstalls
`node_modules`.

`readSpec()` throws on a missing or malformed spec rather than falling
back to a default. A silent partial build would publish a site with pages
or assets quietly absent, which is worse than a failed deploy.

When changing the assembly, verify equivalence rather than trusting it:
assemble with the old method and the new one into two directories and
`diff -r` them. That check caught a real error when the spec was
introduced — `disclosure.html` had been given `gallery.css` instead of
`help.css`.

The builder covers all three published pages — the gallery, the help and
user manual, and the disclosure — so the preview surfaces breakage in any
of them, not just the gallery.

**Filenames follow one convention:**
`dashboard-screenshot-<section>-<subject>[-<n>].png`, where `<section>`
matches a gallery heading (`general`, `bot-configuration`,
`action-dialog`, `settings-dialog`, `info-dialog`, `responsive`), and
`-<n>` appears only where a subject needs multiple frames, numbered from
1 with no gaps.

### Utilities

`util/` holds non-standard, ad-hoc Node.js tools, organized by purpose.
Sibling to `scripts/` (standard ops like `clean` and `nuke`). Every
subdirectory ships with the project and is held to the same gates as
`src/`: linted by `npm run lint`, formatted by `npm run format:check`,
audited by `npm run audit:security` and `npm run audit:secrets`, and
tested by `npm test` / `npm run check` against the same 80% coverage
floor.

**One target list, shared by every gate.** `scripts/lint-targets.js`
is the single source of truth for which files the lint, format, and
security passes cover: `JS_TARGETS`, `SECURITY_TARGETS`, and
`SECRET_TARGETS`. Both the npm scripts (via `scripts/format.js` and
`scripts/audit.js`) and `scripts/check.js` import from it, and the
husky pre-commit hook runs `npm run lint` rather than defining its own
checks. This is not cosmetic — every one of these lists had already
drifted: `check.js` omitted `util/` from the ESLint, security-lint, and
secretlint passes, so `npm run check` (the gate CI runs) covered 23
fewer files than the standalone commands, and the pre-commit hook
formatted JS that no gate ever verified. `test/lint-targets.test.js`
fails if a parallel list reappears.

**One file per utility, or a directory per utility.** A single-file
tool sits directly in its category directory (`util/diagnostic/
show-rebalance-chain.js`). The moment a tool needs a second file — because it
outgrew the 500-line cap, or because its pure logic wants isolating for
tests — it gets its own subdirectory named for the utility, with
`index.js` as the entry point so it still runs as `node
util/<category>/<utility>`. Never scatter a tool's parts as sibling
files with a shared name prefix. `verify-compound-usd/` is the
reference example: `index.js` (CLI, chain I/O, rendering) plus
`analysis.js` (pure math and formatting, no I/O). `reconcile-hodl/`
and `wallet-token-flow/` follow the same shape with `index.js` (CLI,
chain I/O, orchestration) plus `render.js` (console output only) —
the split that makes a report layer assertable by capturing stdout
instead of leaving it dark. Tests stay in the
category's `test/` directory regardless, since `npm run test:util`
globs `util/diagnostic/test/*.test.js`.

#### Diagnostic Utilities

`util/diagnostic/` holds read-only Node.js tools for investigating
on-chain state and bot data. End users run these when something looks
wrong. All five tools take CLI args, never mutate state, and write only
to stdout (redirect to `tmp/` for logs).

- `inspect-pool.js` — Pretty-prints `app-config/user-configurable/bot-config.json` and
  `tmp/pnl-epochs-cache.json` for a position or pool fragment: status,
  hodlBaseline, residuals, lifetimeHodlAmounts, fresh deposits.
- `show-rebalance-chain.js` — Walks position-manager `Transfer` events
  for a wallet over N years, listing every NFT mint/burn/move.
- `reconcile-hodl/` — Sums on-chain `IncreaseLiquidity` /
  `DecreaseLiquidity` / `Collect` across an NFT chain and compares to
  the cached HODL baseline. Run as `node util/diagnostic/reconcile-hodl`.
- `wallet-token-flow/` — Lists ERC-20 `Transfer` events for one or
  more tokens within a UTC date window, with net-flow summary. Run as
  `node util/diagnostic/wallet-token-flow`.
- `verify-compound-usd/` — Explains a reported liquidity-event USD
  figure. See [Verifying a Reported USD Figure](#verifying-a-reported-usd-figure).

Audited under `npm run audit:security` and `npm run audit:secrets` —
same bar as `src/`. Tests live in `util/diagnostic/test/` and run under
plain `npm test` and `npm run check` (use `npm run test:util` for a
fast loop on just these). Pure helpers shared across tools live in
`util/diagnostic/_helpers.js` — `sleep`, `addrTopic`, `addrFromTopic`,
`fmtTs`, and `fetchTimestamps` (the throttled block-time lookup both
the chain walker and the token-flow scanner need; it lived in two
places until it was consolidated here); console/exit/provider doubles for
driving the CLIs live in `util/diagnostic/test/_capture.js`. Each
tool's CLI `main()` is gated behind `require.main === module` so
requiring it from a test does not start an RPC scan — and each tool
exports its internals (renderers, scan loops) so those are testable
rather than dark.

##### Verifying a Reported USD Figure

`verify-compound-usd/` answers one question: a USD number the bot
reported — a "Compounded $X in fees" Telegram alert, an Activity-Log
entry, a `compoundHistory` row — does not match what the NFT actually
earned. Which input was wrong?

The bot never reads a compound's USD value from a price feed alone. It
multiplies three independent inputs, in `src/compounder.js`
`executeCompound`:

```text
usdValue = (amount0Deposited / 10^decimals0) × price0
         + (amount1Deposited / 10^decimals1) × price1
```

The amounts come from the `IncreaseLiquidity` event on the deposit TX,
the decimals from `poolState`, and the prices from
`deps._lastPrice0` / `_lastPrice1` — whatever
`src/bot-pnl-updater.js` `_fetchWithOverrides` last resolved for the
position, which is either the live price cascade or a per-position
manual price override. Any one of the three can be wrong on its own,
and each failure leaves a different signature. The tool re-derives all
three from the chain and from live price sources, then reports which
one has to be wrong to produce the reported figure.

The figure matters beyond the alert text. `recordCompound` in
`src/bot-cycle-compound.js` adds the same `usdValue` to the position's
`totalCompoundedUsd`, which is half of the dashboard's lifetime
fee-earnings figure (`currentFeesUsd + totalCompoundedUsd`, see
`src/ui-state.js`). That total is only ever accumulated incrementally
once disk holds a non-zero value — the on-chain rescan in
`src/bot-recorder-lifetime.js` is deliberately gated off by
`_resolveDiskState`. A bad compound figure therefore persists in
lifetime P&L until it is corrected by hand.

What the tool does:

1. Resolves the position — a composite key or unambiguous fragment
   from `app-config/user-configurable/bot-config.json`, or a bare
   `--token-id` when the config lives on another host.
2. Reads pool identity from chain via `positions(tokenId)`, then
   `decimals()` and `symbol()` on both tokens. Decimals always come
   from the contracts, never from config — a wrong cached decimal is
   one of the failure modes being tested for.
3. Scans a bounded block window (default 30 days) for that NFT's
   `IncreaseLiquidity`, `DecreaseLiquidity`, `Collect`, and mint
   (`Transfer` from the zero address) events.
4. Labels each `IncreaseLiquidity` as mint / compound / rebalance
   re-deposit by reusing the production classifier
   (`_filterRebalances` from `src/compounder.js`), so the labels match
   the bot's own bookkeeping.
5. Prices every event at live USD, printing Moralis, GeckoTerminal,
   and DexScreener separately alongside the cascade result so a single
   divergent provider is visible.
6. Compares against the recorded `compoundHistory` rows when the
   config is present.
7. Runs hypothesis checks on any gap.

Reading the hypothesis block:

- **implied price0 / price1** — the price one token would have needed,
  holding the other at its live value, to produce the reported figure.
  A ratio near `1.00x` clears that token; a large ratio names the bad
  input. A negative implied price means that token alone cannot
  explain the figure.
- **uniform price scale** — the factor both prices would need. Near a
  round number (`10x`, `100x`) this points at a decimals or unit
  mix-up rather than a price feed.
- **decimals shift** — every `(decimals0, decimals1)` pair within ±4
  that reproduces the reported figure to within 5%. A hit means the
  amounts were divided by the wrong power of ten. Cross-check against
  the decimals heal / override path in `src/bot-recorder-lifetime.js`
  and the `decimalsOverride0` / `decimalsOverride1` /
  `decimalsOverrideForce0` / `decimalsOverrideForce1` config keys.

`compoundHistory` spans the whole rebalance chain, not one NFT. It is
stored per *position*, and a position's composite key follows the live
NFT across rebalances, so the array accumulates rows for every tokenId
the chain has ever had. Rows recorded against a sibling NFT are
reported as such, with the exact `--token-id` rerun command — not as
missing events, which would read as though the bot had invented
compounds that never happened.

When a `compoundHistory` row is available the diagnosis is exact,
because the row stores the `price0` / `price1` the bot actually used.
Two discriminators, in order:

- Recorded amounts differ from the chain's `IncreaseLiquidity` amounts
  → the bot recorded the wrong event. Rare.
- Recorded amounts match, and chain amounts × recorded prices
  reproduce the stored `usdValue` → the arithmetic was faithful and
  the **prices** were wrong. Check whether `priceOverride0` /
  `priceOverride1` / `priceOverrideForce` are set on the position
  (`inspect-pool.js` prints them); otherwise the live cascade returned
  a bad value and the per-source table says which provider to
  distrust.
- Recorded amounts match but the recorded prices do **not** reproduce
  the stored figure → the **decimals** were wrong. The tool then
  re-runs the decimals-shift search against the recorded prices, which
  removes price drift and names the exact pair that was used.

Options:

| Option | Effect |
| ------ | ------ |
| `--token-id <id>` | Verify a bare NFT id; skips the config lookup entirely. Use on a host that does not have the position's `bot-config.json`. |
| `--usd <amount>` | A reported figure to explain. Runs the hypothesis checks against every in-window event even when no config row is available. |
| `--days <n>` | Scan window in days (default 30). |
| `--from-block <n>` | Explicit window start; overrides `--days`. |
| `--moralis-key <key>` | Include the bot's primary price source. Prefer the `MORALIS_API_KEY` environment variable — a key passed as an argument is visible in shell history and to `ps`. The key is never printed or logged. |
| `--help` | Usage summary. |

Examples:

```bash
# Explain a Telegram alert for a position in the local config:
node util/diagnostic/verify-compound-usd 162980 --usd 240.10

# Same NFT from a machine that does not have that position's config:
node util/diagnostic/verify-compound-usd --token-id 162980 \
     --usd 240.10 --days 7

# Include the primary price source:
MORALIS_API_KEY=… node util/diagnostic/verify-compound-usd 162980
```

Caveats:

- Live prices are *today's*. A figure reported days ago is compared
  against current prices, so a genuine market move shows up as a
  modest ratio. Investigate the large ones; a `1.2x` is probably drift.
- Moralis is the bot's primary source but needs an API key. Without
  one the tool reports it as unavailable rather than as `$0`.
  GeckoTerminal and DexScreener are keyless and usually bracket the
  true price well enough.
- When the mint predates the scan window the tool says so and
  classifies conservatively: with no in-window mint, no
  `IncreaseLiquidity` is labelled `mint`. Widen with `--days`.
- Never scans from block 0 — the window is always bounded by `--days`
  or `--from-block`.

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

#### Update Utilities

`util/update/` holds tools that support the release-to-release upgrade
procedure documented in README.md &sect; Update.

- `migrate-app-state.js` &mdash; Step Six of that procedure: copy an
  existing install's operator state (`.env`, `app-config`, `app-data`,
  `tmp`) into a freshly extracted release. Run from inside the new
  install; it finds the old one by looking for a single sibling
  `lp-ranger-*` directory, or takes `--from <dir>` when there is more
  than one. `--dry-run` reports without writing.

  Copies are strictly no-clobber, so a release can change a shipped
  default without an old file silently overwriting it, and the old
  install is never modified &mdash; it remains a rollback.

  It replaced a hand-typed `cp -rn`, which failed two ways. `cp` is a
  Unix command, so Windows operators had to be sent to Git Bash for one
  line of an otherwise cross-platform procedure. And excluding
  `node_modules` from it required `shopt -s extglob`, which does not
  exist in zsh &mdash; the default shell on macOS &mdash; and which is
  applied at parse time, so the two lines break if joined with `;`.

  **Node built-ins only.** It runs before `npm ci` in the update
  procedure, so `node_modules` may not exist yet and this tool must not
  require anything from it. Tests live in `test/migrate-app-state.test.js`,
  following `util/cache/`'s placement rather than a category `test/`
  directory, so `npm test` and the coverage gate pick them up without a
  new glob.

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
│   │   ├── lp-providers.json   ← LP-provider metadata keyed by <factory>_<positionManager>
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
| `slippagePct` | `0.75` | Per-swap slippage tolerance applied to the quoted output |
| `checkIntervalSec` | `300` | On-chain poll cadence |
| `minRebalanceIntervalMin` | `10` | Minimum gap between back-to-back rebalances on the same pool |
| `maxRebalancesPerDay` | `5` | Per-pool daily rebalance cap (UTC reset; every successful rebalance counts) |
| `offsetToken0Pct` | `50` | Position offset bias toward token0 (50 = balanced) |
| `impermanentLossGuardPct` | `50` | Most a position may have lost before the bot stops rebalancing it — see [Impermanent Loss Guard](#impermanent-loss-guard) |
| `gasFeePct` | `1` | Gas-cost ceiling as a percent of position value |
| `rangeOverrideEnabled` | `false` | Bot Settings → Range "No Override" toggle. `false` re-uses the position's existing on-chain range |
| `rebalanceRangeWidthPct` | `80` | Value the Price Range Extension row's "Default" button applies. Not auto-populated into the input |
| `fullRangeRebalanceEnabled` | `false` | Mint the next rebalance across the full tick range |
| `rescanPricesDefaultDays` | `60` | Lookback the Re-scan Prices dialog offers by default |

**Validation bounds.** These are not settings — each pair is the single
source for one input's `min`/`max`, the dashboard Save handler's clamp,
and the server-side normalizer in
[`src/bot-config-defaults.js`](../src/bot-config-defaults.js). The
dashboard reads them from `GET /api/bot-config-defaults` and stamps them
onto the input at init, which is why no `min`/`max` literals appear in
`public/index.html`.

| Key | Default | Bounds for |
| --- | --- | --- |
| `impermanentLossGuardPctMin` / `Max` | `1` / `100` | `impermanentLossGuardPct` |
| `gasFeePctMin` / `Max` | `0.1` / `15` | `gasFeePct` |

**Server-internal (top-level keys, no UI):**

| Key | Default | Description |
| --- | --- | --- |
| `priceCacheTtlMs` | `120000` | In-memory token-price cache TTL — see [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause) |
| `dustUnitPriceCacheMultiplier` | `30` | Dust-unit-price TTL as a multiple of `priceCacheTtlMs` |
| `moveCacheTtlMs` | `4000` | Cache TTL for the fresh-price window around a rebalance or compound |
| `pricePauseExceptionPollWindowMultiple` | `10` | Poll cycles between the balanced-band notifier's fresh-price probes |

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

**`ilGuardRetry`** — paces retries of a rebalance the Impermanent Loss
Guard has rejected, in [`src/il-guard.js`](../src/il-guard.js). Not
exposed in the UI. Both ends are clamped to a one-minute floor, so a
mistyped value cannot turn the guard into a per-poll retry.

| Key | Default | Description |
| --- | --- | --- |
| `baseMs` | `14400000` | First retry delay (4 h) |
| `maxMs` | `604800000` | Ceiling the doubling ladder holds at (7 days) |

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
callers (e.g. `curl`) send no `Origin` header and pass
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
command-injection vector. The stop path's `child_process` use is the
`lsof` / `ps` port-lookup in `scripts/_find-process.js` (reached from
`scripts/stop.js`'s no-PID-file fallback); its command and arguments are
hardcoded constants with no user input reaching them. The rule stays on
so that any future `spawn` / `exec` call is flagged for review.

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
left hanging — a programmatic shutdown option. The usual operator path is
`npm stop`, which sends SIGTERM to the PID in `tmp/lp-ranger.pid` (the same
`shutdown` handler as Ctrl+C); see the "Build and Run" section.

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
  `scripts/**/*.js`, and `npm run audit:security` runs
  `scripts/audit.js --security` over `SECURITY_TARGETS` from
  `scripts/lint-targets.js`.
- **Secret scanner** (`secretlint`) — `npm run audit:secrets` runs
  `scripts/audit.js --secrets` over `SECRET_TARGETS` from the same
  file.
- **Prettier** — `format` and `format:check` both run
  `scripts/format.js`, which reads the one target list in
  `scripts/lint-targets.js`; `npm run lint` calls `format:check`, and
  the pre-commit hook runs `npm run lint`.

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

Hand-maintenance drifts on its own, so
[`scripts/check-openapi-sync.js`](../scripts/check-openapi-sync.js) runs
as a gate in both `npm run lint` and `npm run check` — see step 7 below.
It is what makes step 8 enforceable rather than aspirational.

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
     `Compound`, `System`, `UI`, `API Keys`, `Telegram`,
     `Price Lookups`). Add a new tag if the route doesn't fit any
     existing category, and declare it in that array — a tag used
     without a declaration still groups routes in the rendered page,
     but with no description, so the omission is invisible.
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
7. **Run `npm run check`.** Three gates cover the spec:

   - `prettier --check "**/*.json"` — formatting.
   - **`openapi-sync`** — its own row in the check summary, run from
     [`scripts/check-openapi-sync.js`](../scripts/check-openapi-sync.js)
     and also part of `npm run lint`, so the pre-commit hook catches
     drift before it reaches CI. It enforces that every registered
     route is documented, every documented route still exists, every
     key `POST /api/config` accepts appears in its schema (read from
     the real `POSITION_KEYS` / `GLOBAL_KEYS` allowlists), every
     operation has a summary and at least one response, and every tag
     is both declared and used. On failure it names each mismatch.
   - [`test/openapi-coverage.test.js`](../test/openapi-coverage.test.js)
     — drives that same checker against mutated in-memory copies of the
     spec, so a rule that gets quietly dropped fails a test instead of
     silently passing everything.
8. **Commit the spec change in the same commit as the route change**
   — this keeps the spec and the implementation from drifting in
   reviewable diffs.

Routes matched by URL pattern rather than by a `"METHOD /path"` handler
entry — today only `GET /api/position/{tokenId}/history` — are invisible
to the coverage test's scan, so they are allowlisted by name in
`DYNAMIC_ROUTES` at the top of that test. A second dynamic route has to
be added there deliberately.

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
3. **Atomic re-open.** The intro modal's **Re-open Position** button
   POSTs directly to `/api/position/manage` (NOT `/api/rebalance`,
   which requires a running bot loop) with
   `{ tokenId, contract, forceRebalance: true }`. Range width is not
   in the body: the bot reads `rebalanceRangeWidthPct` from the
   position's saved config (Bot Settings > Range); if
   nothing is saved, the rebalancer preserves the on-chain tick
   spread via `preserveRange()`. `liquidity` is deliberately omitted:
   `handleManage`'s autoCompound-default branch keys off
   `body.liquidity === "0"` and would persist
   `autoCompoundEnabled: false`, wrong for an actively-managed
   re-open. `handleManage` stamps `forceRebalance` on the fresh
   `posBotState` BEFORE starting the bot loop (via
   `_stampReopenFlags`), so the bot's first `pollCycle` sees the flag
   and `bot-cycle-drain.js`'s drain guard lets the rebalance pipeline
   run on the drained NFT in lieu of arming a new 30-min retire
   timer.
   If the position is ALREADY running (e.g. the user comes back to
   Manage after a prior re-open's swap aborted on slippage),
   `handleManage`'s "already running, skipping" short-circuit instead
   routes through `_stampReopenFlagsOnLive`, which stamps the flag
   onto the live posBotState AND clears
   `rebalancePaused` / `rebalanceFailedMidway` / `rebalanceError` so
   the next poll runs a fresh rebalance. Liquidity flips from 0 to
   positive; position is alive again.

   The old three-step flow that opened a separate "Rebalance with
   Range" modal to collect a per-rebalance width is gone; range width
   is now a persistent Bot Settings field. See PR #146 for the
   migration.

When `!canReopen`, the dashboard shows a single-button modal listing
the current per-token wallet balances + the dust threshold so the
user knows exactly what they need to fund. No state change.

UI state for closed positions is also inverted from the prior
catch-22: **Rebalance is disabled** (cannot rebalance a drained NFT
directly &mdash; there's no liquidity to remove), **Manage is enabled**
and routes through the flow above. See `public/dashboard-data.js`
`_updateRebalanceButtons` and `public/dashboard-manage-badge.js` for
the button-state logic.

## Error Log & Reload Current Position

Together these are the escape hatch for the single class of failure
where a silent `catch` on the server side leaves persisted state
subtly wrong &mdash; the initial pool-wide lifetime scan aborting
before anything hits disk. That's the failure mode that produced the
July 2026 Prod discrepancy where `Fees Compounded` for a PulseX/WPLS
position showed $11.63 instead of the correct ~$255.50: the disk
config's `totalCompoundedUsd` had been populated entirely by a single
runtime auto-compound event because `_classifyAllCompounds` never
persisted anything.

### logs/error.log

**Owner:** `src/error-log.js` &mdash; `writeErrorLog(err, context)`.

**Location:** `logs/error.log` relative to the process CWD, same
directory as the diagnostic `lp-ranger.log` produced by
`src/log-file.js`. Auto-created on first append; gitignored via the
project-wide `*.log` rule.

**Entry format:**

```text
<four blank lines>
[YYYY-MM-DDTHH:MM:SS.sssZ] <context line>
<err.stack>
```

The four-line gap is deliberate. The file is meant to be scanned by a
human weeks or months later; a huge blank margin makes a new incident
unmissable when the file is opened for the first time in a while.

**Scope: catastrophic failures only.** The current callers are
`_recordScanFailure` and the token-decimals heal (`_ensureTokenDecimals`),
both in `src/bot-recorder-lifetime.js`. Do NOT add `writeErrorLog()` calls
to routine `catch` blocks, retry handlers, or expected transient errors.
Every added surface dilutes the "unread error.log &rArr; nothing
catastrophic has happened" invariant that makes the file useful.

`writeErrorLog` never throws &mdash; a filesystem failure while
trying to record another failure returns `false` and the caller
proceeds; a broken log path must not cascade into another catastrophic
error.

**Lifecycle &mdash; deleted on startup, self-clearing on heal.** The file
holds only the CURRENT session's failures. `resetErrorLog()` &mdash; called
from the `require.main === module` startup guard in `server.js` and `bot.js`
&mdash; **deletes** `error.log` on every restart (no rotation, no archive),
logging a one-line confirmation to the console on success. Any problem still
current is re-logged by the scans on the next run; a problem since fixed
simply never re-appears. On top of that, `clearErrorLog(matchSubstring)` lets
a self-healing failure remove its own entries the instant it resolves: the
token-decimals heal writes a `[token-decimals] scope=<token0_token1_fee>`
entry when a token's decimals are unreadable on-chain and no manual override
is set, then clears every entry for that pool scope the moment the decimals
resolve (on-chain read succeeds, or the operator supplies a **Pool Details**
decimals override). Net invariant: `error.log` never carries a stale or
already-fixed error.

### `_catastrophicScanError` bot-state flag

Set by `_recordScanFailure` on the position's bot state alongside the
`writeErrorLog` call:

```js
botState._catastrophicScanError = { message, at, tokenId, logPath };
```

Cleared by `_recordScanSuccess` on the next successful lifetime scan
&mdash; that's what dismisses the dashboard's red modal once the
Reload Current Position flow completes.

Flows through `/api/status` &rarr; per-position state &rarr;
`public/dashboard-alerts.js` `_showCatastrophicModal`, which paints a
red modal (`.9mm-pos-mgr-modal-danger`) directing the user to Settings
&rarr; Reload Current Position. Dedup is per-position-key; a dismiss
keeps the modal down until the server clears the flag, at which point
it can fire again on a fresh failure.

### `POST /api/position/reload`

**Owner:** `src/server-reload-position.js` &mdash;
`createReloadPositionHandler(deps)`. Wired into
`server-routes.js` and registered as
`"POST /api/position/reload"` in `server.js`.

**Body:** `{ positionKey }`. CSRF-gated like every other write route.

**In-progress guard:** If the target position has `_scanRunning`,
`rebalanceInProgress`, or `compoundInProgress` set on its bot state,
the handler returns `409 Conflict` with `{ error, message }`
describing which operation is running. The three error codes are:

- `scan-in-progress` &mdash; a full lifetime scan is already running.
  Starting a second one is not queued because `_triggerScan` gates on
  `_scanRunning` and would no-op silently, leaving the reload's state
  clears in place while the pre-existing scan writes stale results
  back to disk. User waits for the current scan to finish (up to
  four hours) and clicks Reload again.
- `rebalance-in-progress` / `compound-in-progress` &mdash; the position
  is mid-TX. Reload would race the transaction and either corrupt the
  state reconstruction or step on the tracker mid-write.

Every 409 falls through to the same yellow retry modal on the client
(`_showReloadBusyModal` in `dashboard-events-manage.js`), so all
"busy" outcomes look identical to the operator. The dashboard's
Reload button is also disabled by `paintReloadPositionButton`
whenever `rebalanceInProgress` or `compoundInProgress` is truthy on
the currently-viewed position; the button is NOT tied to
`_scanRunning` because a normal startup or post-rebalance scan
should not permanently disable the escape hatch.

**Steps on success:**

1. Cancel any in-flight event scan for the pool
   (`cancelPoolScan(token0, token1, fee, wallet)`).
2. Delete the following on-chain-derived keys from the position's
   disk config, then save via `saveConfig`:
   `compoundHistory`, `totalCompoundedUsd`, `collectedFeesUsd`,
   `nftCompoundedUsdByTokenId`, `nftGasWeiByTokenId`, `hodlBaseline`,
   `lifetimeHodlAmounts`, `totalLifetimeDepositUsd`. The
   canonical list is `_ON_CHAIN_DERIVED_KEYS` in
   `server-reload-position.js` (exported for tests).
3. Clear the pool's entry in the epoch cache
   (`_epochCache.clearCacheEntry(keyOpts)`) so the fresh scan starts
   from pool creation block instead of the stale `lastNftScanBlock`.
4. Clear the pool's event cache file (`clearPoolCache(position, wallet)`).
5. Reset the same fields on the live bot state and set
   `_needsFullRescan = true`, `_needsEpochRebuild = true`,
   `_catastrophicScanError = null`, `lifetimeScanComplete = false`,
   `rebalanceScanComplete = false`, `totalLifetimeDepositUsd = 0`. See
   `_resetBotState` in `server-reload-position.js`.

   `_needsEpochRebuild` is what makes step 3 mean anything. Clearing
   the cache on disk is not enough on its own: the bot loop holds its
   epochs in memory, so the completeness guard in `reconstructEpochs`
   saw a full history, returned without doing any work, and the next
   poll wrote the untouched set straight back over the cleared file.
   Reload cleared a copy that memory restored seconds later, and no
   correction to how an epoch is derived could reach an existing
   install without hand-editing a cache file. The flag is consumed
   once by `_consumeRebuildRequest` (`src/epoch-reconstructor.js`),
   which also drops the tracker's closed epochs so a rebuild that
   fails leaves nothing stale behind — the next scan then sees an
   incomplete history and retries on its own. Deliberately not
   `_needsFullRescan`, which every rebalance sets; reusing that would
   rebuild the whole chain from scratch after each one.
6. `state._triggerScan()` &mdash; called synchronously and deliberately
   not awaited. An async function's body runs to its first `await`
   synchronously with its caller, so `_scanRunning` is set before the
   endpoint returns 200 and the rebalance/compound gates below engage
   before any later poll can land. The returned promise is dropped so
   the HTTP response does not wait on a scan that runs for minutes.
7. Respond `200 { ok: true, message: "Reload started", liveKey }`.

**Not called by any bot code path.** Reserved for the user's escape
hatch.

### Rebalance / compound suppression during the reload window

While a scan is running (`_scanRunning === true`), the bot must not
rebalance or auto-compound the same position &mdash; that would race
the state reconstruction and re-corrupt the numbers the reload is
trying to fix. Instead of a bespoke `reloadInProgress` flag, the
suppression rides on the existing `_scanRunning` flag that
`_triggerScan` already sets:

- **Auto-rebalance:** `_checkRebalanceGates` in `src/bot-cycle.js`
  returns `{ rebalanced: false, scanRunning: true }` when
  `!forced && _botState._scanRunning`. Manual (`forced === true`)
  rebalances still bypass so a user who clicks Rebalance during a
  scan is not silently ignored.
- **Auto-compound:** `checkCompound` in `src/bot-cycle-compound.js`
  early-returns `false` when `!forced && botSt._scanRunning`. Manual
  compound (`forceCompound === true`) still runs.

The invariant applies to every scan &mdash; not just reloads &mdash;
so a startup scan, a rebalance-triggered rescan, and a Reload
Current Position scan all get the same protection.

### Dashboard flow (`public/dashboard-events-manage.js`)

`_reloadCurrentPosition`:

1. Read the active position from `_posStoreRef.getActive()`. Bail if
   nothing is active.
2. Defense-in-depth guard: read `rebalanceInProgress` /
   `compoundInProgress` from the last poll and short-circuit with an
   `alert()` if either is set (matches the server's 409 rejection).
3. Show the blocking modal (`_showReloadBlockingModal`). Uses class
   `9mm-pos-mgr-blocking-overlay` (deliberately NOT `modal-overlay`)
   so the global Escape-key handler cannot dismiss it; the whole
   point is that the UI stays locked until the page reloads.
4. `POST /api/position/reload` with the composite key. On a non-OK
   response, remove the overlay, re-enable the button, and
   `alert()` the server's user-facing message (`body.message` when
   present, falling back to `body.error` or HTTP status).
5. Reset client-side caches (`resetHistoryFlag`, `clearHistory`,
   `resetLastFetchedId`) so the eventual page reload lands on a
   clean surface.
6. Poll `/api/status` at 3 s intervals via `_waitForReloadCompletion`
   until one of:
   - `lifetimeScanComplete === true` on the target position &rarr;
     `outcome = "complete"`.
   - `rebalanceInProgress` or `compoundInProgress` becomes truthy on
     the target position &rarr; `outcome = "raced"`. This is the
     ~500 ms race between the reload endpoint returning 200 and
     `_triggerScan` setting `_scanRunning=true`; a poll cycle that
     lands in that window can start an auto-rebalance / auto-compound
     before the gate engages. The reload dismisses the blocking
     overlay and shows a yellow caution modal
     (`_showReloadRaceModal`) telling the user to wait for the
     operation to finish and click Reload again. No page reload &mdash;
     the server left the position untouched (the racing operation
     owns its own writes) and a refresh would show the same state.
   - A brand-new `_catastrophicScanError` with `at > startedAt` on
     the target position &rarr; `outcome = "failed-again"`. Falls
     through to the page reload so the user sees the fresh red modal.
   - Four hours elapse &rarr; `outcome = "timeout"`. Falls through
     anyway; the fresh page shows the Syncing badge and the 30 min
     recovery loop takes over from there.
7. `window.location.reload()` for every outcome EXCEPT `raced`
   (which dismisses to the retry modal and leaves the tab alone).

`paintReloadPositionButton()`:

- Runs every poll from `dashboard-data.js`.
- Disables `#reloadPositionBtn` with a per-condition tooltip when the
  active position has `rebalanceInProgress` or `compoundInProgress`
  set on its bot state. Enables + restores the default tooltip
  otherwise.
- Same source flags as the Mission Control status badge, so the two
  surfaces always agree.

### `POST /api/position/rescan-prices`

The narrow counterpart to `POST /api/position/reload`. Every USD figure
is `amount x price`; the amounts come from chain and are reliable, but
`src/price-source-cascade.js` accepts the first source returning any
positive number, with no plausibility check. One bad response therefore
lands in `compoundHistory[].usdValue` and `totalCompoundedUsd` — and
`_resolveDiskState` in `src/bot-recorder-lifetime.js` deliberately
refuses to rebuild those from chain once disk holds a non-zero value,
so the bad figure is permanent until something clears it.

Reload clears it but re-walks the pool's whole Transfer history (minutes
to hours). This route clears **only** the four price-derived keys
(`compoundHistory`, `totalCompoundedUsd`, `collectedFeesUsd`,
`nftCompoundedUsdByTokenId`), rewinds the NFT event watermark to the
start of a bounded window, and calls `_triggerScan` so the existing
lifetime scan re-values immediately. `hodlBaseline`,
`lifetimeHodlAmounts` and `totalLifetimeDepositUsd` are preserved —
keeping those is the entire cost advantage.

Body: `{ positionKey, days }`. `days` omitted or `null` means the whole
history, which resolves to the pool creation block, never zero. The
default window ships as `rescanPricesDefaultDays` in
`bot-config-defaults.json`, is read once by `src/config.js`, and is
published on `/api/status` so the dashboard holds no second literal.

Rejects with 409 `not-managed` unless the position's **disk config**
says `status: "running"` — `status` lives on the config, not the
bot-state object, and `src/build-status-positions.js` merges the two for
the API response. Also rejects mid-rebalance, mid-compound, and while a
scan is already running.

Cost: three `getLogs` per NFT in the chain over the chosen window.

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

Prefix: `ui-`. Inlined into `public/index.html` **at build time** by
`scripts/inline-svgs.js`, which runs as the last step of `npm run build`
after esbuild + `cache-bust.js`. Source `public/index.html` carries
`data-svg="…" data-w=".." data-h=".."` placeholder attributes; the
build script reads each referenced file, sizes the root `<svg>` per
the data-attrs, and writes the composed HTML to
`public/dist/index.html`. The server prefers `public/dist/index.html`
at `/` when it exists (see the top of the static-file handler in
`server.js`) and falls back to `public/index.html` when it doesn't —
so a skipped build degrades gracefully (page still boots, placeholders
just render as empty elements).

**Why inline (not `<img>`).** These icons live inside buttons and the
wallet strip where their stroke needs to cascade from the parent's
`color` — `stroke="currentColor"` (or, for `ui-wallet.svg`,
`stroke="var(--accent)"`) resolves against the enclosing
`.9mm-pos-mgr-icon-btn`, `.pos-browser-btn`, `.ws-reveal-btn`, or
`.modal-logo-icon` styles. That cascade only works if the SVG is
inline in the same DOM as its parent — `<img>` would isolate it.

**Why build-time (not runtime `fetch()` + DOMParser).** Runtime
injection would work, but adds an async load, a silent failure mode
(placeholder stays empty on parse error), and XML-parsing complexity
on the client. Build-time substitution has none of those failure modes
— what ships is what you see.

**Prefer files over inlining wherever the cascade requirement doesn't
force our hand.** Inlining defeats browser caching (the SVG bytes ride
along inside the no-cache HTML on every page load), while `<img
src="…">` icons served from `public/icons/` get the
`immutable, max-age=31536000` treatment and download exactly once per
user forever. The `act-*` category exists because that's the majority
of the app's icons — small, cacheable, isolated. `ui-*` is the
exception, not the pattern.

**No ids anywhere.** LP Ranger icons forbid `id=` attributes outright,
enforced by `scripts/lint-svg.js`. Both rendering shapes (`<img>` for
act-*, build-time inline for ui-*) work without ids, and forbidding
them removes an entire class of latent bugs where a `<use>` reference
silently picks the wrong element when the icon is cloned. Anything
that would have needed `<defs>` + `<use>` (e.g. drawing the same path
three times with different strokes for a layered rope effect) should
just inline the path three times instead. See `act-lasso.svg` for the
reference implementation.

**Placeholder shape.** A placeholder in HTML source looks like

```html
<span data-svg="icons/ui-gear.svg" data-w="27" data-h="27"></span>
```

The wrapping element (span / div / button — any tag that has
`data-svg`) keeps its `class` / `id` / other attributes; only the
`data-svg` / `data-w` / `data-h` attrs are stripped during inline.
`data-w` / `data-h` are optional; the inliner emits `width` / `height`
on the injected `<svg>` so the same file renders at multiple sizes
across the app (e.g. `ui-lock.svg` at 14 in the reveal-key button and
24 in the wallet-unlock modal).

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

Enforced by `scripts/lint-svg.js`, which runs in **both**
`npm run lint` (so the pre-commit hook catches it) and `npm run check`
as the `lint-svg` gate (so CI catches it). Fails on: malformed XML,
missing root `<svg>`, missing `xmlns` / `viewBox`, or any `id=`
attribute anywhere in a file.

It was in `npm run lint` only until the gate was added, and since CI
runs `npm run check` and nothing else, the rules above went unenforced
on the remote. The smoke test below does not cover them — an `id=` on a
referenced icon passes it — so the two are complementary, not
redundant.

A separate smoke test (`test/icons-files.test.js`) fails if:

- an `ACT_ICONS` entry has no matching file on disk,
- a `data-svg="icons/…"` placeholder in `index.html` has no matching
  file on disk, or
- a file under `public/icons/` isn't referenced from either registry.

Both checks run under `npm run check`.

`scripts/lint-svg.js` uses `@xmldom/xmldom` (devDependency) so
validation runs in pure Node — CI doesn't need `xmllint` installed.

---

## CSS Class-Name Escapes

Every utility class in `public/9mm-pos-mgr.css` starts with a digit, so
CSS requires that digit to be escaped: the class `9mm-pos-mgr-foo` is
written `.\39 mm-pos-mgr-foo`. The single space after `\39` is not a
descendant combinator — it is the escape's *terminator*, and
`mm-pos-mgr-foo` continues the very same identifier.

That makes the selector fragile in one specific way. If a formatter
wraps the line so it ends immediately after `\39`, the newline gets
consumed as the terminator instead. The identifier truncates to `9`,
the next line's indentation becomes a real descendant combinator, and

```css
.\39
  mm-pos-mgr-toggle-track::after
```

parses as `.9 mm-pos-mgr-toggle-track::after` — a selector matching
nothing. Nothing in the toolchain objects: stylelint passes, Prettier
passes, the tests pass, and only the browser shows the declaration
quietly not applying. This shipped twice; the second time it froze the
Privacy Mode and browser toggle knobs in the off position while their
track colour (a short enough rule to escape wrapping) kept working,
which made it read as a behavioural bug rather than a formatting one.

**The fix:** write the escape with six hex digits —
`.\000039mm-pos-mgr-foo`. Six digits is the maximum an escape can
consume, so the identifier continues on the same line with no
whitespace terminator to lose, and the selector survives any wrap.

**Lint enforcement:** the custom stylelint rule
[`9mm/no-linebreak-after-escape`](../stylelint-rules/no-linebreak-after-escape.js)
walks every selector and at-rule prelude and errors when a line break
directly follows a character escape. It deliberately flags only escapes
a wrap has *already* broken — the short-line `.\39 mm-pos-mgr-foo`
spelling is correct CSS and the stylesheet is full of it. So the
six-digit form is needed only where a selector would exceed Prettier's
`printWidth`, and the rule tells you exactly when that happens.

The upstream cause is a Prettier bug (present in 3.9.5); the isolated
repro lives in
`../bug-reports-on-dependencies/prettier-css-hex-escape-linewrap/`.

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
  `.husky/`. The pre-commit hook runs `npm run lint` — the same command
  CI and `npm run check` gate on, rather than a parallel set of checks.
  This is developer tooling; end-user tarball installs run it
  harmlessly (no-op if `.husky/` is absent).

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
- `husky` — pre-commit hook runner; the hook runs `npm run lint`.
- `knip` — dead-code / unused-export detector.
- `esbuild` — browser bundler.
- `@scalar/api-reference` — Scalar OpenAPI renderer
  (`npm run api-doc`).
- `cli-table3` + `pdfmake` — check-report terminal tables and PDF
  generation.
- `@fontsource/space-mono` + `@fontsource/urbanist` — additional
  self-hosted UI fonts (dev-dep so they're copied at install time
  via `postinstall`).
