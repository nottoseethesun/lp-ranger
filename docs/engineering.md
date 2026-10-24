# LP Ranger — Engineering Reference

This is the canonical reference for runtime state, development tools, and the
check-report pipeline. It covers every on-disk file the app reads or writes,
every npm script, and the CI / reporting workflow.

**Configuration has its own reference:**
[`docs/configuration.md`](configuration.md) — every environment variable, the
layered defaults system, where each setting lives, and which settings are
deliberately not editable.

**Security has its own reference:** [`docs/security.md`](security.md) — what is
at stake, every control in effect, and the lint and test gates that keep each
one from silently regressing.

For a higher-level overview of how the bot and dashboard cooperate, see
[`docs/architecture.md`](architecture.md). The HTTP route surface is
documented interactively via Scalar — see the
[API Documentation](#api-documentation) section below for how to start it.
The execution entry point itself is described in the
[`src/server.js`](#srcserverjs) section below, which walks through the startup
sequence.

---

## Table of Contents

- [Terminology](#terminology)
- [Quick Start](#quick-start)
- [`npm` Project Commands](#npm-project-commands) → [`docs/npm-project-commands.md`](npm-project-commands.md)
- [Configuration](#configuration) → [`docs/configuration.md`](configuration.md)
- [Engineering Design](#engineering-design)
  - [System View](#system-view)
  - [Sequence View](#sequence-view)
- [USD Pricing](#usd-pricing)
- [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause)
- [Idle-Suppressed Polling Sounds](#idle-suppressed-polling-sounds)
- [Impermanent Loss Guard](#impermanent-loss-guard)
- [Poll-Result Recovery Signal](#poll-result-recovery-signal)
- [Balanced-Band Telegram Notification](#balanced-band-telegram-notification)
- [Dust Threshold](#dust-threshold)
- [Lifetime History Lookback](#lifetime-history-lookback)
- [Rebalance Event Caches](#rebalance-event-caches)
  - [Where the Files Are](#where-the-files-are)
  - [What a File Holds](#what-a-file-holds)
  - [How a Scan Fills a File](#how-a-scan-fills-a-file)
  - [When a File Changes](#when-a-file-changes)
  - [What Reads the Files](#what-reads-the-files)
- [Deposit Count](#deposit-count)
- [Activity Log Figures](#activity-log-figures)
  - [Rebalance: Impermanent Loss/Gain](#rebalance-impermanent-lossgain)
  - [Compound: Percent Gain for Position](#compound-percent-gain-for-position)
  - [One Entry per Transaction](#one-entry-per-transaction)
  - [Limitations of the Figures](#limitations-of-the-figures)
- [Per-NFT Scan Windows](#per-nft-scan-windows)
  - [Cost](#cost)
  - [Batched chain reads](#batched-chain-reads)
    - [One read per pass](#one-read-per-pass)
  - [Call sites](#call-sites)
  - [The dashboard does not scan a position the bot owns](#the-dashboard-does-not-scan-a-position-the-bot-owns)
- [Client-Side URL Routing](#client-side-url-routing)
- [Shared Help Copy](#shared-help-copy)
- [Development Tools](#development-tools) → npm scripts in [`docs/npm-project-commands.md`](npm-project-commands.md)
  - [Previewing the Screenshot Gallery](#previewing-the-screenshot-gallery)
  - [Utilities](#utilities)
    - [Diagnostic Utilities](#diagnostic-utilities)
      - [Verifying a Reported USD Figure](#verifying-a-reported-usd-figure)
      - [Checking One RPC Endpoint](#checking-one-rpc-endpoint)
      - [Scenario-Reproduction Scripts](#scenario-reproduction-scripts)
    - [Update Utilities](#update-utilities)
    - [Cache Utilities](#cache-utilities)
    - [Bookkeeping Utilities](#bookkeeping-utilities) → [`util/bookkeeping-for-coins-in-transactions/`](util/bookkeeping-for-coins-in-transactions/engineering.md)
- [The app-config Directory](#the-app-config-directory)
- [Bot Config Defaults](#bot-config-defaults)
- [Security](#security) → [`docs/security.md`](security.md)
- [Check Report Artifacts](#check-report-artifacts)
- [API Documentation](#api-documentation)
- [`src/server.js`](#srcserverjs)
- [Reading Configuration Values](#reading-configuration-values)
- [RPC Failover](#rpc-failover)
- [RPC Reachability at Startup](#rpc-reachability-at-startup)
- [How Scans Survive RPC Failures](#how-scans-survive-rpc-failures)
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

Every other command, with its flags and an example, is in
[`docs/npm-project-commands.md`](npm-project-commands.md). Any entry point
will also list its own flags: `npm start -- --help`.

---

## `npm` Project Commands

**Moved.** Every command defined in `package.json` — with its flags, a
description and a copy-pasteable example — now lives in
[`docs/npm-project-commands.md`](npm-project-commands.md).

Jump straight to what you need:

| You want to | Go to |
| ----------- | ----- |
| Start or stop an install | [Lifecycle Commands](npm-project-commands.md#lifecycle-commands) |
| Build, debug, or reset local state | [Developer Tools](npm-project-commands.md#developer-tools) |
| Run the gates before a commit | [Test](npm-project-commands.md#test) |
| See a command's flags | [Getting Help on Any Command](npm-project-commands.md#getting-help-on-any-command) |
| Know what `--` is for | [Passing Flags](npm-project-commands.md#passing-flags) |
| Understand a hook that runs on its own | [Commands That Are Usually Not Run Alone](npm-project-commands.md#commands-that-are-usually-not-run-alone) |

The `node util/…` tools are not npm scripts and are documented here, under
[Utilities](#utilities).

## Configuration

All configuration detail now lives in
[`docs/configuration.md`](configuration.md): every environment variable, the
layered defaults system, where each setting lives on disk, and which settings
are deliberately not editable.

Start with
[Configuration Precedence](configuration.md#configuration-precedence) — the
rule deciding which of the three layers wins is where most surprises come
from. Other entry points worth knowing:

- [Contract Addresses](configuration.md#contract-addresses) — why the Position
  Manager and Factory are not editable from the dashboard, and why changing
  them means a fresh install.
- [Where Other Configuration Lives](configuration.md#where-other-configuration-lives)
  — the map from a setting to the file that holds it.
- [RPC Request Pacing and Log Chunking](configuration.md#rpc-request-pacing-and-log-chunking)
  — the two settings that govern how the app talks to an RPC endpoint.

---

## Engineering Design

### System View

Read [`docs/architecture.md`](architecture.md) first. It sets out the two
halves — the backend bot and the web app — the HTTP API between them, the
rebalance and compound pipelines, and how P&L is tracked. This section
assumes that picture and names the pieces underneath it.

**Major functions.**

| Function | File | How it fits |
| --- | --- | --- |
| `startBotLoop` | `bot-loop.js` | One call per managed position. Builds or accepts a provider and signer, detects the position, restores cached P&L, polls once, starts the scheduler, fires the history scan. Returns `stop()`. |
| `pollCycle` | `bot-cycle.js` | One poll. Reads pool state, refreshes the position, updates P&L, considers a compound, checks range, runs the rebalance gates, executes. Everything downstream is called from here. |
| `executeRebalance` | `rebalancer.js` | Drains the old NFT, swaps to the ratio the new range needs, mints a new NFT. Holds the rebalance lock for its whole run. |
| `executeCompound` | `compounder.js` | Collects unclaimed fees, swaps to the range's ratio, adds them back as liquidity. Same NFT, same range, no mint. |
| `detectPositionType` | `position-detector.js` | Enumerates the wallet's NFTs, up to 300, and returns the V3 positions it finds. The only discovery path; both the bot and the scan route use it. |
| `scanPoolHistory` | `pool-scanner.js` | Walks a pool's Transfer events to build the rebalance chain. Serialized per pool, so two positions in one pool cannot scan it twice. |
| `reconstructEpochs` | `epoch-reconstructor.js` | Turns that chain into P&L epochs with historical prices. Runs after the scan, never beside it. |
| `getPoolState` | `rebalancer-pools.js` | Resolves the pool from the Factory, reads `slot0` and tick spacing. The price read every poll and every rebalance starts from. |
| `getManagedReadProvider` | `send-transaction.js` | The single read path. A Proxy that retries a failed call through the RPC failover list, without giving up. Returns itself for `provider` so ethers' `queryFilter` cannot escape the wrapper — see docs/security.md. Nothing reads chain state another way. |
| `loadMergedDefaults` | `load-merged-defaults.js` | Shipped JSON deep-merged with the operator's override. Every shipped default enters the app here. |

**Major objects.** Each is created by a factory and held for the process
or the position's lifetime.

| Object | File | How it fits |
| --- | --- | --- |
| Position manager | `position-manager.js` | The one orchestrator. Starts and stops positions by composite key, owns the shared signer, and counts rebalances per pool. |
| Per-position bot state | `server-positions.js` | The mutable record one loop writes and `GET /api/status` serves. The only channel from bot to dashboard. |
| P&L tracker | `pnl-tracker.js` | Closed epochs plus one live epoch. Persisted by pool identity, so it survives the rebalances that change tokenIds. |
| Throttle | `throttle.js` | Minimum interval, daily cap, doubling window. One per position, so a volatile pool cannot slow a quiet one. |
| Residual tracker | `residual-tracker.js` | Per-pool leftovers across rebalances, capped at the wallet's balance. Feeds the residual value in the dialog shown after a rebalance; the Lifetime IL/G's credit and the cleanup sweep read the wallet's balances instead. |
| Rebalance lock | `rebalance-lock.js` | One async mutex. One wallet means one nonce, so only one position may send at a time. |
| RPC request queue | `rpc-request-manager.js` | One FIFO queue. Every JSON-RPC request in the process leaves on its schedule, whichever provider issued it. |
| Shared signer | via `getSharedSigner` | One NonceManager for the wallet. Per-position signers would keep separate counters and collide. |

### Sequence View

Three situations, in the order an operator meets them: the first run on a
new install, everyday use once that is done, and what a restart looks
like afterwards.

#### The Syncing / Synced Badge

The badge is how an operator knows whether a position's figures can be
trusted, so it is worth being precise about what it claims.

**Synced** requires two things: the rebalance-history scan finished
**and** the lifetime scan produced a positive deposit total. A scan that
completed but resolved nothing useful leaves the badge on **Syncing**
rather than reporting done — a figure that is wrong but confident is
worse than one visibly absent.

**It describes one position, not the install.** Each position carries its
own scan state. One reading Synced while another reads Syncing is normal,
and switching between them changes which state you are shown, not what
the app is doing.

**Synced also means the state is on disk.** Setting the flag writes the
position's config, so a position showing Synced has its baseline and
totals persisted and is safe to shut down, best with
`npm run gentle-stop`, which waits out any rebalance, compound or scan
under way. Ctrl+C and `npm stop`, which share a shutdown handler, do not
wait.

#### Start from Fresh Installation

Nothing is known yet — no wallet, no positions, no history — so this run
is the slow one. Everything after it is faster because of what this run
writes down.

The server starts in **dashboard-only mode**. It has no signing key, so
there is nothing to manage and nothing to poll. It waits for a browser.

You accept the disclosure and import or create a wallet. That unlocks any
stored API keys and asks what should be started; on a fresh install the
answer is nothing, because no position has been marked as managed.

The first scan is a **wallet scan**, and it is worth separating from the
chain-history scans that follow. It asks only "which LP positions does
this wallet hold?" — it enumerates them and resolves each pool's token
symbols. No position's history is touched. The result is cached against
the chain, contract and wallet, which is what makes every later startup
skip this step.

You pick a position and click Manage. That starts a bot loop, and the
loop does the work in a deliberate order: a poll runs **first**, so the
dashboard shows live price, value and fees within seconds, and only then
does the history scan begin. Waiting for history before showing anything
would leave the operator staring at an empty dashboard for hours.

The history scan has three stages, and all three must finish before the
position reads Synced:

1. **The rebalance chain.** Walk the pool's transfer history to find
   every NFT this wallet has held in it. On a long-lived position that is
   a chain of a hundred or more.
2. **P&L epochs.** Turn that chain into one accounting period per NFT,
   priced at the blocks where each opened and closed.
3. **Per-NFT history.** Walk each NFT in the chain for its own deposits,
   fee collections and withdrawals. This is what compound totals, the
   HODL baseline and lifetime P&L are built from.

Stage three is the expensive one, because its cost is per NFT rather than
per pool. A hundred-NFT chain does a hundred walks. Hours is normal on a
first run; the figures that appear afterwards are worth the wait, and
nothing is lost if the process is stopped part-way — see
[How Scans Survive RPC Failures](#how-scans-survive-rpc-failures).

#### Post-Initialization Operation

Once a position has been scanned, day-to-day use is polling and the two
actions a poll can take. Switching between positions is the other thing
an operator does constantly, and it behaves in a way worth understanding.

##### Switching positions

Which position you are looking at is a browser concern, not a server one,
and what a switch costs depends on whether the bot manages the position
you switch to. See
[Switching from a Managed Position to a Different Position That Is Unmanaged](#switching-from-a-managed-position-to-a-different-position-that-is-unmanaged).

##### What each poll does

Every position polls on its own timer, 300 seconds apart by default.
Each poll re-reads the pool price and the position's liquidity,
recomputes value, unclaimed fees and IL/G against the HODL baseline, and
checks whether any wallet residual is large enough to be worth sweeping
back in. Token prices are cached briefly, and are not fetched at all
once the dashboard has had no input, or the server no dashboard request,
for 15 minutes — those lookups are quota-limited and there is nobody
watching. A rebalance or compound fetches fresh prices regardless.

Then the price decides which of two things can happen.

**In range — compound.** If auto-compound is on and unclaimed fees have
grown past the configured threshold, the fees are collected and added
back to the same NFT. No new NFT, no change of range. The same check runs
while the price is out of range but still inside the OOR threshold, with
the OOR timeout not yet expired. A minimum spacing between compounds
stops small positions burning gas on dust.

**Out of range — rebalance.** A series of gates run first: recent
rebalance frequency, the pool's daily cap, the Impermanent Loss Guard,
and a gas check that defers the move if it would cost too much relative
to the position. A manual **Rebalance Now** skips every gate but the gas
check, and still counts against the daily cap.

Past the gates, the position is drained, the tokens swapped to the ratio
the new range needs, and a new NFT minted around the current price. Only
one position rebalances at a time, because they share a wallet and
therefore a transaction nonce. Every transaction is watched, sped up if
it stalls, and cancelled if it stays stuck, so a pending transaction
cannot block the bot indefinitely.

Afterwards the new NFT inherits the old one's accounting — baseline,
residuals, P&L history — and a rescan is flagged so the new mint is
picked up.

#### Re-start from Initialized Installation (Has Completed Blockchain Scan)

A restart after a completed scan is fast, and the reason is that almost
everything the slow run produced was written to disk.

**Managed positions come back on their own; unmanaged ones wait for a
browser.** Starting managed positions is server-side and automatic.
Everything about an unmanaged position is browser-initiated and cannot
begin until someone opens the dashboard.

The server finds the stored wallet rather than starting empty. With a
wallet password configured it unlocks immediately; otherwise it waits for
the browser unlock and continues from there.

It then starts each position whose saved status is **running**: the list
Manage adds to and Stop Managing removes from, which a stop of the app
leaves alone. Only the positions of the chain it runs and the wallet it
holds are started; one saved under another wallet or chain waits for
that wallet's or chain's own launch. With no wallet loaded, every
wallet's listed positions on this chain are taken, no owner is checked,
and each wallet keeps its own position in a pool, as a Manage keys it.
Before any starts, it reads every listed position's owner and pool, and
takes off the list each one that cannot be managed: its NFT was sold,
transferred or burned since the last run, or another listed position
keeps its pool. LP Ranger manages
one active position per pool, so each pool keeps its open position, or
the first listed if none is open. One whose owner or pool could not be
read is not started, since nothing then shows its pool free; it stays on
the list for the next launch, as does one that merely fails to start.
The headless bot (`src/bot.js`) starts its listed positions through the
same start-up.

Positions start staggered rather than together. With the default poll
interval and two positions, the second waits 150 seconds. That spreads
both their polling and their scans instead of firing every request at
once. While the start-up runs, the dashboard's badge reads Syncing for
every position and the server refuses a Manage or a wallet import, since
either would start positions alongside the ones still waiting their
turn (`src/lib/app-phase.js`).

Each position then runs the same sequence as a fresh one, with two
differences that account for the speed:

- **The scan does not block.** The first poll runs, the schedule starts,
  and any scanning happens in the background. The dashboard has numbers
  within seconds.
- **P&L history is restored rather than rebuilt**, because it is stored
  against the pool rather than the NFT. Every rebalance mints a new NFT;
  keying on the pool is what lets that history survive them.

The wallet scan is skipped too — the browser's request hits the cache
written on the first run instead of re-enumerating the wallet.

A scan can still run after a restart, for a reason unrelated to the
restart: new rebalances have happened since the last one, or a previous
scan did not finish. The rebalance-event scan picks up from the last
block it saved, so new rebalances cost only the blocks since then. It
saves only when it completes. An interrupted one starts over, and so
does a lifetime scan's chain read.

---

#### Switching from a Managed Position to a Different Position That Is Unmanaged

A managed position's history belongs to the bot, which keeps it current.
An unmanaged one has nobody working on it, so opening it is the first
time that work has been asked for and the server starts from nothing.
That is the scan you see, and the Sync badge describes the position in
front of you rather than the install.

What is cached is a **pool's** history, not a position's, so the cost is
per new pool rather than per switch. Each pool is paid for once, which is
why switching feels slow at first and quick later. Managed positions keep
polling throughout, and the result survives a restart.

## USD Pricing

Every USD figure is a token amount times a token price. Current prices
come from up to three services, tried in priority order behind an
in-memory cache (two minutes as shipped). Historical prices, a token's
price at a past block, come from Moralis or GeckoTerminal. Implementation
lives in [`src/lib/price-fetcher.js`](../src/lib/price-fetcher.js), with the
services in [`src/lib/price-sources-current.js`](../src/lib/price-sources-current.js).

### Current Prices

`fetchTokenPriceUsd()` tries each source in order and returns the first
non-zero result. A service the chain's `priceServices` entry in
`chains.json` gives no id for is not asked.

1. **Moralis** (primary), asked only when a key is stored and Moralis is
   switched on in Settings. **The API key is free** (sign up at
   <https://moralis.com/>); paste it into the dashboard Settings dialog and
   it's encrypted at rest in `app-config/user-configurable/api-keys.json`. Most reliable for
   meme tokens that the free aggregators drop.

   **Free-tier quota caveat:** the free plan has a daily compute quota.
   Very large position sets, repeated cache clears (`npm run clean`,
   `dev-clean`, or manually deleting `app-data/scan-cache/`), or several fresh wallet
   scans in a row can spend it in one session. Once it is spent, Moralis
   refuses the key until the quota resets, and prices come from the
   GeckoTerminal and DexScreener fallbacks below, which cover meme tokens
   less completely. Waiting or a paid plan are the only ways back to
   Moralis.

   Quota-exhaustion errors are parsed separately from invalid-key errors
   so the dashboard shows an **orange** Moralis indicator while you're
   quota-locked, versus a **deep red** indicator for an invalid or
   unauthorized key.
2. **GeckoTerminal** — free, no key needed, but rate-limited to 30 calls/min
   (see "Rate limiting" below).
3. **DexScreener** — free, no key needed, but drops tokens with no 24h LP
   activity, which is why it's the last fallback rather than the first.

### Historical Prices

A historical lookup resolves a token's USD price at a specific block.
This is how the HODL baseline, P&L epoch reconstruction, and
closed-position history are populated. Both services are reached through
`fetchHistoricalPriceGecko()`, despite its name: Moralis is asked first
when a key is stored and the caller has a block number, and GeckoTerminal
answers for any token still at zero.

The historical flow is substantially more complex than current-price
fetching because GeckoTerminal's OHLCV endpoint requires a **pool address**
and a **pool-side token identifier** (`base` or `quote`) — which don't
always match the Uniswap v3 `token0`/`token1` ordering:

- **Pool orientation cache** — on first lookup per pool, a one-shot GET to
  the GeckoTerminal pool-info endpoint records whether the pool's `base`
  side is `token0` (`normal`) or `token1` (`flipped`). Persisted to
  `app-data/scan-cache/gecko-pool-cache.json`. Without this cache, orientation mismatches
  would produce price ratios that are inverted by orders of magnitude.
- **Block-time cache** — block number → Unix timestamp lookups are cached
  in `app-data/scan-cache/block-time-cache.json` so historical API calls use the correct
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
[`src/lib/gecko-rate-limit.js`](../src/lib/gecko-rate-limit.js)) is applied to
**every** GeckoTerminal call and is shared between `price-fetcher.js` and
`gecko-pool-cache.js` so all callers (HODL baseline, epoch reconstruction,
position history, pool-orientation bootstraps) draw from a single budget.
If the window is full the caller automatically waits until a slot opens.

### In-Memory Cache

Current-price results are cached with a configurable TTL (default 120 s,
see `priceCacheTtlMs` below), keyed by the canonical `chain-token`
(`cacheKey` in `src/lib/cache-store.js`). Historical prices have their own
disk-backed cache in `app-data/scan-cache/historical-price-cache.json`, with no TTL since
a past price never changes. It is keyed by chain, token, and the block
(`@<block>`) or, for a caller without one, the UTC day
(`src/lib/price-cache.js`), so it survives restarts and serves every pool
that holds the token.

Each write of that cache, and of GeckoTerminal's pool cache
(`src/lib/gecko-pool-cache.js`), reads the file as it is at that moment. It
lays all of the process's entries over it, and replaces the file whole
(`src/lib/shared-json-file.js`). The text goes into a folder `fs.mkdtempSync`
makes beside the file, with a name no other process gets, and is then
renamed over the old file. So a write keeps every entry the file held
when it read it, which lets LP Ranger and a tool under `util/` that
prices through its library write the same cache at once. The
bookkeeping report keeps copies of its own, which one run at a time
writes, under a lock. A process stopped part way through a write leaves
the file as it was. An entry another process writes after that read and
before this write's rename is dropped from the file. It stays in that
process's memory, and its next write puts it back, so only a run's last
new entries can be lost; a later run fetches them again. The folder is
beside the file, not in the system's temporary folder, because a rename
cannot cross from one mounted filesystem to another.

---

## Idle-Driven Price-Lookup Pause

To stay under price-source quotas, `fetchTokenPriceUsd` and
`fetchDustUnitPriceUsd` are gated at the public API of
`src/lib/price-fetcher.js` whenever nobody needs them. `fetchHistoricalPriceGecko`
is never gated.

**Pause sources** (each can pause on its own):

- **Server idle** — every `/api/*` request except `/health` resets the
  countdown; after 15 min without one the server pauses itself.
- **Browser idle** — `src/client/web/dashboard-idle.js` posts pause after 15 min
  of no input; the next activity (focus, a click, mouse movement, the
  wheel, a key, a touch or a pointer press) posts unpause through a
  handler throttled to once per 500 ms.
- **Move scope** — every auto- and manual-triggered rebalance and compound
  runs inside `withFreshPricesAllowed(...)`, which bypasses both the pause
  flag and cache TTL for the duration and restores prior state on exit
  (success or thrown).
- **Headless `src/bot.js`** — starts paused by default; opt out with
  `--start-with-price-lookups-unpaused`.

`/api/*` traffic resets the server idle countdown but does NOT auto-unpause;
this prevents the 3-second `/api/status` polling loop from fighting the
browser-issued pause.

**Configuration** (in `app-config/user-configurable/bot-config.json` `global` section):

| Key | Default | Notes |
| --- | --- | --- |
| `priceCacheTtlMs` | `120000` | Current-price in-memory cache TTL (ms). |
| `dustUnitPriceCacheMultiplier` | `30` | Dust-unit-price TTL = `priceCacheTtlMs × multiplier`; runtime asserts integer multiple. |

**Two endpoints** (idempotent, no body required):

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

`src/client/web/dashboard-sounds.js` `playSound()` reads `isBrowserPaused()` from
`src/client/web/dashboard-idle.js` and skips playback while the browser-side
idle flag is `true`. `playSoundAlways()` (About Easter Egg, LP/Ranger
title tune) is intentionally unaffected — those fire on explicit user
clicks, and any click is itself an activity event that flips
`_browserHasPaused` to `false` synchronously before the click handler
runs.

The browser idle flag is independent of the move-scope bypass
(`withFreshPricesAllowed`). That bypass lives entirely server-side in
`src/lib/price-fetcher-gate.js` and never touches the browser, so an auto-
rebalance or compound that runs while the user is away leaves the
browser still paused and the gate suppresses the corresponding sound
until the user returns.

`isBrowserPaused` alone does not catch system-suspend or tab-discard:
when JS execution freezes the 3 s polling stops, the seen-maps stay
stale, and on wake the next poll fires sounds for every event the bot
recorded during sleep. `src/client/web/dashboard-idle.js` `_uiLastWokeUpAtMS`
advances inside `_onActivity` when an activity event (`focus` arriving
first) lands after a gap exceeding `PAUSE_AFTER_NO_INPUT_MS` (15 min);
the exported `isStaleForUiPurposes(eventMs)` consulted by
`checkRebalanceSound` and `checkCompoundSound` then filters any event
whose server timestamp predates that wake moment.

---

## Impermanent Loss Guard

A ceiling on how much impermanent loss a position may carry before the
bot stops rebalancing it, since a rebalance locks that loss in. Before
every **automatic** rebalance the guard compares the hypothetical
post-rebalance position against holding the coins the NFT currently
held was minted with, and those put into it since, valued at today's
prices, and rejects the
rebalance when the projection falls more than `impermanentLossGuardPct`
below holding. That comparison is the Current panel's IL/G for the NFT,
and the guard reads it rather than working it out again. Holding is
valued at today's prices, not at the minted coins' value on the mint
day, because a move both coins' dollar prices share is not impermanent
loss and a rebalance does not lock it in. Measured against the mint day,
the guard would block a position whose coins had both fallen though its
impermanent loss was small, and let a deep loss through inside a rise
both coins shared.

**Read-only by construction.** Both inputs come from the poll cycle's
figures — `snap.totalIL` and the minted coins and prices it was measured
with, `snap.ilInputs`, both from `_computeIL` (`src/lib/bot-pnl-il.js`)
inside `updatePnlAndStats` — so evaluating the guard sends no
transaction. Holding is `hodlValueUsd` (`src/lib/il-calculator.js`), the
same expression IL/G uses; the projection is holding plus `totalIL`. The
gate runs among the rebalance gates (`gatesFromGuard`,
`src/lib/bot-cycle-gates.js`), which return before `executeRebalance` is
called, so there is no path from a rejection to `decreaseLiquidity` or
`collect`. A rejected position is left exactly as it was found.
`test/il-guard.test.js` drives the gate with a `deps` whose provider and
signer throw on any property access, so a future chain read here fails
the suite rather than shipping.

**Fresh prices.** While price lookups are paused (the dashboard idle or
closed, and always under `npm run bot`), the poll's figures carry the
last prices fetched, of any age, and a rebalance is due because the
price has moved, so an old price makes the loss look smaller. Once every
gate before the guard has passed and the guard will measure, the figures
are worked out again with fresh prices (`snapForGuard`,
`src/lib/bot-cycle-gates.js`): one more price lookup per rebalance the bot is
about to make.

**An even comparison.** The guard compares the position as it was
minted against the same position rebalanced, the user's ruling
(2026-10-23): "If you add in residual coins, it's not an even
comparison." So it counts no coin in the wallet: neither a rebalance's
leftovers nor a deposit waiting there is on either side, and the guard
needs no deposit count before it measures. Coins put into the NFT after
its mint are in its LP value, so they count on the holding side too: the
wallet's coins a compound's deposit took in beyond its fees, from the
compound's record (`walletCoinsPutIn`, `src/lib/compounded-coins.js`).
Measured on the wallet's coins instead, a deposit left out of holding
would hide a loss of its own size, and one counted on both sides would
still shrink the loss as a share of holding.

**Slippage is excluded.** A rebalance moves the same dollars from one
tick range to another, so the projection is the position's present worth:
its LP value. The fees this NFT has compounded come off it, as they do
in IL/G: compounding raises the liquidity while holding stays at the
minted coins, so counting them would let earnings hide a loss.

**Two consequences.** First, the bot cannot clear a rejection itself.
The minted coins are reset by `updateHodlBaseline` only when a rebalance
mints a new NFT, and a rejected position cannot rebalance, so it cannot
mint. The block lifts at a retry check (below) that finds the position's
value back above the floor, or above a floor the operator has lowered by
raising the Guard's percentage. Second, it bites while the position is
idle: the guard only comes up when a rebalance was due, which usually
means the position is out of range and earning nothing.

**Skipped for manual rebalances.** Like every other gate in
`_checkRebalanceGates`, a user-forced **Rebalance Now** bypasses it — and
that path already shows its own impermanent-loss confirmation.

**Skipped for an empty position.** A rebalance whose mint fails after the
drain leaves the NFT empty and the coins in the wallet, and the bot
retries the mint as an automatic rebalance (`rebalanceFailedMidway`,
`src/lib/bot-loop.js`). The guard stands aside while the position holds no
liquidity (`isThisPositionDrained`, `src/lib/position-drained.js`, the user's
decision, 2026-10-23), before its backoff, so a wait left by an earlier
rejection holds no mint either. The rebalance passed the guard before it
drained, and the drain locked the loss in. Measured, the guard would read
the empty position as worth nothing, since it counts no coin in the
wallet, and turn the mint down with a 100% loss, leaving the coins idle;
with this NFT's compounded fees the projection came out below zero, which
it treated as no figure, so the outcome hung on whether the NFT had
compounded. `ilGuardWillMeasure` answers the same, so the poll takes no
fresh prices for it.

**Fails open.** A guard percentage outside its bounds, a projection that
cannot be computed, or minted coins the mint scan has not read yet all
allow the rebalance and log why. Freezing the bot because a figure has
not finished loading would do more harm than the case being guarded
against.

**Retry backoff.** After a rejection the position is left alone rather
than re-decided every poll: 4 h, then doubling on each consecutive
rejection — 8 h, 16 h, 32 h — held at one week, as shipped
(`ilGuardRetry`). While a wait runs the guard is not evaluated at all,
except that saving a position's Guard percentage lifts that position's
wait (`clearIlGuardWait`, called by `POST /api/config`), so the next poll
decides on the new value, the way a Slippage save frees a slippage
pause. The ladder resets the moment the guard lets a rebalance through,
and on such a save. Any rebalance that succeeds, a Rebalance Now
included, ends the block, wait and alert both (`endIlGuardBlock`): the
new NFT is measured against its own minted coins. The `ilGuardRejected` Telegram
alert rides the same timestamp, so a position blocked for a long stretch
reports on a widening interval instead of every `CHECK_INTERVAL_SEC`. The
backoff state (`_ilGuardRejectedAt`, `_ilGuardRejectCount`) is transient
per-position bot state, so a restart re-evaluates immediately.

**A rejection is not a rebalance.** `throttle.recordRebalance()` and
`_recordPoolRebalance()` both live in `_handleRebalanceSuccess`, reached
only after `executeRebalance` returns, so a rejected rebalance never
counts toward Max Rebalances / Day and never advances doubling mode.

**A rejection is not a recovery either.** An ILG rejection reports the
same result shape as a quiet poll while meaning the opposite, so the
recovery test must not read it as one. See
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

**Config.** `impermanentLossGuardPct` (default 15) is a `POSITION_KEYS`
entry: per position, settable in Bot Configuration → Execution, and shown
as a badge in Auto-Rebalance Settings. The default is deliberately tight,
because the two sides are not alike. Rebalancing crystallizes the loss:
the position is re-minted around the current price, so a paper loss a
recovery would have undone becomes permanent. Declining forgoes only fees
the position is largely not earning, since the guard is consulted only
when a rebalance was due. Fees are also the only thing that earns such a
loss back, and a low-volume pool may not produce them faster than the
position is held. Its range is in `setting-bounds.json`: the server
refuses a save outside it, putting the field back to the value last
accepted; the shipped file is held to it; and `evaluateIlGuard` applies
no guard to a figure outside it.

The shipped default layers env-over-JSON like every tunable around it
(see the `src/lib/config.js` header): shipped default, operator override,
then `IMPERMANENT_LOSS_GUARD_PCT` on top. That layer is what makes the
setting reachable on a headless install, where there is no Bot
Configuration panel to press Save in. `src/lib/il-guard.js` reads the same
`config.IMPERMANENT_LOSS_GUARD_PCT` export for its own fallback, so the
badge and the enforced threshold resolve through one expression.

The Bot Configuration input is not a third resolution path, despite prefilling
from `/api/bot-config-defaults`: `buildStatusPositions` spreads
`posDefaults` into every position payload, so the first `/api/status`
poll overwrites the box with the same `config.*` figure the badge and the
bot use. The endpoint value only paints the field in the moment before
position data arrives. Retry pacing is the server-internal
`ilGuardRetry` group (`baseMs`, `maxMs`), operator-tunable through the
layered defaults file only, like `residualCleanup`.

Note that `readConfigValue` returns `undefined` for a key never saved and
does **not** consult the layered defaults file — `src/lib/il-guard.js` applies
the shipped default itself, the way `bot-cycle-opts.js` does for slippage
and approval multiple. Without that the guard would be inert on every
position until the user pressed Save.

## Poll-Result Recovery Signal

When a rebalance fails, the position enters a degraded state: the error
is recorded and the dashboard shows the position as stuck. Nothing about
that state expires on its own. Something has to notice when the position
is healthy again, clear it, and tell the operator.

This section is how the app decides that a poll means **recovered**. The
decision is one predicate, and both ways of getting it wrong cost
something real:

- **Missing a recovery** leaves a working position flagged as broken,
  with its error still on screen.
- **Declaring one falsely** discards the error explaining why the
  position is stuck, and announces a still-blocked position as
  recovered.

### What recovery does

`_handleRecovery` in [`src/lib/bot-loop.js`](../src/lib/bot-loop.js) restores
normal operation in one step:

| Cleared or restored | Effect |
| ------------------- | ------ |
| `rebalanceError`, `rebalancePaused`, `rebalanceFailedMidway` | The dashboard stops showing the position as stuck |
| `firstFailureAt`, `midwayRetryCount` | The failure streak is forgotten, so the next failure starts a fresh one |
| `oorRecoveredMin` | Set to the minutes spent failing, which raises the **Position Recovered** modal; cleared five seconds later |

### When it can fire

Only when `firstFailureAt` is set — a position that was never failing
has nothing to recover from.

A `pollError` result is deliberately excluded. A pool-state RPC hiccup is
not a failed rebalance attempt, so counting it as one would fire a
spurious modal on the next healthy poll. That is most visible on
full-range positions, which can never actually go out of range and so
would otherwise announce a recovery they never needed.

### How it decides: assert the positive signal

`isRecoveryResult` tests for the thing that means recovery, rather than
enumerating the things that would block one:

```js
result.inRange === true &&
!botState.rebalanceFailedMidway &&
!botState.rebalancePaused
```

The alternative — "no rebalance, no error, no deferral" — looks
equivalent and is not. A poll can decline to rebalance for at least eight
distinct reasons, and most return a shape that names no reason at all:

| Result shape | Returned by |
| --- | --- |
| `{rebalanced: false}` | throttle, pool daily cap, dry run, aborted-and-drained short-circuit, drain timer |
| `{…, withinThreshold: true}` | out of range but inside the OOR threshold |
| `{…, priceVolatile: true}` | a rebalance the price outran, held for the owner |
| `{…, scanRunning: true}` | scan in progress |

A negative test reads every row above as a recovery. It would also need a
new clause each time a gate is added, and the failure mode of forgetting
one is silent.

### Why `inRange` can be trusted

`inRange` is set by `_checkRangeAndThreshold`
([`src/lib/bot-cycle.js`](../src/lib/bot-cycle.js)), which runs **before** every
execution gate. No blocked result can carry it, so asserting it needs no
clause per gate — the gates all run downstream.

The two `botState` clauses cover what `inRange` alone cannot: a position
back in range but still mid-recovery or swap-aborted. The second also
stops a paused-and-aborted position from clearing its own pause flag and
skipping its scheduled retire.

### One accepted cost

When a residual-cleanup rebalance sets `forceRebalance`, an in-range
position skips the `inRange` return for that poll, so a pending recovery
fires one cycle later.

### Where it is tested

`isRecoveryResult` is exported and driven directly by
`test/il-guard-gate.test.js`, one case per distinct result shape —
extracted from the `startBotLoop` closure for the same reason
`createBotPollScheduler` was.

---

## Balanced-Band Telegram Notification

Optional Telegram alert that fires when a managed position drifts into
the **USD-balanced band**: within 2.5 percentage points of an even split
as shipped (`token0_value / total ∈ [0.475, 0.525]`). A cue to rebalance
by hand where a 50/50 split is preferred. Edge-triggered: one alert per
FALSE→TRUE crossing, then a quiet period (30 minutes as shipped), so a
position wavering across the edge cannot spam the channel.

**Enable it.** Settings → Telegram → check **Position Balanced (±2.5% of
50/50)**; the label quotes the band in force. Default OFF. The checkbox
shows a warning and the computed price-fetch cadence.

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

The band and the quiet period are in `bot-config-defaults.json`, and an
override of either takes effect on restart:

| Key | Default | Notes |
| --- | --- | --- |
| `positionBalancedBandPct` | `2.5` | Percentage points either side of 50/50 that count as balanced. 0.1 to 25. The alert's header and the checkbox label quote it. |
| `positionBalancedCooldownMs` | `1800000` | Least time between two alerts for one position: 30 minutes. One minute to a day. |

**Notification payload.** The header lists the blockchain
(`CHAIN.displayName`), the LP provider's name (e.g. `"9mm v3"`), the two
token symbols (up to 22 characters each, the second line indented four
spaces) and the fee tier. The provider's name comes from
`app-config/app-defaults-for-user-configurable/lp-providers.json`, keyed
by the configured pool factory and position manager, the same map the
dashboard's NFT panel reads through `GET /api/lp-providers`. Range,
ticks, price and the ratio split are left out: the alert is about value
balance, not the range. The body shows each token's holding, by name,
with its USD value, the total, and, once the P&L snapshot exists,
unclaimed fees and lifetime P&L.

---

## Dust Threshold

Every "is this amount small enough to ignore?" decision in the rebalancer
routes through one utility: [`src/lib/dust.js`](../src/lib/dust.js). Callers never
hardcode a literal USD number — they `await isDust(usdAmount)` (or read
`getDustThresholdUsd()` for the live value). The primary consumer today is
the post-rebalance corrective-swap loop in
[`src/lib/rebalancer-correct.js`](../src/lib/rebalancer-correct.js), which stops
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
[`src/lib/price-fetcher.js`](../src/lib/price-fetcher.js) walks the
`priceSourceTokens` list in order. For each token it tries Moralis first,
then DexScreener. The first non-zero result wins. Results are cached with a
dedicated TTL (`getDustUnitPriceCacheTtlMs`, `src/lib/price-fetcher-gate.js`)
so repeated `isDust()` calls during a single rebalance don't hammer the
price APIs.

### Fallbacks (Fail Loud, Fail Safe)

The guard is designed to never silently disable itself:

- A missing or malformed shipped `dust-threshold.json` stops the app as
  it loads: `dust.js` reads the file at module init, and the loader
  throws on an install error rather than guessing a threshold.
- So does a `thresholdUnits` or `fallbackThresholdUsd` that is not a
  number above 0, in the shipped file or the operator's copy: the
  message names the setting. A threshold that is text, zero or less
  would let no amount compare below it, so the guard would call nothing
  dust. The rule is the one the shipped-values test holds the file to
  (`src/lib/value-kinds.js`).
- If every price source returns zero, `getDustThresholdUsd()` falls back
  to the file's `fallbackThresholdUsd` ($1.00 as shipped) — a fixed floor
  rather than an open gate — and flags `usedFallback: true` so callers
  can log the condition.

Both prefer a closed door over an open one: with no network,
`isDust($0.50)` still returns `true`.

---

## Lifetime History Lookback

"Lifetime" P&L figures — total fees earned, every rebalance event, every
compound, cumulative impermanent loss/gain — are computed from the on-chain
history of the wallet's position NFTs. The question of **how far back to
scan** is answered by three layered bounds, resolved in order by
[`src/lib/event-scanner.js`](../src/lib/event-scanner.js):

1. **The lookback** (the outer bound)

   `historyLookbackYears` in `bot-config-defaults.json` (5 as shipped),
   turned into blocks at the active chain's `blockTimeSec` in
   `chains.json` by [`src/lib/history-lookback.js`](../src/lib/history-lookback.js):

   ```text
   BLOCKS_PER_YEAR = round((365.25 * 24 * 3600) / blockTimeSec)  (3,155,760 at 10 s)
   baseFrom        = max(0, currentBlock - years * BLOCKS_PER_YEAR)
   ```

   That is the oldest block a history scan touches. Every scan that walks
   back from the chain head asks the same module, so the rebalance scan
   and the closed-position reads agree on where a pool's history starts.
   History older than the lookback is not read; raise
   `historyLookbackYears` for a longer window.

2. **Pool-creation block** (tightens the window for young pools)

   Most pools are nowhere near five years old, so querying every chunk
   back to `baseFrom` would waste thousands of RPC calls on empty ranges.
   Before the chunk loop starts, `resolveFromBlock()` resolves the block
   the pool was deployed in, and that becomes the effective `fromBlock`:

   ```text
   effectiveFrom = max(baseFrom, poolCreationBlock)
   ```

   For a pool created six months ago, this collapses a 15.8 M-block scan
   down to ~1.6 M blocks — roughly a 10× speedup on a fresh install.

   **`findPoolCreationBlock()` binary-searches `eth_getCode`.** Contract
   code is account state, and state is addressable per block, so "does
   this pool exist at block N" is a single call and the lowest block
   answering yes is the deployment block. Over a 27.5 M-block chain that
   is 27 calls, a few seconds, and exact.

   Scanning the Factory's `PoolCreated` log cannot do this: those events
   are ordered by block, not by pool address, so finding one pool means
   reading every event until it appears — 900–1,100 chunked queries for a
   pool a few years old, each paced by the global RPC queue.

   The search needs **historical state**. A node that has pruned it
   answers with an error rather than an empty result, so it cannot
   produce a wrong block; the error reaches `getPoolCreationBlockCached`,
   which returns `0`, and the caller's `creationBlock > fromBlock` test
   discards it in favour of its own floor. That widens a scan rather than
   narrowing it, so an unanswerable lookup costs time and never events.

   The answer is cached permanently in
   `app-data/scan-cache/pool-creation-blocks-cache.json`, making it a once-per-pool cost
   paid only on a cold cache.

3. **Disk cache** (subsequent runs resume from the last scanned block)

   A scan stores what it found in the pool's event cache file, with
   `lastBlock`, the last block it read
   ([Rebalance Event Caches](#rebalance-event-caches)). The next scan
   starts at the block after it, so only blocks produced since the
   previous scan are queried. A 5-year first-time scan issues ~1,750
   chunked queries (9,000 blocks per chunk, every request released by
   the global request queue — see
   [RPC Request Pacing and Log Chunking](configuration.md#rpc-request-pacing-and-log-chunking));
   a warm-cache rescan on the same wallet issues a handful.

   The cache is **not** invalidated on rebalance. A successful rebalance
   appends its own record to the file, sets `_needsFullRescan`
   (`src/lib/bot-recorder.js`) and starts the scan at once
   (`src/lib/bot-cycle.js`), running the event and lifetime scans together.
   The `lifetimeRescanTimer` in `src/lib/bot-loop.js`, every
   `poll.lifetimeRescanCheckMs` (30 minutes as shipped), retries a scan
   that did not finish. The request lives in memory, so a stop before
   the scan finishes drops it. A start therefore also recounts the
   deposits whenever the count stops short of the current NFT's mint,
   its `lastBlock` below the mint block (`depositsBehind`,
   `lifetimeScanPlan` in `src/lib/bot-recorder-lifetime.js`), so the coins
   that rebalance swept in still reach Total Lifetime Deposit.
   `clearPoolCache()` runs only from the Reload Current Position handler
   (`src/lib/server-reload-position.js`).

In short: **we start as far back as the lookback (five years as
shipped), but never before the pool itself was created, and never before
the last cached scan.** The three bounds compose, so the actual
`fromBlock` on any given call is
`max(now - lookback, poolCreationBlock, lastBlock + 1)`.

See also:

- [`src/lib/event-scanner.js`](../src/lib/event-scanner.js) — scanner entry point
  and cache integration
- [`src/lib/pool-scanner.js`](../src/lib/pool-scanner.js) — per-pool locking and
  scan orchestration
- [`src/lib/epoch-reconstructor.js`](../src/lib/epoch-reconstructor.js) — turns
  rebalance events into P&L epochs
- [`src/lib/cache-store.js`](../src/lib/cache-store.js) — disk cache with TTL

---

## Rebalance Event Caches

A rebalance event cache is LP Ranger's list of the rebalances in one
pool for one wallet: which NFT replaced which, and the transaction,
block and time at which the new NFT arrived. LP Ranger needs that list
for four things: the Rebalance Events table; the Per-Day P&L table's
periods, one per NFT; the floor of each NFT's own history scan, which is
its mint block ([Per-NFT Scan Windows](#per-nft-scan-windows)); and,
after a restart, the count of the position's rebalances since midnight
UTC, which the daily cap is checked against. The list comes from the
chain, and a pool's first scan reads up to five years of blocks as
shipped, in thousands of requests
([Lifetime History Lookback](#lifetime-history-lookback)). So the list
is kept on disk, and each later scan reads only the blocks since the one
before. A deleted file is rebuilt by the next scan, which pays that cost
again.

### Where the Files Are

Each file holds one wallet's list for one pool, in
`app-data/scan-cache/`, and is named:

```text
event-cache-<cacheTag>-<position manager>-<wallet>-<token0>-<token1>-<fee>.json
```

`cacheTag` is the chain's tag in `chains.json`, `pulse` on PulseChain.
The position manager and the wallet are cut to their first six hex
digits and the two coins to their first eight, all in lower case. The
fee tier is in millionths, so 2500 is 0.25%. For example,
`event-cache-pulse-cc05bf-111111-95b30398-a1077a29-2500.json` is the
PLSX/WPLS pool at 0.25% for a wallet whose address begins `0x111111`.
`eventCachePath` in `src/lib/cache-store.js` builds the name.

### What a File Holds

A file holds one entry, keyed by the same scope with whole, lower-case
addresses:

```text
rebalance:<wallet>:<position manager>:<token0>-<token1>-<fee>
```

The entry is `{ value, expiresAt }`. `expiresAt` is the moment the entry
lapses ([When a File Changes](#when-a-file-changes)), and `value` holds:

| Field                                                                 | What it holds                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events`                                                              | One record per rebalance, oldest first                                                                                                                                                                                                         |
| `lastBlock`                                                           | The last block the scans have read; the next scan starts at the block after it                                                                                                                                                                 |
| `chainFirstTokenId`, `chainFirstMintBlock`, `chainFirstMintTimestamp` | The first NFT minted to the wallet in the pool, and its mint. No record names it as a replacement, so its mint is kept here. Per-Day P&L's first row opens at it.                                                                              |
| `firstMintTokenId`, `firstMintBlockNumber`, `firstMintTimestamp`      | The oldest NFT the wallet has held in the pool, minted to it or sent to it, and its mint. Lifetime Days counts from it, the wallet's coins left over from the first deposit are read at its block, and no NFT's history scan starts before it. |
| `mintSchemaVersion`                                                   | `2`. An entry without it is from an older layout; the next scan ignores it and reads the pool's history again.                                                                                                                                 |

Each record in `events` holds `index`, its place in time order from 1;
`oldTokenId` and `newTokenId`; and the transaction that brought the new
NFT to the wallet, which for an LP Ranger rebalance is its mint, as
`txHash`, `blockNumber`, `timestamp` (Unix seconds) and `dateStr`.

A record this install added at its own rebalance
([When a File Changes](#when-a-file-changes)) differs in two ways. Its
`timestamp` is when the rebalance finished, not its block's time. And it
holds `swapSources`, the route the swap took, which the Rebalance Events
table shows as Routed Via. A scan does not read the route from the
chain, so a file rebuilt by a scan has none, and Routed Via shows a dash for
those rebalances; `app-data/rebalance_log.json` still holds each route
([Show Swap Route Even If Only Blockchain Data Available](roadmap/nice-to-haves/project_route_via_chain_scan_gap.md)).

A record also holds its Activity Log entry's figures
([Activity Log Figures](#activity-log-figures)): `walletReadings`,
`beforeRebalance`, `afterRebalance` and `historical`. A record still
waiting for them carries `figuresDue: true`. A record written before
the figures existed has none of these fields.

### How a Scan Fills a File

`scanRebalanceHistory` (`src/lib/event-scanner.js`) fills a file, called
through `scanPoolHistory` (`src/lib/pool-scanner.js`). In order:

1. **One scan per pool.** `scanPoolHistory` takes the pool's lock, so a
   second caller waits until the first scan has finished. Different
   pools scan at the same time.
2. **Where to start.** The scan reads the entry. With one, it starts at
   the block after `lastBlock`. With none, or one that has lapsed or is
   of an older layout, it starts at the history floor
   ([Lifetime History Lookback](#lifetime-history-lookback)). When
   `lastBlock` is already the chain's head, there is nothing to read,
   and the entry's records are the answer.
3. **What it reads.** It reads the position manager's NFT `Transfer`
   events to and from the wallet, in spans of `getLogsChunkSize` blocks,
   and the time of each one's block.
4. **This pool only.** It asks the position manager for each NFT's coins
   and fee tier (`positions()`), and keeps the transfers of this pool's
   NFTs. An NFT whose pool cannot be read, such as a burned one, is
   dropped.
5. **Pairing.** It pairs the transfers into rebalances, two ways:
   - an NFT leaving the wallet and another arriving within
     `rebalancePairingWindowSec` (five minutes as shipped);
   - each remaining NFT minted to the wallet, with the one minted before
     it: the way LP Ranger rebalances, draining the old NFT and keeping
     it.
6. **Writing.** It merges the new records with the entry's, one per
   transaction, numbers them in time order, works out the first-mint
   fields, and writes the entry back with `lastBlock` set to the last
   block it read. When the blocks read hold no transfer of any of the
   wallet's NFTs, only `lastBlock` changes; and if the entry has no
   records either, nothing is written, so the next scan reads those
   blocks again.

A span the endpoint fails to answer is skipped, so the scan can finish.
`lastBlock` then stops just before the first span skipped, so the next
scan reads from there.

Step 5 pairs only the transfers this scan read. A scan that starts after
`lastBlock` therefore cannot pair the first new mint it reads, since that
mint's predecessor is in the file rather than among them. Rebalances
this install makes are unaffected, because each adds its record itself
([When a File Changes](#when-a-file-changes)). A rebalance made outside
this install, by hand or by another install, gets no record when it is
that first new mint. Nothing reads the pool's history again on its own,
so the record stays missing until Reload Current Position clears the
file; the scan that follows reads every mint from the floor and pairs
it. The reload has two limits. It runs only for a managed position that
has finished syncing: its dialog says so otherwise and points to Manage,
and the server answers an unmanaged one 404. And it loses the route of
every rebalance this install added, so Routed Via shows a dash for
those rows ([What a File Holds](#what-a-file-holds)). The User Manual's
section "Rebalancing or Compounding Outside LP Ranger"
(`src/client/web/help-and-user-manual.html#outside-lp-ranger`) advises operators
to make their own moves from another wallet, and walks them through the
reload. The roadmap tracks recording such a rebalance without a reload
as
[Record Rebalances Made Outside LP Ranger Without a Reload](roadmap/nice-to-haves/project_rebalance_data_lag.md).

### When a File Changes

- **A successful rebalance adds its record** (`appendToPoolCache`,
  `src/lib/pool-scanner.js`, called from `src/lib/bot-loop.js`). It holds the
  pool's lock while it writes, so a scan under way cannot overwrite the
  record. It leaves `lastBlock` alone, so the scan the bot starts next
  reads the blocks up to the mint, keeping one record per transaction.
- **A scan pass finishes a record's Activity Log figures**
  (`updateCachedEvents`, `src/lib/pool-scanner.js`, called from
  `src/lib/bot-rebalance-figures.js`), under the same lock, changing only
  the records it finished.
- **Each write renews the entry.** An entry not written for
  `eventCacheTtlMs` (a year as shipped) lapses, and the next scan reads
  the pool's history again from the floor.
- **Clearing a file** makes the next scan read the pool's history again
  from the floor too. Reload Current Position, for a managed position,
  empties its pool's file (`clearPoolCache`, called from
  `src/lib/server-reload-position.js`);
  `node util/cache/clean-pool-cache.js` deletes one pool's files, for
  every wallet ([Cache Utilities](#cache-utilities)); and
  `npm run clear-blockchain-scan-cache` deletes every scan cache.

Apart from the file, a finished scan is held in memory and handed to
any caller asking for the same pool and wallet within `poolScanReuseMs`
(a minute as shipped).

### What Reads the Files

- **The bot**, for each managed position (`src/lib/bot-recorder.js`), and
  **the dashboard's view of an unmanaged position**
  (`src/lib/position-details.js`), both through `scanPoolHistory`.
- **The bookkeeping report**
  (`util/bookkeeping/coins-in-transactions-on-wallet`), which reads the
  files directly to list each rebalance
  ([Which Transactions It Lists](util/bookkeeping-for-coins-in-transactions/engineering.md#which-transactions-it-lists)).

---

## Deposit Count

Coins the owner sends to the wallet are money put in. The deposit count
records them as they arrive, so no figure reads them as the position's
gain.

Every poll credits the wallet's coins of the pool's two tokens to the
position in the Lifetime figures (the Wallet Residual, `walletResiduals`
in `src/lib/bot-pnl-updater.js`). A deposit sitting there was never the
position's. Until something counts it as money put in, Lifetime Net P&L
reads high by it, and so does the Lifetime IL/G. The Current IL/G and
the Impermanent Loss Guard count no coin in the wallet
(`src/lib/bot-pnl-il.js`), so a deposit moves them only once a compound
takes it into the NFT, and then through the compound's record, not
through this count. The Lifetime scan counts such coins too, but
only once a rebalance has minted them into a new NFT: it reads the
wallet's transfers in the window between one mint and the next
(`src/lib/lifetime-hodl.js`).

**The wallet's balance of a coin two pools share.** When the pools of two
or more running managed positions contain the same coin, WPLS for
example, the wallet's balance of it is divided between those positions,
so the Wallet Residual counts it once in all
(`src/lib/wallet-coin-share.js`). Each position's part is the amount of
the coin its own NFT contains at the current price, out of the amount
the NFTs of all those positions contain. Inside its range an NFT contains
some of each of its pool's two coins; outside it, only one of them and
none of the other. Each position works its own amount out at its check,
and takes each other position's amount as that position saved it at the
end of its last check (`positionStats`), so a position counts for the
others from the end of its first check until it stops. At both moments each other
running position whose pool contains one of its coins is checked again
at once (`src/lib/shared-coin-wake.js`), with the wake-up Rebalance Now
uses; a position whose scan is running is left to the check its scan
pass ends with, and nothing is woken while the app itself is stopping.
When none of those NFTs contains any of the coin, the balance is divided
by each position's value in dollars instead, each other position's value
as it published it at its last check, and evenly when none of them has
any value. A coin no other running position's pool contains is the
position's alone, whatever its NFT contains. A deposit of the coin
waiting in the wallet is divided the same way (**A coin two positions
hold**, below).

**What it counts.** The same transfers by the same rules, from the block
after the last one counted up to the chain's head, one entry per
transaction (`depositsInWindow`, `src/lib/wallet-deposits.js`, which the
Lifetime scan uses too). A swap, a collect or drain, and the position
manager's and pool's own transfers are left out; a wrap of the native
coin is credited once. So is every transaction the wallet sent itself,
read from each possible deposit's sender (`_sentByOthers`): every
rebalance and compound the bot makes, for any position, is one, while a
deposit is sent to the wallet by someone else. Without it, another
managed pool's drain, fee collection or swap, paying in a coin this pool
shares, counted as this pool's deposit, since none of this pool's coins
went out. A wrap counts though the wallet sends it: the native coins it
wrapped were never counted. A sender that cannot be read fails the
count. A count starts after the latest of three blocks:
the last block a move's count read (`countedThrough`), the newest mint
the Lifetime results cover (`lastBlock`), and the current NFT's mint,
before which deposits went into that mint. It waits while the Lifetime
results do not exist yet or the mint block is unknown. A count that
fails is logged and changes nothing, and the move goes on.

**When it counts** (`src/lib/deposit-count.js`):

- as the first step of every rebalance (`_executeAndRecord`,
  `src/lib/bot-cycle.js`) and every compound (`_executeCompoundInner`,
  `src/lib/bot-cycle-compound.js`), once the move holds the lock;
- when a poll sees the wallet's coins rise above what the last poll saw
  (`countDepositsOnRise`, injected into `updatePnlAndStats` the way the
  per-NFT figures are). The first poll after a start or a Reload always
  counts, and so does the first poll after a move's count: the move
  takes coins from the wallet, so a deposit arriving after its count
  can leave the wallet below what the last poll saw, and no rise would
  show it.

**Where it records.** A move's count is the record. Its deposits go into
the pool's Lifetime results in the epoch cache (`lifetimeHodlAmounts` and
`freshDeposits`): their coins into the lifetime holding, their entries
into the deposit list at their own blocks, each naming its transaction,
and how far the count read (`countedThrough`). `computeDepositUsd` then
prices the new entries into Total Lifetime Deposit, each at its own
block's price. A poll's count is held on the bot state instead
(`_depositOverlay`), priced the same way. The next move's count reads the
same blocks again and records its own answer in its place, keeping any
price the poll fetched. The overlay lives in memory, so a restart drops
it and the first poll counts again.

**Each deposit counts once.** When the Lifetime scan later reads the
window that ends at the next mint, it leaves out the transactions the
count recorded (`countedTx` in `computeLifetimeHodl`), and enters each
of the rest as the count would have: on its own, at its own block and
naming its transaction (`_freshDeposits`, `src/lib/lifetime-hodl.js`).
So Total Lifetime Deposit prices every deposit at its own block, and a
scan that builds the list again from the chain, as Reload Current
Position does, enters the same deposits the count recorded, at the same
blocks. Reload asks for their prices again, past the cache. With a
Moralis API key a past block's price comes back the same; without one
GeckoTerminal answers with the closing price of the deposit's UTC day,
so a deposit first priced during its own day can come back a little
different (see the README's Nice to Have's). A list an earlier version
saved holds each window it read as one entry at the mint's block,
naming no transaction; the scan keeps such an entry until the list is
built again, which the upgrade from 0.9.10 has the first start do (see
**Additions the Lifetime scan counts**, below). A
Lifetime scan that ran while a move's count was saved keeps that count
when it writes its results (`withLaterCounts`, used by
`computeAndCacheHodl`), which it
reads from the epoch cache; so a count writes the cache with the copy in
memory, before it prices the deposits. A scan that does not count again
keeps the results the bot holds rather than the copy it read when it
started. The other way round, a count saves into the results standing
when it saves, not those it read when it started, so a scan's newer
results take its deposits, and a deposit already saved is not added
twice. Total Lifetime Deposit is the total of the list standing when a
pricing ends (`computeDepositUsd`), whichever wrote it last. A price
that cannot be had leaves a deposit recorded, unpriced, until the next
pricing of the list. Reload
Current Position clears the epoch-cache entry, and the count's records
with it, and drops the overlay and the last wallet reading, so the first
poll after the rebuild counts from the current NFT's mint again. A count
still reading the chain when Reload clears the results is dropped, so it
cannot write the old results back over the rebuild.

**What the figures add** (`src/lib/counted-deposits.js`, pure):

- The Lifetime IL/G and Total Lifetime Deposit already hold the moves'
  counts, so they add only the overlay's entries after the newest mint
  covered (`pollDeposits`). A deposit of a coin another running position
  holds counts in them only where its coins went (below).
- A rebalance's Activity Log figure sets aside the deposits entered from
  the old NFT's mint up to the new one, the count's and the Lifetime
  scan's alike, with the entry an earlier version summed at the mint
  (`cachedDepositFor`, `src/lib/rebalance-activity-figures.js`); for a
  coin another running position holds, what the replay below shows the
  rebalance took (`depositTakenAt`).
- The Current IL/G and the Guard add no counted deposit: they count no
  coin in the wallet. A deposit that a compound takes into the NFT
  counts there from the compound's record, with the NFT's minted coins
  (`walletCoinsPutIn`), the same in the bot and in the unmanaged details
  view, which reads the compound list the bot saved
  (`savedWalletCoinsPutIn`, `src/lib/position-details-compound.js`).

**A coin two positions hold.** Each position counts the deposits of its
own two coins, so a deposit of a coin two running managed positions
hold is in both lists. Counted in full by each, it would be money put in
twice for coins that arrived once. So each such deposit counts where its
coins went (`src/lib/deposit-attribution.js`, the user's design,
2026-10-24):

- **while the coins wait in the wallet**, each position whose pool
  contains the coin counts the share of them the Wallet Residual (Pool)
  credits it (**The wallet's balance of a coin two pools share**, above;
  `fraction0`, `fraction1` from `walletResiduals`). What it counts as
  put in then matches the coins it is credited with, so the deposit
  moves none of its Lifetime figures. The share moves from poll to poll
  as prices move the coins in each NFT, and Total Lifetime Deposit with
  it;
- **a rebalance takes them all**, since it mints with the wallet's whole
  balance: from its mint on, the position it minted for counts every
  deposit of its two coins still waiting, and the others none of it;
- **a compound takes part**: of the wallet's coins its deposit took in
  beyond its fees, the deposits' part is in proportion to their share of
  the wallet's balance of the coin before the collect, which the
  compound now records (`amount0WalletBefore`, `amount1WalletBefore`,
  with the deposit's `blockNumber`). That part counts for the
  compounding position, and only the rest still waits. A compound
  recorded without the reading takes deposit coins first; one with no
  block recorded, or without its fees told apart, takes nothing.

Nothing is saved for it. Every poll, `depositAttribution`
(`src/lib/deposit-attribution-inputs.js`) replays each of the position's
two coins, in block order, over what the running positions of the wallet
hold (`_walletDepositStates`, attached by `attachMultiPosDeps` in
`src/lib/server-positions.js`): their deposit lists with what polls have
found since, their rebalance events, each at its new NFT's mint block,
and their compound lists. A deposit and a move in the same block are
taken in that order, as the Lifetime scan's windows end at a mint. It
answers how much the position's lifetime holding and Total Lifetime
Deposit change when the deposits it lists are replaced by its part of
every deposit of its coins (`lifetimeDepositFigure`, and `_computeIL` in
`src/lib/bot-pnl-il.js`). A deposit of a coin no other running position
holds comes out as before. A deposit brings one of its pool's coins,
never both: a transaction in which both come in is a drain or a fee
collection (`_isDeposit`, `src/lib/wallet-deposits.js`), and a wrap brings
only the wrapped coin. So a deposit's dollar figure (`usd`) is that one
coin's, and is divided as its coins are, with no further field kept.
Only the running positions take part, as only they share the Wallet
Residual: coins a stopped position's NFT took, or that left the wallet by
another route, such as a hand-minted position or a withdrawal, still
count as waiting.

**A compound that sweeps a deposit in.** A compound whose ratio swap
fires offers its deposit the wallet's whole balance
(`_resolveDepositAmounts`, `src/lib/compounder.js`), so the deposit can take
in coins the wallet held before the collect: a counted deposit, a
rebalance's leftovers, the coins the first mint left. None is a fee.
Recorded as compounded, such coins would raise Fees Compounded by their
size, and the Lifetime IL/G, which takes Fees Compounded off the
position's side, would read a loss of the same size. (The Current IL/G
would not move: it counts as put in only what a compound took beyond
the fees it records.) The compound therefore records the fees apart
(`src/lib/compounded-coins.js`):
it reads the wallet before its collect (`collectFees`) and just before
its deposit, and, coin by coin, what the deposit took from the wallet's
earlier balance is the first reading less the wallet after the deposit;
the rest of the deposit is fees. Its record keeps them
(`amount0Compounded`, `amount1Compounded`) beside the whole deposit, and
every reading of compounds counts them: the running total
(`recordCompound`), the per-NFT coins the bot reads back from the chain
(`applyCurrentNftFigures`, matched to the record by transaction), the
rebuilt compound list, and the unmanaged view. A compound with no such
record counts its whole deposit. The rest of the deposit, the wallet's
coins it took in, counts with the NFT's minted coins in the Current IL/G
and the Guard (`walletCoinsPutIn`), since the position's value now holds
them.

**Additions the Lifetime scan counts.** An addition of liquidity to a
position NFT after its mint is money put in only when another wallet
paid for it (`_additionsPutIn`, `src/lib/lifetime-hodl.js`). One the
wallet paid for took coins already counted: a deposit counted when it
reached the wallet, or the position's own leftovers and fees, which
Lifetime Net P&L counts as the Wallet Residual and the Initial Wallet
Residual. The addition's receipt decides: a transfer of either of the
pool's coins out of the wallet in its transaction means the wallet
paid. LP Ranger's own compounds pay from the wallet, so the scan skips
the receipt for one its compound list records as Auto or Manual. That
mark is not needed for the answer: Reload Current Position on a release
before this one emptied the compound list, and the rebuilt entries
carry no mark. An addition another wallet paid for counts all of it,
as a deposit entry of its own, at its own block and naming its
transaction (`kind: "external"`). An addition whose receipt cannot be
read stops the scan, which is tried again, rather than being counted on
a guess. The scan works the additions out again each time it recounts
the deposits, keeping only the price each one was given.

A list 0.9.10 saved can hold what this release would not build, in two
ways. It summed the deposits each rebalance's mint took in into one
entry at the mint's block, priced at the mint's day, which leaves the
total of those deposits the list keeps beside it larger than its
entries naming a transaction add up to; among them can be another
managed pool's moves, when the two pools share a coin. And it judged an
addition by the NFT's fees, so it can hold additions the wallet paid
for, filed at an NFT's mint block with nothing to mark them; such a
list adds up to more than its first mint plus that total. The upgrade
from 0.9.10 takes each list holding either out, with the saved Total
Lifetime Deposit of each position in that pool, whose positions the
pool's saved rebalance history names
(`util/migration/from-0.9.10/drop-old-deposit-lists.js`). A list holding
only its first mint stays, since this release would build the same one.
The first start then builds each list taken out again by this
release's rules and prices it. The saved total has to go too, since a
start that builds a list from nothing prices it only when no total is
saved.

**Fees the deposit could not take.** A deposit takes only what fits the
range, so without the swap, or with one coin short after it, some fees
stay in the wallet. They are the fee coins the compound's own
transactions left it with, after the swap (`feeCoins`), less the fees the
deposit put back; the record keeps them (`amount0FeesLeft`,
`amount1FeesLeft`) and a rebuild of the list keeps them with the other
fee fields (`_feesKept`). Worked out from the coins as collected instead,
they would be wrong whenever the swap ran, which turns part of one coin
into the other. Without the fee coins none are recorded, since the
readings alone cannot tell fees from a deposit that landed meanwhile.
The Current panel shows them on its Fees Left Over line, from
`currentFeesLeftUsd` (`feesLeftInWallet`, the bot in
`src/lib/bot-pnl-current-nft.js`, the unmanaged view from the saved list),
and a managed position's Profit adds them, since they are in neither fee
line and the Current IL/G counts no coin in the wallet; an unmanaged
position shows no Profit. The Current panel's Net P&L adds them too,
for both views, since they are outside Current Value. A later compound
can sweep them into the position, which Current Value then holds, but
Initial Deposit for This LP then counts them among the wallet's coins
that compound took (**The Current panel's deposit**, below), so they
still count once. The Lifetime IL/G still counts them as the wallet's
coins until a rebuild of the compound list counts every fee collected.

**The Current panel's deposit.** Initial Deposit for This LP, which the
Current panel's Net P&L subtracts, is the coins the NFT was minted with,
at its mint's prices, and the wallet's coins its compounds took in
beyond their fees, each at that compound's prices
(`src/lib/current-lp-deposit.js`). A compound whose swap runs deposits
the wallet's whole balance of the pool's two coins, so it can take in a
deposit the owner sent or a rebalance's leftovers; those coins were put
into the NFT after its mint, and left out of the deposit they would read
as the NFT's gain in Net P&L until the next rebalance. A compound's
prices are the ones the
bot recorded with it, else the price cache's at its block, as a rebuild
of the compound list prices it (`compoundPricesFor`; a rebuild keeps no
compound's prices), else today's, which flags the deposit as the mint's
own missing price does. A compound whose record does not tell its fees
apart adds nothing (`walletCoinsOf`). The bot publishes the addition as
`currentDepositAddedUsd`, with `currentDepositAddedFallback`
(`src/lib/bot-pnl-current-nft.js`); the unmanaged view works it out from
the compound list the bot saved (`savedDepositAdded`), in its first
step's Net P&L and on its second step's snapshot. A deposit the operator
types in replaces the whole figure.

**A deposit that lands while the compound runs.** The owner's coins can
reach the wallet between the two readings, while the collect or the
swap confirms, where the readings cannot tell them from fees. Two
figures come from the compound's own transactions instead. What the
collect brought in is the amount its transaction reports collecting,
the position manager's `Collect` event, capped at the wallet's rise
across it, which a token keeping a fee on each transfer lands short of
(`src/lib/compound-collect.js`); so a deposit landing then is neither
offered to a deposit that takes only the fees nor counted in the
compound's Activity Log figure. And the fees are capped at the fee coins
as those transactions moved them (`feeCoins`, `compoundFeeUnits`): what
the collect brought in, less what the swap's own transactions sent of
the token sold, plus what they received of the token bought, read from
their receipts (`exchange`, `src/lib/rebalancer-swap-balance.js`). A
deposit the swap's whole-balance deposit sweeps in then counts once, as
the owner's money. A swap whose receipt could not be read leaves the
readings alone to decide.

**Limits.**

- A deposit of a coin two managed pools hold is counted by each pool in
  full, as the Lifetime scan counts it in each pool's window after a
  rebalance, while the wallet credit splits the coin between the pools
  by their shares.
- Fees a compound leaves in the wallet, the ones its deposit could not
  fit, are not in Fees Compounded. The Lifetime IL/G counts them on the
  position's side, as the wallet's coins and, once a rebalance mints
  them, in the position's value, until Re-scan Prices or Reload Current
  Position rebuilds the compound list, whose total is every fee
  collected. The Current panel shows them on its Fees Left Over line,
  which its Profit and its Net P&L add.

---

## Activity Log Figures

Each Rebalance and Compound entry in the Activity Log shows two figures
under its date, as percents: a Rebalance's in whole numbers, a
Compound's to three decimal places, since the fees one compound collects
are often well under 1% of the position (`PCT_DECIMALS`,
`src/client/web/dashboard-activity-figures.js`):

- **Historical** is the figure at the moment the entry is created,
  right after the rebalance or compound succeeds. It is stored with the
  entry's record and never worked out again.
- **Current** is the same figure at today's prices. The browser works
  it out from the coins stored with the record, on every status answer,
  using the prices the server sends for the position
  (`pnlSnapshot.ilInputs`, the operator's price overrides applied).

A Rebalance entry's label reads "Impermanent Loss/Gain:", a Compound
entry's "Percent Gain for Position:". A figure not yet known shows a
dash. An entry written before these figures existed shows "Old Log:
Unavailable". Nothing rebuilds it on its own. Reload Current Position
rebuilds the position's records, the Activity Log's among them, and
reloads the page once its scan has finished. Re-scan Prices rebuilds
the compound list, working out from the chain the figures of each
compound that had none, and writes each compound's amount at the
prices of the moment it runs. As the last step of each scan of the
position on screen, on the status answer that first says the scan has
finished, the dashboard takes that position's Rebalance and Compound
entries off the log (`removePositionActivityEntries`,
`src/client/web/dashboard-activity-figures.js`, by the position's `poolKey`) and
the history pass draws them again from the records the scan left
(`src/client/web/dashboard-populate-history.js`): the figures, a Compound's
amount and its "(historical $usd)" mark, as the scan left them. No
answer before that one changes such an entry.

The log finds a position's entries by its pool key, which the server
sends only with a managed position's second data load. The first
brings the position's saved records, as the server starts it; the
second brings its pair, fee tier and pool key, once the server has read
it from the blockchain. So neither the live event check
(`src/client/web/dashboard-data-events.js`) nor the history pass draws a
managed position's Rebalance or Compound entries before the second
(`canDrawPositionEntries`): each is drawn with its position line and
filed under its pool. The history pass's own gate, which waits for a
running position's scan, could not hold this alone: while the server
starts a position, its loop is not yet running.

Both formulas are in `src/lib/coin-value.js`, which
the dashboard bundles, so the browser and the bot work the figures out
with one formula.

### Rebalance: Impermanent Loss/Gain

A rebalance mints with the wallet's whole balance of the pool's two
coins, so it reads that balance three times as it goes. It keeps the
three readings, in whole coins, as `walletReadings`
(`src/lib/rebalancer-execute.js`):

| Reading       | When it is read                                               |
| ------------- | ------------------------------------------------------------- |
| `beforeDrain` | before the old NFT is emptied (`src/lib/rebalancer-pools.js`) |
| `afterDrain`  | after the old NFT is emptied, before any swap                 |
| `beforeMint`  | after every swap, just before the mint                        |

The coins after the drain are everything the rebalance had to work
with, and the coins before the mint are the same coins once the swaps
are done. A deposit the owner made since the last rebalance sits in
both, though it was never part of the position, so it is set aside:

- `beforeRebalance` is `afterDrain` less the deposit;
- `afterRebalance` is `beforeMint` times the rebalance's share of the
  value: the value of `beforeRebalance` over the value of `afterDrain`,
  at the rebalance's prices.

Taking the deposit out as its share of the value never leaves a
negative coin, even when the swaps traded the deposit's coins with the
rest, and the deposit carries its share of the swaps' cost. The figure
is the value of `afterRebalance` less the value of `beforeRebalance`,
over the value of `afterRebalance`, times 100, both at one set of
prices; negative is a loss (`rebalanceIlPct`). At the rebalance's own
prices the share cancels out, so the Historical figure needs no
deposit, and the bot stores it the moment the rebalance succeeds
(`figuresAtCreation`, `src/lib/rebalance-activity-figures.js`). It is
priced as the panels price the position: the prices fetched right after
the mint, with the operator's price overrides applied
(`applyPriceOverrides`, `src/lib/price-overrides.js`).

**The deposit** is the one the Lifetime accounting already counts for
the rebalance's mint, in the epoch cache's `lifetimeHodlAmounts.deposits`:
the entries tagged `kind: "fresh"` after the old NFT's mint and up to
the new NFT's, each at its own block and naming its transaction. The
[deposit count](#deposit-count) records them as they arrive, and the
Lifetime scan enters the rest, whatever arrived after the count's last
read, the same way (`src/lib/lifetime-hodl.js`). The tag tells the
wallet's coins that went into the mint apart from an addition another
wallet paid for (`external`), which names its transaction but never
passed through the wallet, so it is no deposit waiting there. A list an
earlier version saved holds the scan's part as one entry at the mint's
block, naming no transaction, and an entry counted before the tag
existed counts as fresh when it is the first for its block. For a coin
another running position holds, the deposits a rebalance took are what
the replay of the running positions' deposits and moves shows still
waiting at its mint, whichever position listed them (`depositTakenAt`;
see [Deposit Count](#deposit-count), "A coin two positions hold"): one
may have gone into the other position's NFT first. The deposit is
capped, coin by coin, at
`beforeDrain`: a deposit a compound has since swept into the position
is no longer in the wallet; it came out with the old NFT's coins and
belongs to the rebalance.

**When the coin figures are written.** The Lifetime accounting counts a
mint's deposits in the scan pass that follows the rebalance, so the
record waits until then, marked `figuresDue: true`. A rebalance the
event scanner reads fresh from the chain, after a Reload or on a
position's first scan, carries the same mark (`src/lib/event-scanner.js`).
At the end of each scan pass, `finishPassRebalanceFigures`
(`src/lib/bot-rebalance-figures.js`) finishes every marked record whose
mint the deposits cover, the cache's `lastBlock` being at or past the
mint block:

- the readings come from the record, else from this install's
  `app-data/rebalance_log.json`, else from the chain: the wallet's
  balances at the end of the block before the drain, the drain's block,
  and the block before the mint. The drain is the old NFT's latest
  `DecreaseLiquidity` at or before the mint, found among the NFT events
  the pass has already read (`drainBefore`, `src/lib/nft-move-rules.js`);
- the prices come from the log, with the overrides applied, else from
  the historical-price lookup at the mint block, which the epoch
  rebuild has usually cached already.

The finished record goes into the pool's event cache
(`updateCachedEvents`, `src/lib/pool-scanner.js`), into the bot's list of
the position's events, and out with the next status answer. A record
stays marked while the deposits do not cover its mint, or while it
needs the chain and the pass could not read the NFT events; the next
pass tries again. A pass prepares that read whenever a marked record
has no readings of its own, even when nothing else in the pass reads
the chain (`prepareSharedRead`, `src/lib/shared-chain-read.js`). So a record
left marked by a stop during an earlier pass, after every Lifetime
figure was saved, is finished by the next pass, the one a restart runs
included. A price that does not come back, a wallet reading that fails, as
on an endpoint that keeps no past state, or a drain that cannot be
found, finishes the record with those figures null, which the Activity
Log shows as dashes. Reload Current Position reads every event again,
so each is marked once more, and a Historical figure stored as a dash,
on the record or in the rebalance log, counts as missing: its prices
are asked for again (`_withFigure`), and a lookup that again answers
nothing leaves the dash.

### Compound: Percent Gain for Position

The figure is the fees the compound collected, as a share of the
position right after it. The fees and the deposit are different coins:
the deposit takes only what fits the range, leaving the rest in the
wallet, and a ratio swap can sweep in coins that were already there.
Using the fees keeps a deposit the owner made from counting as a gain.

Within one NFT, at one set of prices, value is proportional to
liquidity. So the share is the fees' value times the liquidity the
deposit added, over the deposit's value times the NFT's liquidity after
the deposit, times 100, and no snapshot of the position is needed
(`src/lib/compound-activity-figures.js`). A compound records
`feesCollected`, in whole coins, and `historical.percentGainForPosition`
the moment it succeeds (`recordCompound`, `src/lib/bot-cycle-compound.js`).
A figure it cannot work out is null, as is one without a price for each
coin, and the compound is recorded all the same. Current is
`feesCollected` at today's prices over the position's value today.

**A rebuild of the compound list** works the figures out for every
compound it finds. A rebuild runs on Reload Current Position, Re-scan
Prices, a position's first lifetime scan, and a reclassify request
(`_classifyAllCompounds`, `src/lib/bot-recorder-lifetime.js`). The collect
is the NFT's latest `Collect` within one span of `getLogsChunkSize`
blocks before the deposit, with no other deposit after it
(`collectBeforeDeposit`, `src/lib/nft-move-rules.js`). A deposit with no
such collect is the owner's own coins, and its figure is 0%. The
liquidity before the deposit is the running total of the NFT's events.
The prices are those at the deposit's block, through the historical-price
cache, which keeps each under its block (`compoundPricesFor`). With a
Moralis key stored, Moralis prices each coin at that block. Without
one, or for a coin Moralis has no price for, GeckoTerminal's candle for
the day does. Two compounds on one day are two lookups. A price lookup
that fails, or finds a price for only one coin, gives no figure. The
entry then keeps the figure it already held, from an earlier rebuild
(`_chainOrEarlier`), since Re-scan Prices reads past the price cache
and a failed lookup there is no reason to forget a figure. An entry
that held none stays null, and the next rebuild works it out again.

The rebuild keeps what the chain cannot supply. A compound the bot
recorded when it happened, trigger `auto` or `manual`, keeps its
trigger and figures, matched by transaction. A figure it recorded as
unknown, for want of a price at the time, is worked out from the chain
like any other, at the deposit's block, keeping the trigger; a lookup
that again answers nothing leaves it unknown. One the bot recorded after
the rebuild's chain read began stays in the list, since the read could
not have seen it. A compound found only on the chain gets trigger
`unknown`, and the Activity Log shows it with no marker.

A Compound entry's $usd amount (`usdValue`) is the deposited coins at
the prices of the moment its record is written. The bot's own record of
a compound keeps those prices (`price0`, `price1`), and the Activity Log
marks such an amount "(historical $usd)" (`src/client/web/dashboard-compound-log.js`).
A rebuild writes every entry's amount at the prices it is handed,
today's, with the operator's price overrides applied as the poll applies
them (`_readCurrentPrices`, `src/lib/bot-recorder-lifetime.js`), and without
prices (`_entryOf`), so its entries show no mark: a compound the bot
recorded loses its mark, and its amount is the rebuild's. When the scan
has no price for a coin, the amount it would write counts only the other
coin, so an entry keeps its amount and the prices it was worked out at,
mark and all (`_amountOf`). A compound recorded during the rebuild's
chain read is kept as recorded, mark and all.

Because the rebuild needs the old list, Reload Current Position and
`npm run clear-blockchain-scan-cache` leave `compoundHistory` in place
([POST /api/position/reload](#post-apipositionreload)).

### One Entry per Transaction

The dashboard keeps one record of the Rebalance and Compound entries
the Activity Log shows, keyed by kind and transaction hash
(`src/client/web/dashboard-activity-figures.js`). It is JavaScript state, never
read back from the page. `act()` (`src/client/web/dashboard-helpers.js`) draws
no entry the log already shows: the live-event check and the history
pass can both reach one rebalance or compound, and switching positions
runs the history pass again. The same record is how each status answer
brings Current up to date, and fills in an entry drawn while its
figures were due. Each entry in it also carries its position's
`poolKey`, which is how the end of a scan takes that position's entries
off before the history pass draws them again; an entry with no
transaction hash is kept under a key of its own, so it comes off too
rather than gaining a copy at each redraw. The log forgets an entry
when it trims it, and every entry when it is cleared.

A Rebalance entry names what started the rebalance, (Out of Range),
(Manual) or (Residual Cleanup), from its record's `trigger`, in the one
wording both paths draw it with (`src/client/web/dashboard-rebalance-log.js`).
The bot puts `trigger` on its own event list and on the pool's event
cache (`_buildEventEntry`, `src/lib/pool-scanner.js`), so the label survives
a page reload and a redraw. A rebuild of the event list from the chain
cannot know it; when the finishing step finishes such an event, it takes
`trigger` back from this install's rebalance log
(`loggedRebalanceFigures`, `src/lib/rebalance-activity-figures.js`), which
has kept it for every rebalance. A rebalance this install did not make
names nothing.

`util/bookkeeping` finds the same transactions on the chain for its
reports, so the two rules that pair a move's transactions,
`drainBefore` and `collectBeforeDeposit`, are in
`src/lib/nft-move-rules.js`, which both use.

### Limitations of the Figures

- A rebalance retried after an earlier attempt swapped and stopped
  starts its readings after that first swap, so the first swap's cost
  is not in its figure.
- A rebalance rebuilt from the chain whose old NFT was emptied well
  before the new mint, by hand or by another tool, is read around that
  earlier emptying, so its figure takes in whatever the wallet did in
  between.
- A deposit that arrives during a rebalance, after the drain and before
  the mint, counts as a gain.

---

## Per-NFT Scan Windows

The section above bounds the scan for **rebalance events**, which are
per *pool*. A second family of scans is per *NFT*: the
`IncreaseLiquidity` / `Collect` / `DecreaseLiquidity` history behind
compound detection, HODL baselines and lifetime P&L. Those run once for
every NFT in a position's rebalance chain, so a long chain multiplies
whatever the per-NFT window costs.

Every such scan is floored at the NFT's own mint block, taken from the
rebalance events the caller already holds. **No extra RPC call is made
to derive it.** An NFT cannot emit any of those events before it
exists, so every block before its mint is a guaranteed-empty walk.

**There is no upper bound. Every scan runs to the chain head.**

An upper bound could only come from the app's inferred succession, and
that inference is not sound enough to bound a scan with. `pairTransfers`
reads consecutive mints as successive rebalances, which holds only when
every mint in the pool *is* a rebalance. A dust mint — a failed or
partial rebalance, or a manual action — is indistinguishable from a
real one in the Transfer log, so the NFT it appears to replace can still
be funded and drain later.

Bounding there truncates the scan, and the loss is silent in both
directions it can land:

- an NFT whose drain falls past the bound returns **zero** Collects, is
  reported as "incomplete data", and its epoch disappears from the
  Per-Day P&L table;
- an NFT that compounded mid-life returns the **compound's** Collect,
  which `_supplementExitFromChain` then reads as its exit value.

`src/lib/nft-mint-blocks.js` owns the floor rule:

| Function | Answers |
| --- | --- |
| `mintBlocksByTokenId(events)` | tokenId → mint block |
| `nftScanFrom(mints, id, sharedFloor)` | where one NFT's scan starts |
| `nftScanFromBlock({mintBlock, sharedFloor})` | the same, for a caller holding the block rather than the events |
| `chainScanFloor(events, poolFloor)` | the floor for the chain's oldest NFT |

Three rules within that module decide correctness:

- **A repeated id resolves to the *earliest* block.** A floor above an
  NFT's first event drops those events from the scan, and the caller
  reads the short result as "the event never fired". Erring wide costs
  only time.
- **`nftScanFrom` combines with `Math.max`, not by replacement.** The
  shared floor is the pool's floor: its creation block, or a later
  bound such as the chain's first mint. An NFT has no events before its
  own mint, and the scan reads nothing before the floor. So the later of
  the two is the one to use.
- **The chain's oldest NFT has no mint block in the events**, because it
  appears only as an `oldTokenId`. `chainScanFloor` supplies one: it
  raises the pool's creation block to `events.firstMintBlockNumber`, the
  chain's own first mint as resolved by the event scanner. No NFT in the
  chain predates that block. On a pool older than the wallet's first
  deposit this is the difference between that NFT's scan and every
  other's.

  That NFT also needs its own mint date, for the opening row of the
  Per-Day P&L table, and `_applyFirstMint` in `src/lib/position-history.js`
  takes it off the events array rather than reading chain. Two fields
  can supply it, and both are gated on a token id:

  | Field | Records | Names the chain's first NFT |
  | --- | --- | --- |
  | `chainFirst*` | earliest arrival that was a **mint** | always |
  | `firstMint*` | earliest arrival of **any kind** | only when no NFT arrived by transfer |

  `resolveChainFirstMint` produces the first pair; it is pure, because a
  direct mint needs no follow-back — the arrival *is* the mint.
  `resolveFirstMintWithForeign` produces the second, for Lifetime Days,
  and follows a transferred-in NFT back to its true mint.

  The id gates are what keep the two apart. `pairTransfers` builds the
  chain from mints only, so an NFT that arrived by transfer is never a
  link in it — and on such a pool `firstMint*` names a different NFT
  entirely. Using its block would date the chain's first NFT from
  another NFT's mint. `chainFirst*` is preferred because its id always
  matches; `firstMint*` is the fallback for caches written before
  `chainFirst*` existed, and a mismatch on both falls through to
  `supplementMintFromChain`.

### Cost

Every RPC request in the process is released by the global request queue
(see
[RPC Request Pacing and Log Chunking](configuration.md#rpc-request-pacing-and-log-chunking)),
so a scan's wall-clock time is its request count times the queue's
interval: 222 ms as shipped, about four and a half requests a second.
Chunk width is `getLogsChunkSize`, 9,000 blocks as shipped.

For a 132-rebalance chain in a pool created two years before the first
deposit, reading all three event types, as the lifetime scan does:

| Window | Chunks | ~133 NFTs |
| --- | --- | --- |
| pool creation → head, per NFT | 954 each | ~26 hours |
| NFT mint → head, per NFT | up to 168 each | hours |
| **chain's first mint → head, once** (what runs) | 168, shared by every NFT | minutes |

The batched read carries at most 100 ids per filter, so 133 NFTs take
two id groups. That makes 168 chunks × 3 event types × 2 groups, or about
1,000 requests. At the queue's rate, with nothing else in the queue, that
is nearly four minutes. Measured times are under
[One read per pass](#one-read-per-pass).

An upper bound would cut the per-NFT walk to one or two chunks per
retired NFT, but no sound upper bound exists — see above. Reading the
chain in one batch gets the same saving without one: each block is read
once for the whole chain, rather than once for every NFT minted before
it.

### Batched chain reads

Every read of a whole chain is one pass, not one pass per NFT. Two
places read a chain, both through `scanChainNftEvents`
(`src/lib/nft-events-batch.js`):

| Reader | Events | NFTs | Serves |
| --- | --- | --- | --- |
| `fetchAllNftEvents` (`src/lib/bot-recorder-scan-helpers.js`), prepared by `prepareLifetimeRead` | all three | the whole chain | the bot's lifetime scan — Fees Compounded, lifetime HODL, deposit — and epoch reconstruction in the same pass |
| `scanChainCollectAndDrain` (`src/lib/position-history-scan-helpers.js`) | `Collect`, `DecreaseLiquidity` | closed NFTs not already in the epoch resume buffer | epoch reconstruction, when nothing else in its pass reads the chain |

The unmanaged view's `_detectCurrentNftValues`
(`src/lib/position-details-compound.js`) is not a chain reader: it scans the
one NFT being looked at (see [Call sites](#call-sites)).

The filter OR-matches every token id in the chain — `tokenId` is the
first indexed parameter on all three events, and a topic slot accepts an
array. The request covers the union of the NFTs' windows, from the
lowest floor in the set to the head; the node does the filtering, so the
same logs come back in one response set rather than one per NFT. A
reader names the event types it uses (`eventNames`) and pays only for
those, since each type is a full pass over the union.

Moving token identity from the request to the response is what needs
care, and five rules carry it:

| Rule | Why |
| --- | --- |
| Logs are partitioned by `topics[1]`, not decoded first | Routing must not depend on the ABI being right about the unindexed fields |
| Each NFT's logs are re-floored to its own window | The union request starts below most NFTs' floors; without this the batch returns events a per-NFT scan excludes |
| Each NFT's logs are sorted into chain order | `classifyCompounds` reads an NFT's FIRST `IncreaseLiquidity` as the mint deposit, and the exit value is an NFT's LAST `Collect` |
| Every requested id gets an entry, and `eventsFor` throws for one that was not requested | A missing key would otherwise read as "no history" — a closed epoch with no fees |
| An entry carries only the event types fetched | A consumer reaching for a history nobody requested fails on `undefined` instead of reading `[]` as "never happened" |

The head is resolved once for the whole batch. The id list is split into
groups of 100, so no request carries more than 100 ids in its topic
array, however long the chain.

Each reader prepares its read before anything consumes it, from the same
inputs its consumers use:

- **Epoch reconstruction** gets its histories before building any
  epoch, for exactly the NFTs the loop will fetch — from the pass's
  shared read when there is one (below), otherwise from its own. Each
  NFT's slice reaches `getPositionHistory` as `collectAndDrain`.
  Omitting that option — the single closed-position history route —
  reads the one NFT on its own; `null` means the chain read was
  unusable, and is never replaced by a per-NFT read.
- **The unmanaged view** reads no chain. It shows no Lifetime panel and
  no Per-Day P&L, so it has nothing a whole-chain history would answer.
  `_detectCurrentNftValues` reads the one NFT being looked at, floored
  at that NFT's own mint block, for the Current panel's Fees Compounded
  and Gas; where those coins are already on disk, `savedNftCompoundedUsd`
  answers without any scan. The pool's Transfer scan still runs — it is
  what the Rebalance Events table is built from, and it is a different
  read from the per-NFT walk.

#### One read per pass

A scan pass can need the chain's history three times: epoch
reconstruction wants Collect and DecreaseLiquidity for the closed NFTs,
the lifetime figures want all three event types for every NFT, and a
Rebalance event waiting for its Activity Log figures with no wallet
readings of its own wants its old NFT's DecreaseLiquidity, to find the
drain. The others are subsets of the lifetime read, so when it is going
to be made in that pass, reconstruction takes its histories out of it
(`collectAndDrainOf`) rather than making its own, and the figures find
their drains in it. A read shared this way is made once however many
consumers ask (`shareRead`).

- **The bot.** `_scanAndReconstruct` asks as soon as the event scan has
  found the chain (`prepareSharedRead`, `src/lib/shared-chain-read.js`).
  When the lifetime scan will read (`lifetimeScanPlan`), or a waiting
  Rebalance event has no readings of its own (`figuresNeedNftEvents`),
  the pass prepares the read (`prepareLifetimeRead`,
  `src/lib/bot-recorder-lifetime.js`) and hands it to reconstruction; the
  lifetime scan and the figures then use the same read. When the read
  runs, it looks up the pool's creation block and decides whether the
  resume buffer can still be trusted, and whether to use it at all: a
  read that runs while the plan finds no lifetime figures to work out,
  as one for the figures alone does, uses none. The lifetime scan's
  success releases the buffer, and such a read can run after that, so
  one it refilled would stay held into a later scan.
- **The unmanaged view.** Nothing to share: it builds no epochs, because
  it renders no Per-Day P&L, and reads no chain.

Three rules keep the sharing sound:

| Rule | Why |
| --- | --- |
| Reconstruction shares only a read another step will want | Otherwise it pays for a third event type and the live NFT to save nothing; with nothing else reading, its own two-type read is cheaper. A waiting Rebalance event whose readings turn out to be in the rebalance log never asks for the read, so in that rare pass reconstruction pays for the larger read alone |
| A shared read covers each NFT's whole history | Reconstruction values each closed NFT over its whole life. A lifetime read always starts from the pool's creation block, lifted to the chain's first mint. That holds even if every figure is saved after the read was prepared. `test/bot-recorder-lifetime-share.test.js` pins it for every state |
| The lifetime scan reuses the pass's read only for the chain it was prepared for (`chainSignature`: the live NFT, every NFT with its mint block, and the chain's first mint) | Reconstruction can run long enough for a manual rebalance to land. A read prepared before it describes a chain that no longer exists, so the scan reads afresh and logs why |

A batch succeeds or fails as a unit, and each reader decides what a
failure means:

- **Lifetime scan** — the resume buffer stores nothing from a failed
  read, and the retry asks for every NFT not already buffered.
- **Epoch reconstruction** — every NFT in the pass takes its history as
  unknown, the same answer a failed per-NFT read gives. An NFT whose
  exit value and fee the rebalance log already holds still builds; the
  rest are skipped, and the short history schedules another attempt.
- **A shared read** — the failure is not kept, so the next consumer in
  the pass or request makes its own attempt rather than inheriting it.
  The Activity Log figures are one consumer, asking once for all their
  waiting Rebalance events (`_nftEventsOnce`), so a failure leaves them
  all waiting for the next pass rather than starting a read for each.

That is affordable because a chain costs minutes, and because transient
RPC failures are retried per request beneath the batch.

Measured reading every NFT in a chain for the lifetime scan, at the
default request pacing:

| Chain | Batched | One pass per NFT |
| --- | --- | --- |
| 40 NFTs | 3.6 min | 1 h 56 min |
| 133 NFTs | 6.5 min | 5 h 30 min |

`test/nft-events-batch.test.js` pins that a batched read returns, for
every id, what a per-NFT scan returns, and
`test/position-history-scan-chain.test.js` pins the same for each
closed NFT's Collect and DecreaseLiquidity history.

### Call sites

The two chain readers in the table above each hand the batch the
chain's mint blocks, so every NFT is floored at its own mint.

Three places read a single NFT, floored at that NFT's own mint:
`src/lib/bot-pnl-current-nft.js` and `_detectCurrentNftValues` in
`src/lib/position-details-compound.js` read the current NFT, and
`src/lib/position-history.js` reads a closed position looked at on its own.
The last takes its floor from `result.mintBlockNumber`, which
`supplementFromEvents` fills from the rebalance events before any scan
runs.

`test/nft-scan-floor-coverage.test.js` enforces this. It identifies a
per-NFT scan two ways — by helper name (`scanNftEvents`,
`detectCompoundsOnChain`, `scanCollectAndDrain`, and the batched
`scanChainNftEvents` / `fetchChainNftEvents`) and by shape, where a
chunked scan whose `label` interpolates a `tokenId` is per-NFT whatever
the helper is called. The shape detector is what covers a helper the
list does not yet name. Each matched file must either require
`nft-mint-blocks.js` or hold an entry in the test's `EXEMPT` map giving
the reason. Each chain reader must also pass the chain's mint blocks to
the batch; an empty map would floor every NFT at the shared floor.

`src/lib/compounder.js` is exempt because it defines the single-NFT scan and
leaves the floor to its caller. Three files are exempt because they
search *for* a mint block and so cannot be bounded below by one:
`src/lib/event-scanner-mint-lookup.js`, which instead stops at the first
chunk that yields a hit, `src/lib/hodl-baseline.js` and
`src/lib/position-history-mint.js`.

### The dashboard does not scan a position the bot owns

The dashboard's unmanaged-details path computes the same per-NFT
history the bot computes for a position it manages. Running both is two
full passes over every NFT in the chain, so the dashboard suppresses its
fetch for a managed position.

`shouldSkipUnmanagedFetch()` in `src/client/web/dashboard-unmanaged.js` is the
decision, consulted from `flushPendingUnmanagedFetch()`. It takes two
inputs and suppresses only when **both** hold: a `/api/status` response
has landed, and that response reports the position as managed.

`hasPolled` is required because `isPositionManaged()` reads a Set that
is restored from `localStorage` on page load for instant badge render.
Before the first response arrives that Set is a carry-over from a
previous session, and the server may have retired the position while
the page was closed. Suppressing on it would leave a genuinely
unmanaged position with nothing to populate its KPIs.

After the first response the value is authoritative. The server's
`managedPositions` (`src/lib/handle-api-status.js`) is the union of live bot
loops **and** positions whose saved status is `running` but whose loop
has not started yet, so a position the bot is about to pick up already
reads as managed. This matters because the bot starts positions on a
stagger, and the fetch flush fires at wallet unlock.

---

## Client-Side URL Routing

The dashboard uses Navigo (pushState-based router, ~5 KB) for bookmarkable,
shareable URLs that reflect the active wallet and position.

### URL Structure

- `/` — Root (no state)
- `/pulsechain/:wallet` — Wallet loaded, no position selected
- `/pulsechain/:wallet/:contract/:tokenId` — Specific NFT position deep-link

Example:
`/pulsechain/0x1111111111111111111111111111111111111111/0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2/157149`

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
4. If the position is not in the store → trigger `scanPositions()` and look
   again when it finishes. A scan asked for while one runs gets that
   scan's result, so the running scan is waited for, not raced.

### URL Updates

When the user selects a position or imports/clears a wallet, the URL bar is
updated via `router.navigate()` with `callHandler: false` (no page reload,
no re-triggering of route handlers). Addresses are lowercased in URLs.

Source: [`src/client/web/dashboard-router.js`](../src/client/web/dashboard-router.js)

---

## Shared Help Copy

Some help text has to appear in two places at once: a circle-i dialog,
beside a setting in Bot Configuration or on a dashboard card, and the
corresponding section of the User Manual that GitHub Pages publishes. Written twice, the two drift on
the first copy-edit — and the Telegram alert links readers to the
published page, so a stale manual is what the operator reads when
something has already gone wrong.

[`src/lib/shared-help-content.json`](../src/lib/shared-help-content.json)
is the single source. Two consumers read it and neither holds its own
wording:

- [`src/client/web/param-help-content.js`](../src/client/web/param-help-content.js)
  imports it for the in-app dialog. The import needs the
  `with { type: "json" }` attribute — esbuild bundles a bare JSON import
  happily, but Node's native ESM loader, which the test suite uses to
  import the module directly, rejects it with
  `ERR_IMPORT_ATTRIBUTE_MISSING`.
- [`scripts/build-manual-content.js`](../scripts/build-manual-content.js)
  renders it into `src/client/web/help-and-user-manual.html` between per-entry
  marker comments, on every `npm run build`, `npm run lint` and
  `npm run check`:

```html
<!-- HELP:inIlGuard:START -->
...generated, do not edit...
<!-- HELP:inIlGuard:END -->
```

An entry with a `manualHeading` renders as a whole section: an `<h2>`
whose id is its `manualAnchor`, then an `<h3>` and a paragraph for each
of its sections, as the Impermanent Loss Guard's (`inIlGuard`) does. An
entry without one renders as its sections alone, for part of a section
the manual writes by hand around the markers. The Activity Log's
"Historical and current prices" (`activityLogPrices`) is one: the
Activity Log's circle-i shows it after its own section.

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
  `_comment` keys and `manualBaseUrl`, which a filter on names would
  sweep in and crash the build on.

`manualBaseUrl` plus an entry's `manualAnchor` is also where
[`src/lib/il-guard.js`](../src/lib/il-guard.js) builds the deep link its Telegram
alert carries, so the anchor exists in exactly one place. That read is
guarded: an unguarded `require` of a file under `src/client/web/` would let a
malformed help file take `bot-cycle` down with it and stop the bot from
starting at all. A missing or broken file degrades to an alert without a
link.

### Figures the help quotes

Help quoting a setting's default, range or timing reads the number the
install runs on rather than repeating it, so the copy follows the
setting whether a release or the operator changes it.
[`src/lib/help-figures.js`](../src/lib/help-figures.js) works out one table of
named figures, plain text worded for a sentence ("15", "4 hours",
"10m → 20m → 40m → 80m"), and the copy's worked examples, such as the
Impermanent Loss Guard's and the NEAR LIMIT badge's, so those stay true
when their values change. The chain and its aggregator are named the
same way, from chains.json, so no help names a chain or aggregator it
was written for. A chain with no aggregator is worded apart: the
dialogs branch on an empty `aggregatorName`, and the manual's prose,
which cannot, quotes `aggregatorInUse`, which reads "none" there.
Whether a chain has one is
[`src/lib/aggregator-in-use.js`](../src/lib/aggregator-in-use.js)'s answer,
the same one the swap and the "Route:" badge act on.

[`src/lib/resolved-settings.js`](../src/lib/resolved-settings.js) resolves the
values on the server in the bot's order: the shipped file, the
operator's copy in `app-config/user-configurable/`, then `.env` (from
`src/lib/config.js`) where it can set one. Ranges come from the shipped
`setting-bounds.json` alone, since a range an override could widen would
bound nothing. The slippage confirmation tiers and the NEAR LIMIT
threshold are the values the server sends the page (see
[The Dashboard's Three Settings Files](#the-dashboards-three-settings-files)).
`GET /api/help-figures` returns the table with the Bot Configuration defaults
behind it, the same ones `GET /api/bot-config-defaults` returns, so the
inputs and their Default buttons agree with the help.

The figures reach the copy three ways:

- **Shared copy** in `shared-help-content.json` writes
  `{{figure:name}}`, which both consumers fill; the manual's build puts
  it inside a `<span data-figure="name">`.
- **The manual's own prose** wraps each figure in
  `<span data-figure="name">…</span>`. The manual build writes the
  shipped figures in, and the GitHub Pages copy keeps them. The copy the
  app serves loads the build's stamped bundle of
  [`src/client/web/dashboard-manual-figures.js`](../src/client/web/dashboard-manual-figures.js),
  `src/client/web/dist/manual-figures.js`, which rewrites the spans from
  `GET /api/help-figures`; the Pages build drops that tag.
- **The dashboard's static help** in `index.html` holds empty
  `<span data-figure="name"></span>` elements, filled by
  [`src/client/web/dashboard-help-figures.js`](../src/client/web/dashboard-help-figures.js)
  once the server answers. It asks at startup, again until answered,
  without holding startup up. A dialog builds its copy from the same
  table when it opens, and does not open before the answer. The Doubling
  Trigger Window label reads the defaults that came with it.

A name the table lacks stops the manual build, and a test checks every
name in the dashboard's markup.

---

## Development Tools

All dev tools are available via npm scripts — no `npx` needed.

**The npm scripts themselves are documented in
[`docs/npm-project-commands.md`](npm-project-commands.md)**, which is the
single place every command, flag and example lives:

| You want to | Go to |
| ----------- | ----- |
| Build, start, or stop | [Lifecycle Commands](npm-project-commands.md#lifecycle-commands) · [Stopping a Running Install](npm-project-commands.md#stopping-a-running-install) |
| Lint, test, or run the full gate | [Test](npm-project-commands.md#test) |
| Know what a gate writes to before you Ctrl-C it | [Before Running Any Lint or Test Command](npm-project-commands.md#before-running-any-lint-or-test-command) |
| Reset a wallet or a scan cache | [Wallet and Scan-Cache Resets](npm-project-commands.md#wallet-and-scan-cache-resets) |
| Clear logs, node_modules, or settings | [Housekeeping](npm-project-commands.md#housekeeping) |
| Find circular imports | [Dependency Cycles](npm-project-commands.md#dependency-cycles) |
| See any command's flags | [Getting Help on Any Command](npm-project-commands.md#getting-help-on-any-command) |

What remains below is not an npm script: the `util/` tools, which are run
directly with `node`, and the architecture behind the Pages preview.

### Previewing the Screenshot Gallery

```sh
npm run show-gallery
```

Serves the Screenshot Gallery at **<http://127.0.0.1:5557/screenshot-gallery.html>**
exactly as GitHub Pages will publish it. Independent of the dashboard
(port 5555) and the API reference (5556), so all three can run at once.

**Why a script is needed at all.** The gallery cannot be opened straight
off disk. Its three inputs live in three places — the page and CSS in
`src/client/web/`, the self-hosted fonts under `node_modules/@fontsource`, and
every screenshot in `docs/images/` — and the page references images as
`images/…`, which resolves next to the HTML rather than into `docs/`.
Opening `src/client/web/screenshot-gallery.html` in a browser therefore shows a
page with no images whatsoever.

[`scripts/build-pages-site.js`](../scripts/build-pages-site.js) assembles
those pieces into a target directory, rewriting the absolute, stamped CSS
hrefs (`/style.css?v=…`) to relative ones and dropping the manual's
script, which asks the running app.
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

With one builder behind the local preview (`npm run show-gallery`) and
the deploy, the preview cannot drift from what deploys.
Only the two CI-only steps remain in YAML: `npm ci` and `copy-fonts`
populate `src/client/web/fonts/`, which the builder then copies. A preview must
not run those, because `npm ci` wipes and reinstalls `node_modules`.

`readSpec()` throws on a missing or malformed spec rather than falling
back to a default. A silent partial build would publish a site with pages
or assets quietly absent, which is worse than a failed deploy.

When changing the assembly, verify equivalence rather than trusting it:
assemble both ways into two directories and `diff -r` them. The failure
this catches is a page silently paired with the wrong stylesheet, which
renders without erroring and looks plausible until someone opens it.

The builder covers all three published pages — the gallery, the User
Manual, and the disclosure — so the preview surfaces breakage in any of
them, not just the gallery.

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
checks. Separate lists drift: one gate quietly checks fewer files than
another, and a file no gate covers looks verified.
`test/lint-targets.test.js` fails if a parallel list reappears.

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
instead of leaving it dark. Tests do not move with the tool: every
`util/` test lives in `util/test/`, whatever category the tool belongs
to, since `npm run test:util` globs `util/test/*.test.js`.

#### Diagnostic Utilities

`util/diagnostic/` holds Node.js tools for investigating on-chain state
and bot data. End users run these when something looks wrong. All eight
take CLI args and write to stdout (redirect to `tmp/` for logs). Seven
are read-only; `rescan-pool-history.js` changes saved state, and asks
first.

**Arguments are parsed by `commander`, never by hand**, and every tool
answers `--help` and `-h`. A new tool is not finished until it does.
Declare the command once — name, description, each `.option()` with its
default — and Commander both parses it and renders the help from that
same declaration, so the two cannot disagree. Hand-rolled `argv`
scanning and hand-written `USAGE` strings are what this replaces: they
drift from the options they describe, and they miss cases a parser gets
free, such as an unknown flag or a missing option value.

What that buys, and what still needs care:

- **Help is handled for you**, printed to **stdout**, exiting **0**,
  and before any argument validation. That ordering matters: someone
  reaching for `--help` is by definition unsure of the arguments, so
  refusing them for a missing one answers the wrong question. An actual
  mistake goes to **stderr** and exits non-zero. Reversing the two
  breaks `tool --help | less`, which sees nothing on stdout, and any
  script reading the exit status.
- **Validate option values in the parser.** Pass a function as
  `.option()`'s third argument and throw `InvalidArgumentError` from it.
  Commander then names the offending option in the message and refuses
  before the tool does any work — where accepting it surfaces later as a
  failure deep in the run that never mentions the flag.
- **Lead the description with what the tool is for**, not with how to
  spell a flag. The reader at `--help` has usually forgotten the former.
  Use `.addHelpText("after", …)` for exit codes and anything that
  belongs below the option list.
- **Build the command in a function**, not at module scope, so a test
  can parse several argument lists without options accumulating between
  them.

All eight tools here parse this way. The hand-written `USAGE` strings
and each tool's own `argv` scanner are gone.

- `inspect-pool.js` — Pretty-prints `app-config/user-configurable/bot-config.json` and
  `app-data/scan-cache/pnl-epochs-cache.json` for a position or pool fragment: status,
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
- `check-rpc-health.js` — Asks one RPC endpoint whether it is healthy
  and prints seven checks: that it responds, that it is PulseChain,
  that it has a latest block and can describe it, that it is not still
  syncing, that the chain is advancing, and that its transaction pool
  answers. See [Checking One RPC Endpoint](#checking-one-rpc-endpoint).
- `rescan-pool-history.js` — Makes the next restart rebuild one managed
  position's lifetime compound and deposit history from the pool's
  creation block, for when those saved figures are wrong. The lifetime
  scan keeps a saved figure rather than recompute it, so the tool
  removes them from the position's config (`--clear-hodl` also drops the
  pool's lifetime HODL amounts from `app-data/scan-cache/pnl-epochs-cache.json`). It
  prints what will change, asks y/N, and writes a timestamped backup of
  each file first. The running bot keeps its in-memory copy, so restart
  afterwards.
- `validate-config-values-with-any-user-overrides.js` — Checks every
  setting the install runs on and lists each problem: the JSON settings
  files with the operator's copies over them, `.env`, and
  `bot-config.json`. Its verdict is the server's and the bot's at
  startup, which refuse to start on any problem: both ask
  `src/lib/settings-check.js`, over the JSON Schemas the shipped-values test
  uses.
  It reads files only, so it is safe while the server runs; run it from
  the install's folder. Exit status 0 when every setting passes, 1
  otherwise. See [Checking the Settings](configuration.md#checking-the-settings).
- `print-resolved-settings.js` — Prints the settings the install runs
  on: the `.env` variables LP Ranger reads, with the environment over
  them, then each JSON settings file by name, the operator's copy over
  the shipped one, as raw JSON. A secret is named as set, never shown.
  It reads them through `resolveSettings` in `src/lib/settings-check.js`,
  the reading the validator above checks. Reads files only; run it from
  the install's folder.

Audited under `npm run audit:security` and `npm run audit:secrets` —
same bar as `src/`. Tests live in **`util/test/`** — one directory for
everything under `util/`, mirroring the root `test/` for `src/`, so no
test reaches across a category boundary for a fixture or a double. They
run under plain `npm test` and `npm run check` (use `npm run test:util`
for a fast loop on all of them). Pure helpers shared across tools live in
`util/diagnostic/_helpers.js` — `sleep`, `addrTopic`, `addrFromTopic`,
`fmtTs`, and `fetchTimestamps` (the throttled block-time lookup both
the chain walker and the token-flow scanner need; it lived in two
places until it was consolidated here); console/exit/provider doubles for
driving the CLIs live in `util/test/_capture.js`. Each
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
multiplies three independent inputs, in `src/lib/compounder.js`
`executeCompound`:

```text
usdValue = (amount0Deposited / 10^decimals0) × price0
         + (amount1Deposited / 10^decimals1) × price1
```

The amounts come from the `IncreaseLiquidity` event on the deposit TX,
the decimals from `poolState`, and the prices from
`deps._lastPrice0` / `_lastPrice1` — whatever
`src/lib/bot-pnl-updater.js` `_fetchWithOverrides` last resolved for the
position, which is either the live price cascade or a per-position
manual price override. Any one of the three can be wrong on its own,
and each failure leaves a different signature. The tool re-derives all
three from the chain and from live price sources, then reports which
one has to be wrong to produce the reported figure.

The Telegram alert reports the fees among that deposit: the record's
`amount0Compounded` and `amount1Compounded` at the same prices
(`src/lib/compounded-coins.js`). When the deposit also took in coins the
wallet already held, the alert names their value apart, and the
`usdValue` this tool checks is the whole deposit's, the Activity Log's
$usd amount.

The figure matters beyond the alert text. `recordCompound` in
`src/lib/bot-cycle-compound.js` adds the **fees** among the same compound's
coins to the position's `compoundedAmount0` / `compoundedAmount1`, and
those coins
priced at the current poll are half of the dashboard's lifetime
fee-earnings figure (`currentFeesUsd + snap.totalCompoundedUsd`, see
`src/lib/ui-state.js`). That total is only ever accumulated incrementally
once disk holds a non-zero value — the on-chain rescan in
`src/lib/bot-recorder-lifetime.js` is deliberately gated off by
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
   (`_filterRebalances` from `src/lib/compounder.js`), so the labels match
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
  the decimals heal / override path in `src/lib/bot-recorder-decimals-heal.js`
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

##### Checking One RPC Endpoint

`check-rpc-health.js` answers whether a single endpoint is serving. It
exists because the bot's own failure messages name endpoints without
proving anything about them: when the log says every endpoint failed,
the question "is that true?" needs an instrument that asks the endpoint
directly.

```bash
node util/diagnostic/check-rpc-health.js
node util/diagnostic/check-rpc-health.js --rpc-endpoint https://rpc.pulsechain.com
```

The default is `https://rpc-pulsechain.g4mm4.io`, the first endpoint in
`chains.json`; `--rpc-endpoint <url>` points it anywhere else. **One
endpoint per run** — each of the three is a separate host, so a health
answer only ever applies to one of them. The endpoint under test is
printed above the table for that reason, and the UTC start time beside
it, because the app logs in UTC and the point of a run is usually to
line it up against a log line.

Seven checks, each timed: `web3_clientVersion` for reachability,
`eth_chainId` + `net_version` against 369, `eth_blockNumber`,
`eth_getBlockByNumber` for block detail and age, `eth_syncing`, a
three-second wait then a second `eth_blockNumber` for progression, and
`txpool_status`. A failing check records its error and the run
continues, since which parts still work is more informative than
stopping at the first failure. Exit status is 0 only when all seven
pass, so it can gate a shell script.

The timings are worth reading, not just the verdicts. A first call on a
cold connection costs several hundred milliseconds for TLS setup where
steady state is under 200 ms — which is why a run of newly-built
providers overlaps the global request queue's release interval and a
warm one does not.

Unlike the other tools here it imports nothing from `src/lib/` — only
`_helpers` — so it opens no log file and reads no operator settings, and
is therefore safe to run against a live install. That is the whole point
of it, and it is why the default endpoint is a literal here rather than
being read from `config.RPC_URLS`.

##### Scenario-Reproduction Scripts

Companion shell scripts (also under `util/diagnostic/`) that
**deliberately mutate local state** to put the app into a specific
recovery path on demand, for testing that path. Each script backs the
original up to a timestamped sibling first and prints the exact restore
command.

- `inject-stuck-lifetime-state.sh` — Sets every pool entry in
  `app-data/scan-cache/pnl-epochs-cache.json` to `freshDeposits: null` and
  `lifetimeHodlAmounts: null`. On the next
  `npm start` that combination drives the lifetime-scan recovery path in
  `src/lib/bot-recorder-lifetime.js` and `src/lib/bot-loop.js` (see
  [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause)
  for the surrounding price-lookup gating), which is what exercises the
  `lifetimeScanComplete` flag and the Syncing badge. A cache built by a
  normal run never has that shape, so the path is otherwise unreachable
  locally.
- `inject-short-epoch-history.sh` — Drops the last N closed epochs from
  every pool entry in `app-data/scan-cache/pnl-epochs-cache.json`, leaving the live epoch
  and the lifetime figures alone. On the next start the app still knows
  from the rebalance events how many closed positions the chain has, so
  its stored history is short: the state a reconstruction that gave up
  part-way leaves, which `isEpochHistoryComplete` detects. Entries with N
  epochs or fewer are skipped, since emptying them tests the cold start
  instead.

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

  **Why not `cp -rn`.** `cp` is a Unix command, so a shell one-liner
  would send Windows operators to Git Bash for one step of an otherwise
  cross-platform procedure. Excluding `node_modules` from it also needs
  `shopt -s extglob`, which zsh &mdash; the macOS default shell &mdash;
  does not have, and which applies at parse time, so the enabling line
  and the copy cannot be joined with `;`.

  **Node built-ins only.** It runs before `npm ci` in the update
  procedure, so `node_modules` may not exist yet and this tool must not
  require anything from it. Its tests are in
  `util/test/migrate-app-state.test.js`, with every other `util/` test.

`util/migration/` brings the files Step Six copied up to date with the
new release, also in Step Six, straight after the copy (`node
./util/migration`). Each change a release makes to where a file lives or
what it holds is one step, a file of its own in a folder named for the
release it updates from (`from-0.9.9/`, `from-0.9.10/`), run in release
order from the `STEPS` list in `util/migration/index.js`. Every
step prints what it changed and is safe to run again; `--dry-run`
reports without changing anything. The steps share two modules, beside
`index.js`: `settings-copies.js` for the operator's copies of the settings files,
which keeps each old file in `tmp/` before changing it, and
`env-file.js` for `.env`, which keeps each changed line as a comment and
makes no copy, since the file holds the private key. Node built-ins
only, like the copy. Its tests are in `util/test/migration.test.js`,
`util/test/migration-099-settings.test.js`,
`util/test/migration-from-0.9.10.test.js` and
`util/test/migration-from-0.9.10-deposit-lists.test.js`.

#### Cache Utilities

`util/cache/` holds small Node.js scripts that operate on the
pool-address-keyed disk caches in `app-data/scan-cache/`.

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

#### Bookkeeping Utilities

**In a folder of their own.** `util/bookkeeping/` holds two tools for
bookkeeping in coins, transaction by transaction: one reads a single
transaction, and one writes a csv of a wallet's rebalances and compounds
over a range of days, with each amount's value in USD. Their
documentation is in `docs/util/bookkeeping-for-coins-in-transactions/`:

| You want to | Go to |
| ----------- | ----- |
| Run a report and read its csv | [User Manual](util/bookkeeping-for-coins-in-transactions/user-manual.md) |
| See each tool's options and exit status | [Commands](util/bookkeeping-for-coins-in-transactions/commands.md) |
| Know how the tools work, module by module | [Engineering Reference](util/bookkeeping-for-coins-in-transactions/engineering.md) |
| Record a transaction by hand | [Step by Step](util/bookkeeping-for-coins-in-transactions/engineering.md#step-by-step) |

Their settings are LP Ranger's own, read through `src/lib/config.js`, so
`.env` and the operator's settings files apply to them as to the app.
They fail over to no other rpc endpoint, and for prices ask Moralis,
then CoinGecko, and no third service. They write only under
`app-data/util/bookkeeping/`, except a Moralis key typed into the
report, which goes into the app's own key store.

---

## The app-config Directory

**Read this before adding new config files.**

Every file the app reads or writes for its own configuration and runtime
state lives in two directories at the project root:

```text
lp-ranger/
├── app-config/
│   ├── app-defaults-for-user-configurable/  ← tracked, shipped defaults
│   │   ├── README.md         ← do-not-edit warning + override instructions
│   │   ├── app-runtime.json  ← app tunables not on the dashboard (server, shutdown, tx timing, compound spacing, log)
│   │   ├── chains.json       ← per-blockchain tunables (RPC, contracts, gas)
│   │   ├── bot-config-defaults.json  ← Bot Configuration defaults + nested groups
│   │   ├── csrf.json         ← CSRF token TTL + refresh cadence
│   │   ├── dust-threshold.json  ← universal dust threshold (gold-pegged)
│   │   ├── evm-rpc-response-codes.json  ← RPC error-classifier substrings
│   │   ├── logging.json      ← log-to-file toggle + path, error-log path
│   │   ├── lp-providers.json   ← LP-provider name keyed by <factory>_<positionManager> (EIP-55), with the chains each is verified on
│   │   ├── price-services.json ← each price service's base url
│   │   ├── setting-bounds.json ← the range each checked setting must fall in
│   │   ├── setting-labels.json ← names the Activity Log's "Setting Saved" lines use for config keys
│   │   ├── ui-defaults_layout.json  ← dashboard layout settings, built into its CSS
│   │   ├── ui-defaults_non-layout_for-server-down-scenario.json  ← dashboard settings built into the page
│   │   ├── ui-defaults_non-layout_for-server-up-scenario.json    ← dashboard settings the server sends
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
    ├── rebalance_log.json    ← runtime (gitignored) — historical P&L events
    ├── position-records.json ← runtime (gitignored) — each position's records
    ├── scan-cache/           ← runtime (gitignored) — the scan caches
    └── util/bookkeeping/     ← runtime (gitignored) — the bookkeeping reports, their prices in scan-cache/
```

One home for each kind of data:

- **`app-config/`** — only what the operator chooses: the settings, the
  managed positions, the encrypted wallet and api keys, and the shipped
  defaults with the operator's copies. **Never cache data.**
- **`app-data/position-records.json`** — what the bot worked out or
  recorded about each position (`src/lib/position-records.js`).
- **`app-data/scan-cache/`** — what was read from the blockchain or a
  price service; rebuilt if deleted, at about an hour per position
  (`src/lib/scan-cache-dir.js`).
- **`app-data/util/bookkeeping/`** — the csv reports the bookkeeping
  tools in `util/bookkeeping/` write, one per wallet, range of days and
  time zone, and in `scan-cache/` the prices they fetched. A tool under
  `util/` writes only its own folder, with one exception: when no Moralis
  api key is saved, the report saves the one typed in the app's own store
  in `app-config/`, since the app and the report share one key
  ([Bookkeeping Utilities](#bookkeeping-utilities)).
- **`tmp/`** — only what is disposable, such as the server's PID file.

`test/data-homes.test.js` fails the build when code puts data elsewhere.

### File Inventory

- **`app-defaults-for-user-configurable/chains.json`** — Tracked
  shipped default. Per-blockchain config: RPC endpoints, contract
  addresses (PositionManager, Factory, SwapRouter), gas multipliers, the
  aggregator (url, name, wait window, quote time limit, retry count), and
  each price service's id for the chain. Read once at
  module load by `src/lib/config.js` via the layered defaults+user-
  override loader. **To customize:** copy this file to
  `app-config/user-configurable/chains.json` and edit the copy
  (deep-merge — you only need to ship the keys you want to override).
  Do NOT edit the file in `app-defaults-for-user-configurable/` —
  tarball upgrades overwrite it.
- **`app-defaults-for-user-configurable/bot-config-defaults.json`** — Tracked. Default values
  for every user-editable Bot Configuration input, plus settings with no
  input and four nested groups (`throttleDoubling`, `lowGasThresholds`,
  `ilGuardRetry`, `residualCleanup`). See
  [Bot Config Defaults](#bot-config-defaults) for the full key inventory.
- **`app-defaults-for-user-configurable/dust-threshold.json`** —
  Tracked shipped default. Universal dust threshold (in abstract
  units of an inflation-resistant reference asset) plus the list of
  tokens used to fetch the live USD/unit price. Read once at module
  load by `src/lib/dust.js` via the layered defaults+user-override
  loader. See [Dust Threshold](#dust-threshold) for the strategy and
  rationale. **To customize** (tune the threshold or switch reference
  assets): copy this file to
  `app-config/user-configurable/dust-threshold.json` and edit the
  copy. Do NOT edit the file in `app-defaults-for-user-configurable/`
  — tarball upgrades overwrite it.
- **`app-defaults-for-user-configurable/price-services.json`** —
  Tracked shipped default. The base url of each price service's api
  (DexScreener, GeckoTerminal, Moralis), version included where the url
  carries one. Read once at module load by `src/lib/price-service-urls.js`,
  which every price request is built through. Which tokens a service can price
  on a chain is per chain instead, in `chains.json` → `priceServices`.
  `geckoTerminal.topPoolsConsidered`, read by `src/lib/gecko-pool-cache.js`,
  is how many of a token's pools are weighed when its historical price is
  looked up.
- **`app-defaults-for-user-configurable/setting-bounds.json`** —
  Tracked. The range every checked setting must fall in, at the setting's
  own path; `timers` holds the timer rule. Read through
  `src/lib/setting-bounds.js` by the save check (`src/lib/config-bounds.js`) and
  the startup check (`src/lib/config.js`, through `src/lib/bot-config-defaults.js`,
  `src/lib/ui-defaults.js`, `src/lib/runtime-flags.js` and
  `src/lib/timer-bounds.js`). The dashboard bundles it for the figures its
  help quotes and for its token-decimals check. **Not overridable:** a
  range an override could widen would bound nothing.
- **`app-defaults-for-user-configurable/api-keys.example.json`** —
  Tracked. Format template showing the structure of the encrypted
  `api-keys.json`. NOT a tunable, NOT a runtime file — pure
  documentation. Lives in the shipped-defaults directory because it
  ships with the app and documents the runtime sibling under
  `user-configurable/`.
- **`user-configurable/bot-config.json`** — Runtime, gitignored.
  Managed position lifecycle (`status: running/stopped`), per-position
  settings (thresholds, slippage, auto-compound config, initial deposit
  overrides), global bot settings. Read/written by `src/lib/bot-config-v2.js`
  via `loadConfig()` / `saveConfig()`. Atomic write (tmp + rename); every
  write is logged with the caller's stack for config-stomp debugging.
- **`app-data/position-records.json`** — Runtime, gitignored. Each
  position's records, what the bot worked out or logged about it (HODL
  baseline, compound history and coins, gas per NFT, lifetime deposit,
  residuals, last compound time, and the gas failed moves paid, which
  the P&L counts in each period and no rebuild can drop:
  `RECORD_POSITION_KEYS`), kept apart
  from the settings so a settings reset leaves the figures. Read and
  written with bot-config.json, which merges them into each position's
  slot in memory (`src/lib/position-records.js`); copied to
  `position-records.backup.json` on each `loadConfig` call that makes
  backups, as bot-config.json is.
- **`user-configurable/bot-config.backup.json`** — Runtime, gitignored.
  Automatic snapshot that bot-config-v2's `loadConfig` makes on each
  successful call, unless the caller passes `skipBackups`. The server
  and the bot call it once as they start, so the snapshot holds the file
  as it was before that run saved anything. The price library's three
  cache lifetimes are read through it too (`readPriceCacheSettings`,
  `src/lib/price-fetcher-gate.js`), when a program's entry point asks, never
  as the library loads. The server and the bot ask as they start, and
  their reads make the copies. A tool under `util/` that needs the
  lifetimes passes `skipBackups`, so its read leaves the snapshot alone
  while LP Ranger runs.
  A safety net: if `bot-config.json` is ever accidentally truncated,
  copy this file back over it:

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
  written to disk. Read/written by `src/lib/wallet-manager.js`. Tests
  override the path via the `WALLET_FILE_PATH` environment variable.
- **`user-configurable/api-keys.json`** — Runtime, gitignored.
  Encrypted storage for third-party API keys (Moralis, Telegram bot
  token + chat ID), using the same wallet password and encryption
  scheme as `wallet.json`. Read/written by `src/lib/api-key-store.js`.
  Tests override the path via the `API_KEYS_FILE_PATH` environment
  variable.
- **`app-data/rebalance_log.json`** — Runtime, gitignored. JSON array
  of every rebalance event ever: timestamps, fees collected, gas cost,
  exit/entry USD values, token balances. Appended to by
  `src/lib/bot-recorder.js`. Read by `src/lib/position-history.js` for
  closed-position P&L display. Configurable via the `LOG_FILE`
  environment variable. Lives outside `app-config/` because it's
  per-install runtime DATA, not config.

### The Dashboard's Three Settings Files

The dashboard's settings are split by when the page first needs each
one, and whether it can ask the server then. Each lives in one of three
files under `app-config/app-defaults-for-user-configurable/`.

| File | What it holds | How the page gets it | An operator's copy takes effect |
| ---- | ------------- | -------------------- | ------------------------------- |
| `ui-defaults_layout.json` | Layout: the dialog height. | `npm run build` writes it into `src/client/web/ui-tokens.css` (`scripts/build-ui-tokens.js`). | At the next `npm run build`. |
| `ui-defaults_non-layout_for-server-down-scenario.json` | The two settings the page uses while it cannot reach the server: how long it gives each startup question (`chainQueryTimeoutMs`), and how many unanswered questions turn the status pill to HALTED (`pollFailuresBeforeHalted`). | `npm run build` bundles the shipped copy into the page's script. | Never. |
| `ui-defaults_non-layout_for-server-up-scenario.json` | Every other dashboard setting, listed in [Configuration](configuration.md#dashboard-settings-the-server-sends). | The server sends it at `GET /api/ui-defaults`. | After a restart and a page reload. |

**Why the first two are built in.** A layout value that arrived after
the first paint would make the page jump. The server-down settings are
needed exactly when the server cannot be asked.

**How the server sends the rest.** `src/lib/ui-defaults.js` reads the
server-up file once, at startup, with the operator's copy on top. An
on/off setting must be true or false. A setting the page turns into a
timer delay must meet the timer rule (`src/lib/timer-bounds.js`). Any other
must fall in its range in `setting-bounds.json`. The answer is kept for the life of the
process, so the server's own copy of the poll interval
(`src/lib/config.js`, which times "the dashboard has had a chance to poll")
and the figures the help quotes (`src/lib/resolved-settings.js`) are the
values the page is sent.

**How the page uses them.** At startup the page asks the server for its
blockchain, then for these settings (`src/client/web/dashboard-ui-settings.js`),
and starts polling and its timers only once they arrive. Each request
that ends unanswered counts toward HALTED, as the blockchain's does.
Code reads a setting through `uiSetting(key)`, which refuses a read made
before the answer, naming the setting.

A few things can run before the answer. Each takes the cautious side
until it lands: privacy options blur wallet addresses and every USD
amount, sounds stay off, a copy icon keeps its tick, and the Activity
Log keeps every entry. A choice saved in the browser's Settings popover
always wins over a first-visit default.

**Where a new dashboard setting goes.** A layout value goes in the
layout file. A value needed while the server cannot be reached goes in
the server-down file. Anything else goes in the server-up file, with a
range in `setting-bounds.json` or a place under the timer rule, and the
page reads it through `uiSetting`.

### Rules for Where Future Config Files Should Live

1. **Shipped default for an operator-tunable value** (tracked, never
   rewritten by the app at runtime) →
   `app-config/app-defaults-for-user-configurable/<name>.json`.  Read
   via `src/lib/load-merged-defaults.js#loadMergedDefaults("<name>.json")`
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
5. **Scan cache** (can be deleted with no loss of data; rebuilt on
   demand from the blockchain or an API) →
   `app-data/scan-cache/<name>.json`, its path from `scanCachePath`
   (`src/lib/scan-cache-dir.js`).  DO NOT put caches in `app-config/` or
   `tmp/`.

### One-Time Migration from the Legacy Layout

Existing installations prior to this refactor kept runtime files at the
project root (`.bot-config.json`, `.wallet.json`, `api-keys.json`, etc.).
On every startup, `src/lib/migrate-app-config.js` runs `migrateAppConfig()`
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
holds the default values for every Bot Configuration input the dashboard
exposes, more keys with no input of their own, and nested groups. Where
a position has no value of its own, the bot reads this file, an
operator's copy on top, through `readBotConfigDefaults`. The dashboard
fetches the same defaults from `GET /api/bot-config-defaults`, with
`.env` on top ([`src/lib/resolved-settings.js`](../src/lib/resolved-settings.js)),
so its inputs, Default buttons and help show what the bot runs on. A
position's own values live in `app-config/user-configurable/bot-config.json`.

**Top-level keys with an input in the Bot Configuration panel:**

| Key | Default | Description |
| --- | --- | --- |
| `approvalMultiple` | `20` | ERC-20 approval multiplier for swap allowances |
| `rebalanceOutOfRangeThresholdPercent` | `5` | % move past the position boundary before a rebalance triggers |
| `rebalanceTimeoutMin` | `180` | Minutes continuously OOR before forcing a rebalance (`0` = disabled) |
| `slippagePct` | `0.75` | The default for both Slippage rows (`slippagePctToken0`, `slippagePctToken1`): a token with no figure of its own uses it. Not saved per position |
| `minRebalanceIntervalMin` | `10` | Minimum gap between back-to-back rebalances on the same pool |
| `maxRebalancesPerDay` | `5` | Per-pool daily rebalance cap (UTC reset; every successful rebalance counts) |
| `offsetToken0Pct` | `50` | Position offset bias toward token0 (50 = balanced) |
| `impermanentLossGuardPct` | `15` | Most a position may have lost before the bot stops rebalancing it — see [Impermanent Loss Guard](#impermanent-loss-guard) |
| `gasFeePct` | `1` | A swap, in a rebalance or a compound, is skipped when its gas would cost more than this percent of its value |
| `rangeOverrideEnabled` | `false` | Bot Configuration → Range "No Override" toggle. `false` re-uses the position's existing on-chain range |
| `rebalanceRangeWidthPct` | `80` | Value the Price Range Extension row's "Default" button applies. Not auto-populated into the input |
| `fullRangeRebalanceEnabled` | `false` | Mint the next rebalance across the full tick range, for a position with no Full-Range choice saved, while its Range settings apply. `GET /api/status` publishes it for the checkbox (`fullRangeSetting`, [`src/lib/range-override.js`](../src/lib/range-override.js)) |

**Validation bounds.** None live here: every range is in
`setting-bounds.json`, at the setting's own key (see the file inventory
above).

**No Bot Configuration input.** These have no field in the panel.
Whether they can be changed at runtime at all depends on membership of
`GLOBAL_KEYS` in [`src/lib/bot-config-keys.js`](../src/lib/bot-config-keys.js): a key
in that list is accepted by `POST /api/config`, and one that is not can
only be changed by editing
`app-config/user-configurable/bot-config-defaults.json` and restarting.

| Key | Default | Changed by | Description |
| --- | --- | --- | --- |
| `checkIntervalSec` | `300` | the JSON file or `CHECK_INTERVAL_SEC` in `.env`, then restart | Seconds between the bot's checks of every position. One global value, since the dashboard's idle and wake timing are built on it |
| `rebalanceGasDeferPct` | `0.5` | the JSON file, then restart | A rebalance waits when its gas would cost more than this percent of the position's value |
| `gasDeferRetrySec` | `3600` | the JSON file, then restart | How long a waiting rebalance waits before the bot looks again, in place of the poll interval |
| `moralisEnabled` | `true` | the Moralis API Key dialog | Whether the stored Moralis key is used for price lookups. Separate from whether a key exists, so switching it off stops the calls without discarding the key — which is what an operator wants when a quota runs out. The control is disabled when no key is configured. This default, an operator's copy on top, decides until the switch is saved (`moralisEnabledIn`, [`src/lib/server-moralis.js`](../src/lib/server-moralis.js)) |
| `priceCacheTtlMs` | `120000` | `POST /api/config` | In-memory token-price cache TTL — see [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause) |
| `dustUnitPriceCacheMultiplier` | `30` | `POST /api/config` | Dust-unit-price TTL as a multiple of `priceCacheTtlMs` |
| `moveCacheTtlMs` | `4000` | `POST /api/config` | Cache TTL for the fresh-price window around a rebalance or compound |
| `pricePauseExceptionPollWindowMultiple` | `10` | `POST /api/config` | Poll cycles between the balanced-band notifier's fresh-price probes. The dashboard reads it to label the resulting cadence next to the checkbox, but offers no field to set it |
| `getLogsChunkSize` | `9000` | the JSON file, then restart | Widest block span any `eth_getLogs` call may request, up to 10,000 — see [RPC Request Pacing and Log Chunking](configuration.md#rpc-request-pacing-and-log-chunking) |
| `globalRPCRequestRateIntervalMS` | `222` | the JSON file, then restart | Minimum milliseconds between any two JSON-RPC requests leaving the process, 5 to 2000; the low end only against a node of your own |

**`lowGasThresholds`** — drives the Mission Control "Gas Running Low" /
"Gas Critical" badge in [`src/lib/gas-monitor.js`](../src/lib/gas-monitor.js).
Not exposed in the UI.

| Key | Default | Description |
| --- | --- | --- |
| `worstCaseGasFactor` | `91` | Worst-case rebalance gas in units of a 21k native send |
| `safetyMultiplier` | `3` | Headroom factor over the worst case |
| `standardSendGas` | `21000` | EVM constant for a no-calldata native transfer |

**`residualCleanup`** — drives the post-rebalance residual-sweep loop in
[`src/lib/bot-cycle-residual.js`](../src/lib/bot-cycle-residual.js). Not exposed
in the UI.

| Key | Default | Description |
| --- | --- | --- |
| `delayMs` | `600000` | Wait (ms) after a rebalance before checking residual share |
| `thresholdPct` | `5` | Residual share of the pool batch (%) that triggers a sweep |

**`ilGuardRetry`** — paces retries of a rebalance the Impermanent Loss
Guard has rejected, in [`src/lib/il-guard.js`](../src/lib/il-guard.js). Not
exposed in the UI. Each has a range in `setting-bounds.json`, a minute
to thirty days, so a mistyped value cannot turn the guard into a
per-poll retry.

| Key | Default | Description |
| --- | --- | --- |
| `baseMs` | `14400000` | First retry delay (4 h) |
| `maxMs` | `604800000` | Ceiling the doubling ladder holds at (7 days) |

**`throttleDoubling`** — the three numbers behind doubling mode, read by
[`src/lib/throttle.js`](../src/lib/throttle.js): how many rebalances in how wide
a window switch it on, and how long a quiet spell clears it. No input;
the dashboard's Doubling Trigger Window label shows the numbers in force.
Defaults and ranges are in [Configuration](configuration.md).

---

## Security

All security detail now lives in [`docs/security.md`](security.md): what is
at stake, the controls in effect across network, message, key-management,
crypto, validation, injection, filesystem, on-chain, supply-chain and
runtime layers, and the lint and test gates enforcing each one.

Entry points worth knowing:

- [Summary of Primary Controls](security.md#summary-of-primary-controls) —
  the short list, in plain language.
- [On-Chain / Transaction Security](security.md#on-chain--transaction-security)
  — nonce serialization, the TX recovery pipeline, slippage guards and swap
  gates.
- [Supply Chain & Dependencies](security.md#supply-chain--dependencies) — the
  pinning policy and what `npm audit` is allowed to fail on.
- [Code Review Controls](security.md#code-review-controls) — the rules a
  change has to pass before it can ship.

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
├── config-values.tap         Raw TAP v14 from the shipped-config tests, run first
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
    ├── lcov.info                 lcov coverage report of the test run
    └── exit-codes.json           Per-tool exit codes captured by check.js
```

### The shipped config values are tested first

The gate first runs the tests of the shipped config files,
`test/shipped-config-values.test.js` and `test/setting-bounds.test.js`
(`configValueTests()` in `scripts/check.js`). A bad value breaks
whatever reads it, and the suite reports each breakage as its own
failure; run first, these tests name the cause in their own Config
values row, at the head of every failure list. The rest of the suite
runs either way.

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
The brief ROUTES list in [`src/server.js`](../src/server.js)'s file-header is a
human-readable index, not the full spec.

### Starting the Local API Reference Server

```sh
npm run api-doc
```

This runs [`scripts/api-doc.js`](../scripts/api-doc.js), which starts a
standalone HTTP server on **<http://localhost:5556>**. The server is
independent of the main dashboard — you can run it alongside
`npm start` (which uses port 5555) without conflict.

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
route handlers do not auto-publish their schemas — so any route change,
in `src/server.js` or any `src/lib/` module that registers a route, must be
mirrored by hand into `openapi.json`.

Hand-maintenance drifts on its own, so
[`scripts/check-openapi-sync.js`](../scripts/check-openapi-sync.js) runs
as a gate in both `npm run lint` and `npm run check` — see step 7 below.
It is what makes step 8 enforceable rather than aspirational.

Typical workflow when you add, rename, or change an API route:

1. **Make the code change** in the appropriate `src/lib/server-*.js` file
   and its call-site in `src/server.js`. Add/update the test in
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
     dashboard setting `GET /api/ui-defaults` sends appears in its
     response schema and no other (read from `UI_SETTING_KEYS` in
     `src/lib/ui-defaults.js`), every operation has a summary and at least
     one response, and every tag is both declared and used. On failure
     it names each mismatch.
   - [`test/openapi-coverage.test.js`](../test/openapi-coverage.test.js)
     — drives that same checker against mutated in-memory copies of the
     spec, so a rule that gets quietly dropped fails a test instead of
     silently passing everything.
8. **Commit the spec change in the same commit as the route change**
   — this keeps the spec and the implementation from drifting in
   reviewable diffs.

Routes matched by URL pattern rather than by a `"METHOD /path"` handler
entry — today only `GET /api/position/{tokenId}/history` — are invisible
to the checker's scan, so they are allowlisted by name in
`DYNAMIC_ROUTES` at the top of `scripts/check-openapi-sync.js`. A second
dynamic route has to be added there deliberately.

### Reference

- `info.title` / `info.version` — bump `info.version` when you ship a
  breaking API change.
- `servers[]` — the local dev server URL. Not exercised in production
  (there's no hosted instance), but the value matters for Scalar's
  "Try it out" feature: requests go to whatever URL is listed here.
- `components.schemas` — shared request/response shapes.
- `tags[]` — category labels that group routes in the UI sidebar. Add
  a new tag only when a route genuinely doesn't fit an existing one.

---

## `src/server.js`

`src/server.js` is the execution entry point for the dashboard+bot process
(`npm start` / `npm run build-and-start`). The headless-bot variant
(`npm run bot`) is a thin wrapper around the same internals; see
[`src/bot.js`](../src/bot.js) for that path.

What happens when the process starts, in order:

1. **Colored logging is installed.** `installColorLogger()` from
   [`src/lib/logger.js`](../src/lib/logger.js) wraps `console.log`/`warn`/`error`
   so bracketed prefixes like `[server]`, `[bot]`, `[rebalance]` render
   in distinct colors and module-specific emoji IDs.
2. **`--help` / `-h` short-circuit.** If the flag is on `argv`,
   [`src/lib/cli-help.js`](../src/lib/cli-help.js) prints the usage text and the
   process exits with status 0 — nothing below runs.
3. **Core modules are required.** `http`, `fs`, `path`, then the app's
   own modules: `config` (env-var parsing), `walletManager`,
   `position-history`, `rebalance-lock`, `position-manager`,
   `bot-config-v2`, `migrate-app-config`. Requiring `src/lib/config.js`
   also loads `app-config/app-defaults-for-user-configurable/chains.json` for the current
   `CHAIN_NAME`, and runs the startup checks that stop the process on a
   setting outside its range (see
   [Reading Configuration Values](#reading-configuration-values)).
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
   builds the server object. `requestTimeout` is left at Node's own
   default: it bounds how long a client may take to **send** a request,
   not how long a handler may take to answer one, so raising it does
   nothing for a long-running scan and only weakens a slow-client
   guard.
8. **If run directly (`require.main === module`)**, the server first
   reads the shutdown timings and empties the previous run's error log,
   then:
   1. `start()` calls `server.listen(PORT, HOST)` and logs the
      blockchain name, NFT factory, wallet address (or `(not loaded)`),
      dashboard URL, `/api/status` URL, port, and `/health` URL.
   2. As soon as it is listening, it writes `tmp/lp-ranger.pid` (removed
      by an `exit` hook however the process ends) and installs the
      `SIGINT` and `SIGTERM` handler. Both come before the wallet key is
      resolved, which can wait on a prompt, so a signal during a slow
      start still shuts down cleanly. The handler marks the app
      stopping for good, so no position starts and no move begins
      after it (src/lib/app-phase.js), sends the shutdown alert, starts
      `_positionMgr.stopAll()`, closes the HTTP server,
      and exits within `shutdown.exitTimeoutMs` (three seconds as
      shipped) whether or not a rebalance or compound has finished.
      `npm run gentle-stop` is the stop that waits for one, and for a
      scan under way.
   3. `_tryResolveKey()` tries to obtain the wallet private key —
      either from `PRIVATE_KEY` in `.env`, from a
      `WALLET_PASSWORD`-decrypted `app-config/user-configurable/wallet.json`, or from
      an interactive prompt.
      - On success: `_autoStartManagedPositions()` spins up one bot
        loop per position whose v2 config has `status: 'running'`, on
        this chain and in this wallet (src/lib/server-auto-start.js). The
        starts are staggered by the poll interval divided by the
        number of positions (150 seconds apart for two at the default
        300), so they don't all poll the RPC on the same tick. The
        start-up ends early once a stop begins.
      - If the wallet is locked: logs
        `Wallet locked — unlock via dashboard to start bot.` and
        enters dashboard-only mode until the user unlocks via
        `POST /api/wallet/unlock`.
      - If no wallet exists: logs `No wallet key — dashboard-only mode`.
9. **If imported as a module (e.g. from a test)**: nothing in step 8
   runs. The caller controls `start()` / `stop()` lifecycle explicitly.

The dashboard is served as static files from `src/client/web/` by `serveStatic()`;
all JSON APIs are dispatched by `handleRequest()` through a route table
that maps method+path to handlers defined in
[`src/lib/server-routes.js`](../src/lib/server-routes.js),
[`src/lib/server-positions.js`](../src/lib/server-positions.js) and the other
`src/lib/` route modules. The full route surface is covered by the OpenAPI
spec (see [API Documentation](#api-documentation) above).

---

## Reading Configuration Values

**Read a configured value through the reader that vets it, never through
the raw file.** Each shipped-defaults JSON has a reader beside it that
applies the per-key rules declared next to the values —
`readBotConfigDefaults()` for `bot-config-defaults.json`, and the
`parse*` helpers in `src/lib/runtime-flags.js` for `app-runtime.json` and
`.env`. `loadMergedDefaults()` is what those readers are built on, not
an alternative to them: it layers the operator's override over the
shipped file and stops there.

The difference only shows when a value is wrong, which is exactly when
it matters. `checkIntervalSec` must be 10 to 3600 seconds. Read raw, a
hand-edited `0` or `"soon"` travels on as a live setting; read after
startup through its reader, it leaves the shipped 300 standing.

Five rules follow.

**A value that becomes a `setTimeout` or `setInterval` delay is vetted
by `src/lib/timer-bounds.js`, and by nothing else.** One module, because
such a value arrives by more than one road: `.env`, and JSON files an
operator can override.
A second copy of the rule would drift, and the half that drifted would
be the half nobody tested. That file also carries the reasoning — in
short, a timer asked for more than about 24.8 days does not wait longer,
it fires after a millisecond, and `NaN` behaves the same way.

**Where the app cannot run on a wrong value, throw rather than fall
back.** `src/lib/config.js` does this for the three settings that become
timer delays, for the five Bot Configuration settings `.env` can set, for any setting
an operator's `bot-config-defaults.json` or
`ui-defaults_non-layout_for-server-up-scenario.json` puts outside its
range, and for an unresolvable chain name. A value
quietly replaced by its default leaves the bot on a schedule, setting or
chain nobody chose, the last thing anyone would check. The throw comes
as `src/lib/config.js` loads, stopping the process before any position
starts, with a message naming the setting and the bound.

**Throw at a boundary a person writes to, never on a hot path.** This is
why `bot-config-defaults.js` has two readers.
`readBotConfigDefaultsStrict()` refuses every setting written outside
its range, judged by the timer rule for a timer and by
`setting-bounds.json` for the rest, group members and list entries
included, and names them in one message. It is called once, by
`src/lib/config.js`, at startup.
`readBotConfigDefaults()` never throws over a value, and is what
everything else calls — and those calls include a poll cycle, a price
lookup, the all-endpoints-down pause, and `GET /api/bot-config-defaults`. A throw from there would turn
an edit made while the bot is running into a broken poll and a 500, and
the route's own contract is that it never 500s. The same edit is still
refused: at the next start, which is when the operator can act on it.

**Where the app can carry on, answer rather than throw.** A bad value
arriving at `POST /api/config` gets a 400 naming the problem; the server
keeps serving and the dashboard can say what was wrong. This is why
`_checkTimer()` in `src/lib/config-bounds.js` catches the timer rule's
throw and returns its message instead — the startup path throws that
sentence, the route replies with it, and neither restates the rule.

That 400 carries an `invalidValueForKey` field naming the setting whose
value was refused, because the same route answers 400 for a second,
unrelated reason: a malformed request, most often one with no
`positionKey`, or one whose key names another chain. The dashboard
raises its dialog and restores the field only for the first. Both
refusals come before anything in the request is applied
(`src/lib/server-config-route.js`), so a refused request leaves no trace.

**The browser does not decide whether a value is acceptable.**
`src/lib/config-bounds.js` is the only place that decision is made, for
every setting the dashboard lets an operator type into, and
`src/client/web/dashboard-config-save.js` is the only path a save takes. Adding
a settable key means adding its rule to the first and mapping the key
to its input id in the second; leave either out and the save fails with
nothing said and the refused value still on screen.

Each setting's rule is a JSON Schema, and the startup check builds
bot-config.json's schema from the same ones (`src/lib/bot-config-checks.js`),
so a value a save refuses stops startup, and one a save takes passes.
The Telegram alerts chosen work the same way: one schema
(`ALERT_CHOICES`, beside the alert list) for the Telegram route's save
and for the startup check.

The price-cache settings (`priceCacheTtlMs`,
`dustUnitPriceCacheMultiplier`, `moveCacheTtlMs` and
`pricePauseExceptionPollWindowMultiple`) have no dashboard field, but
`POST /api/config` saves them, so they are checked here too; the price
code reads the saved value at its next start. `test/config-bounds.test.js`
fails for any key the route saves that has a range in
setting-bounds.json and no check here.

One module, rather than a rule per control, because rules kept per
control drift into different policies. One rewrites what was typed and
saves the rewrite, so the bot runs on a number nobody chose; another
refuses with no message, which reads as a broken Save button. And no
check in the browser binds a request that does not come from the form.

Bounds live with the check, not in the browser: every range is in
`setting-bounds.json`, read through `src/lib/setting-bounds.js` by this
module, the shipped-defaults reader and the timer rule, so no figure is
restated. No input carries a configured range: the only `min` and
`max` attributes in the page are a quantity's natural limits, zero for
an amount and 0 to 100 for a share.

Two values look like refusals but are not. **`null` clears a setting** —
the route deletes the key and the shipped default stands again — so the
checker passes it through untouched, and an empty field is sent as
`null` for exactly that reason. **Zero is a real setting** for several
keys: a price override of 0 means "no override" (every reader gates on
`> 0`), and an OOR timeout of 0 means "off". A floor above zero on
either would strand a setting the operator could set but never undo.

## RPC Failover

All TX-sending paths route through
[`src/lib/send-transaction.js`](../src/lib/send-transaction.js), which owns the
single active-endpoint selection over the ordered list in
`chains.json` → `rpc.urls`. On `estimateGas` failure it probes the
remaining endpoints and commits only to one that answers; on success it
engages a sticky one-hour window so subsequent broadcasts, receipts and
nonce lookups follow. The window self-heals — `getCurrentRPC()` returns
to the first endpoint once it lapses. Broadcast failover requires the
signer to be a `FailoverNonceManager`, which rebinds on change. No-op
on a single-endpoint chain.

**What moves selection is a failure rate, not one error.**
`decideIfCurrentRPCIsOutOfService` (`src/lib/rpc-out-of-service.js`) is the
single decider, and an endpoint is left only once it is failing more
than `rpcFailoverRatePercentage` of what it is asked inside the last
`rpcFailoverRateDurationMinutes`. Every RPC outcome in the process
reports to `noteRpcResult`, successes included, because a rate needs a
denominator — which is what lets the components that fail often and
legitimately say what they see instead of staying silent to avoid
retiring an endpoint for the whole process.

Outcomes are tallied per second rather than kept one by one, so the
store holds at most one small record per second per endpoint however
fast requests arrive: roughly a quarter of a megabyte at the paced
default, and the same at ten thousand requests a second with pacing
off. The window's edge therefore moves in whole seconds, which a
five-minute health judgement does not notice.

A rate takes time to cross. An endpoint that has been busy and healthy
and then dies is retried for about half the window before selection
moves — 676 requests over 150 seconds at the shipped defaults. Shorten
`rpcFailoverRateDurationMinutes` to converge sooner.

**Failover-eligible errors** are the endpoint's fault, not the
request's: `SERVER_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, the
connection-level codes ethers passes through bare (`ECONNRESET`,
`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EHOSTUNREACH`,
`ENETUNREACH`, `EPIPE`), any 5xx, and the 4xx answers that describe the
endpoint — 401, 403, 404, 408, 429. HTTP 400 and 413 are excluded
because both describe the request, and failing over on them walks the
whole list hiding a defect of ours.

**An HTTP 429 is waited out rather than moved off.** It says this
process is sending too fast, and moving carries the same rate to the
next endpoint. `_patchRequestPacing` (`src/lib/bot-provider.js`) retries on
the `rpcRetryOn429DelaysMs` schedule and leaves a per-endpoint penalty,
capped at `rpcMax429PenaltyMs`, that every later request to that
endpoint honours and any success clears.

**Every read in the process reaches the managed proxy.**
`getManagedReadProvider()` returns a Proxy that resolves selection on
each property access and retries a failover-eligible error on the next
endpoint. `FailoverNonceManager` returns it from `.provider` and routes
`.call()` through it, so the reads ethers takes from a signer — a
signer-bound contract's view functions, and `queryFilter` via
`runner.provider` — retry and report like any other. No reader keeps an
endpoint list of its own: `getPoolState` and the can-reopen balance
check both go through the shared retry loop in
`src/lib/rpc-read-retry.js`, which asks the same selection and reports to
the same rate. What each adds is a bounded attempt budget and the error
it raises when that budget is spent, because a poll cycle and a dialog
are both waiting on an answer rather than on an eventual one.

## RPC Reachability at Startup

Before a position's loop begins, `ensureReachable()`
(`src/lib/send-transaction.js`) proves that at least one configured endpoint
answers. It calls `getBlockNumber` against each endpoint in the order
`chains.json` → `rpc.urls` lists them and stops at the first that
replies. When that is not the first in the list, the sticky failover
window is engaged, so reads and writes both start where the probe
succeeded instead of retrying the dead one on the first real call.

The probe is what puts an unreachable chain in the terminal at startup,
rather than leaving the operator to infer it from figures that never
arrive.

### What it prints

| Situation | Line |
| --- | --- |
| The first endpoint answers | `[bot] RPC:    <url>` |
| A later one answers | the failover banner naming the move, then `[bot] RPC:    <url> (fallback)` |
| An endpoint does not answer | `[bot] RPC unreachable at startup (n of N): <url> — <error>` |
| Another one remains to try | `[bot] Falling back to <next url>` |
| None answered | `[bot] STARTUP: no RPC endpoint answered — tried all N, last was <url>. The bot cannot start until one is reachable. Check this machine's internet connection, then the endpoint list in Bot Settings → Network.` |

The summary line earns its place from what follows it. `ensureReachable`
throws the last endpoint's error, and the caller logs that error with a
stack trace — which names a single endpoint and reads like a crash
rather than like "this machine cannot reach the chain". The summary says
the latter in one sentence, before the stack arrives.

### Startup is not the all-endpoints-down wait

Running out of endpoints during normal operation holds every JSON-RPC
request for `rpcAllEndpointsDownPauseMS` and prints the Road Sign Yellow
banner. Startup does neither, and the two are separate by construction:
the wait belongs to `failoverToNextRPC`, which the probe does not call —
it walks the list itself and commits only on success.

For the operator that means a failed startup can be retried the moment
the connection is back. Nothing is being held, so there is no wait to
sit out first.

## How Scans Survive RPC Failures

A chunked log scan issues thousands of `eth_getLogs` requests, so over a
five-year range it will meet a failing endpoint. This section covers what
the app does about that: the retry that keeps a failure from costing
data, the two cases that can still leave blocks unread, and how those
blocks are picked up afterwards.

The short version: **an unhealthy endpoint costs time, not data.**

### A failed read is retried until it succeeds

Every read in the app goes through `getManagedReadProvider()`
(`src/lib/send-transaction.js`). When a read fails with an error that
indicates the endpoint rather than the request (the failover-eligible
errors listed under [RPC Failover](#rpc-failover)), it is tried again.
Each failure counts toward the endpoint's failure rate, and once that
rate crosses `rpcFailoverRatePercentage`, selection moves to the next
endpoint and the retries follow it. For a scan the loop
(`src/lib/rpc-read-retry.js`) has no exit condition: it keeps trying until
some endpoint serves the read.

Errors that say the *request* is at fault are not retried. An
`AbortError`, a block-range-cap rejection, and any other
non-failover-eligible error propagate on the first occurrence.

Two design choices follow from what a dropped read would cost.

**A scan never gives up.** (Reads someone is waiting on, such as
`getPoolState`, are bounded instead; see its section below.) A dropped
read is a dropped block window, and a
history short by one window is indistinguishable from a complete one at
every layer above it — the numbers still render, they are just wrong. A
stalled scan is the visible alternative: it appears in the log as
accumulating retry lines and resolves on its own when an endpoint
recovers. If an outage is long enough to matter, the operator sees it and
decides whether to wait or stop.

**There is no backoff.** Every provider is built by
`bot-provider.buildProvider`, which funnels each call through the global
pacing queue, so attempts are already spaced by
`globalRPCRequestRateIntervalMS` and the loop cannot spin. Adding a delay
here would be a second rate mechanism competing with the one that owns
the schedule.

#### Implementation detail: why the Proxy returns itself

`getManagedReadProvider()` is a Proxy whose `get` trap has three
branches, in this order:

```text
prop === "provider"         -> the proxy itself
typeof value !== "function" -> the active provider's value, raw
otherwise                   -> the method, wrapped in retry-on-failure
```

The active provider is re-resolved through `getCurrentRPC()` on every
access, so a failover between two calls takes effect on the next one
without anything holding a stale reference.

The first branch is what puts `queryFilter` — and therefore every log
scan — inside the retry at all:

```text
ethers contract.js  queryFilter -> getProvider(this.runner)
ethers contract.js  getProvider -> return value.provider || null
```

An ethers provider's own `.provider` is a getter returning itself, and is
therefore not a function, so without the first branch the second one
yields the raw provider and `getLogs` runs outside the wrapper. That
would exempt the event scanner, `scanNftEvents`, the HODL scan and the
pool-creation finder, on both the managed and unmanaged paths.
`test/send-transaction-read-failover.test.js` pins this with a real
`ethers.Contract` rather than a stub, since the behaviour under test is
how ethers resolves a contract runner.

### What can still leave blocks unread

Two cases, neither of them an endpoint being down.

The first is **interruption**: the process can be stopped by the
operator, a crash, or a restart while reads are still being retried, so
the work has simply not finished.

The second is a **non-endpoint error**. `_runWindow`
(`src/lib/get-logs-chunked.js`) rethrows an `AbortError` and a
block-range-cap rejection; under `bestEffort` it logs and skips anything
else that the retry did not treat as endpoint trouble.

Either way the scan does not fail — `bestEffort` records the window and
the scan returns success — so the recovery below is what keeps an unread
range from turning into a permanently short history.

### Resuming at the first unread block

The requirement is that the scan cache never claims coverage it does not
have. It records only the blocks it read without a break, so the next
scan resumes at the first unread block instead of stepping over it. Four
steps, one per layer:

| Step | Where | What it does |
| ---- | ----- | ------------ |
| 1 | `get-logs-chunked.js` | Under `bestEffort`, a failed window is logged and skipped, and `onWindowError(err, from, to)` fires for it |
| 2 | `event-scanner.js` | That callback keeps the **lowest** failed `from` as `firstGapFrom`, attached to the returned events |
| 3 | `event-scanner.js` | On persist, `_resolveLastBlock` returns `Math.max(scanFrom - 1, gap - 1)` instead of the chain head |
| 4 | `event-scanner.js` | The next scan starts at `cached.lastBlock + 1` — exactly the first unread block |

Two properties make this work. Both are easiest to see with numbers.

**The marker means "everything up to here was read without a break", not
"this is how far the scan got".** Suppose a scan starts at block
20,000,000, the chain head is 27,000,000, and the single window covering
24,000,000 to 24,008,999 is left unread while every other window
succeeds. The scan carries on to the head and caches every event it
found, including the ones above that window. It then records its marker
as 23,999,999 — one block below the unread range — rather than
27,000,000, because 24,000,000 onward is no longer backed by an unbroken
read.

Nothing is thrown away when that happens. The events already found above
the unread range stay in the cache; only the marker is rolled back. The
next scan therefore starts at 24,000,000 and reads to the head again, so
the range from 24,009,000 to 27,000,000 is read a second time. That costs
requests but cannot corrupt anything, because `mergeAndIndex` combines
the new results with the cached ones and drops any event whose `txHash`
it has already seen.

**The marker can never be pushed below where the scan began.** Continuing
the example: if a later scan resumes at 24,000,000 and its very first
window is left unread, the candidate marker would be 23,999,999 — but
that block was already covered and settled by the previous run. The
`Math.max(scanFrom - 1, …)` floor holds the marker at 23,999,999 rather
than letting it drag lower, so a failure near the start of one run cannot
re-open history an earlier run had finished with.

One limit is worth stating plainly. The marker guarantees that an unread
range is read by the *next* scan of that pool, but nothing schedules a
scan on account of an unread range alone. A pool that is never scanned
again keeps its marker parked where it is.

## `getPoolState` Validation + RPC Retry

`getPoolState` in `src/lib/rebalancer-pools.js` is the single entry point
for reading pool / token state from on-chain contracts (slot0, decimals,
tickSpacing, derived price). Because the value it returns flows into
every downstream P&L, IL, rebalance, and lifetime-deposit calculation,
a silent bad return from a flaky RPC call can poison every consumer
with `NaN` and never recover: a `decimals0` read as `undefined` makes
the lifetime deposit `$NaN`, and the "Syncing&hellip;" badge stays in a
rescan loop.

### Validation

Every successful RPC return is validated field-by-field before being
handed back. Each predicate covers **not-null + correct datatype +
value range**. Validation logic lives in `src/lib/pool-state-validate.js`
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

`getPoolState` keeps no endpoint list of its own. It retries through the
shared loop in `src/lib/rpc-read-retry.js`, which asks
`sendTx.getCurrentRPC()` which endpoint is current and reports every
outcome to the same failure rate that decides when to leave one. A pool
read is therefore an ordinary participant in process-wide selection:
when it moves off a failing endpoint, everything else moves with it, and
its own successes and failures count toward that decision rather than
being spent privately.

What it adds to the shared loop is a **bound**. Reads whose answer
nobody is waiting on retry until some endpoint serves them; a pool read
has a poll cycle or a Manage click waiting, so it stops. The budget is
`sendTx.endpointCount()` × `boundedReadAttemptsPerEndpoint` (2 as
shipped) — six attempts on the three-endpoint mainnet — and
`endpointCount()` rather than `config.RPC_URLS.length` because
`setRpcUrls` can leave the two disagreeing. `boundedReadRetryDelayMs`
(3 s as shipped) waits before re-asking **the same** endpoint, and is
skipped when the next attempt lands on a different one, which has no
reason to wait. Both settings are in `bot-config-defaults.json`, shared
with the re-open check's wallet read and the balance read after a swap.

**Every failure is retried, validation throws included** — the loop is
given `isFailoverable: () => true`. An endpoint answering with nonsense,
which is the case `pool-state-validate.js` exists for, is one another
endpoint may answer correctly, so a `PoolStateInvalidError` is treated as
that endpoint's fault rather than the pool's. Exhaustion raises
`PoolStateUnavailableError(attempts, cause)` carrying the most recent
cause, which the dashboard renders as `pool-info-unavailable` and
`bot-cycle.js` turns into a `pollError`.

Because it is the most frequent read in the bot, it is also the
best-informed witness to an endpoint's health, so it reports every
outcome. That is safe only because a rate decides and not a report: the
handful of failures one call can produce cannot retire an endpoint by
themselves.

### User-facing failure path

When `_tryInitPnlTracker` (`src/lib/bot-loop-detect.js`) sees a Pool*Error
from `getPoolState`, it **re-throws** (the catch otherwise swallows
everything and returns null). The throw propagates to `handleManage`
in `src/lib/server-positions.js`, which:

1. Discriminates the error type and returns **`HTTP 503`** with body
   `{ ok: false, error: "pool-info-unavailable", message: err.message, tokenId }`.
2. Runs the existing cleanup (drops the in-memory bot state, restores
   prior disk-config status, clears the `_starting` Set guard), so a
   subsequent Manage click starts from a clean slate.

The dashboard's `_handleManageFailure` in
`src/client/web/dashboard-events-manage.js` recognizes the
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
`src/lib/bot-cycle-drain.js`), its `cfg.positions[key].status` flips to
`stopped`, the bot loop stops, and the NFT is left intact (not
burned). To bring such a position back to life, the user clicks
**Manage** on its row in the dashboard. For closed positions, the
Manage button drives a guided three-step flow instead of starting the
bot loop directly:

1. **Wallet-token dust check.** Dashboard POSTs
   `/api/position/can-reopen` with the pair's two token addresses.
   Server reads on-chain `balanceOf` + token decimals + current USD price
   for each, compares each to `getDustThresholdUsd()` from
   `src/lib/dust.js`, and returns `{ canReopen, balances, dustThresholdUsd }`.
   `canReopen` is true when at least one of the two tokens is above
   the dust threshold.

   Reads are wrapped in a retry orchestrator that mirrors the
   `getPoolState` contract: both tokens must read cleanly
   in a single attempt &mdash; partial failure (one token reads, the
   other throws) counts as a complete attempt failure to avoid mixing
   verified + unverified balances in the response. Each configured
   RPC is tried up to `boundedReadAttemptsPerEndpoint` times (2 as
   shipped), `boundedReadRetryDelayMs` apart (3 s); on
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
   in the body: the rebalance takes the position's Range settings
   (Bot Configuration → Range) as any rebalance does. With No Override
   on, or no width saved, the rebalancer preserves the on-chain tick
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

   Re-open collects no per-rebalance width of its own: range width is a
   persistent Bot Configuration field, so the reopened position uses the
   same settings every other rebalance does.

When `!canReopen`, the dashboard shows a single-button modal listing
the current per-token wallet balances + the dust threshold so the
user knows exactly what they need to fund. No state change.

For a closed position **Rebalance is disabled** (a drained NFT has no
liquidity to remove), and **Manage is enabled** and routes through the
flow above. See `src/client/web/dashboard-data.js`
`_updateRebalanceButtons` and `src/client/web/dashboard-manage-badge.js` for
the button-state logic.

## Error Log & Reload Current Position

Together these are the escape hatch for one class of failure: a silent
server-side `catch` that leaves saved state subtly wrong, typically the
first pool-wide lifetime scan aborting before anything reaches disk.
What it leaves looks plausible: with the first scan's compounds never
saved, Fees Compounded shows only the compounds made after it, which
can be a small part of the true total.

### logs/error.log

**Owner:** `src/lib/error-log.js` &mdash; `writeErrorLog(err, context)`.

**Location:** logging.json → `errorLogPath`, relative to the process CWD
unless absolute; as shipped, `logs/error.log`, beside the diagnostic
`lp-ranger.log` from `src/lib/log-file.js`. Auto-created on first append;
gitignored via the project-wide `*.log` rule. The Reload Current
Position dialog names the configured path (`errorLogPath` in
`GET /api/status`), and `npm run clean` deletes the file there when it
lies inside the install folder.

**Entry format:**

```text
<four blank lines>
[YYYY-MM-DDTHH:MM:SS.sssZ] <context line>
<err.stack>
```

The four-line gap is deliberate: it sets each incident apart, so none
is missed when the file is opened. The file holds only the current run's
failures (see Lifecycle below), so copy it before restarting if you mean
to report one.

**Scope: catastrophic failures only.** The current callers are
`_recordScanFailure` in `src/lib/bot-recorder-lifetime.js` and the
token-decimals heal (`_handleHealResult`) in
`src/lib/bot-recorder-decimals-heal.js`. Do NOT add `writeErrorLog()` calls
to routine `catch` blocks, retry handlers, or expected transient errors.
Every added surface dilutes the "unread error.log &rArr; nothing
catastrophic has happened" invariant that makes the file useful.

`writeErrorLog` never throws &mdash; a filesystem failure while
trying to record another failure returns `false` and the caller
proceeds; a broken log path must not cascade into another catastrophic
error.

**Lifecycle &mdash; deleted on startup, self-clearing on heal.** The file
holds only the CURRENT session's failures. `resetErrorLog()` &mdash; called
from the `require.main === module` startup guard in `src/server.js` and `src/bot.js`
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
`src/client/web/dashboard-alerts.js` `_showCatastrophicModal`, which paints a
red modal (`.9mm-pos-mgr-modal-danger`) directing the user to Settings
&rarr; Reload Current Position. Dedup is per-position-key; a dismiss
keeps the modal down until the server clears the flag, at which point
it can fire again on a fresh failure.

### `POST /api/position/reload`

**Owner:** `src/lib/server-reload-position.js` &mdash;
`createReloadPositionHandler(deps)`. Wired into
`server-routes.js` and registered as
`"POST /api/position/reload"` in `src/server.js`.

**Body:** `{ positionKey }`. CSRF-gated like every other write route.

**In-progress guard:** If the server holds a stop, or the target
position has a scan running (`isAscanRunningOnThisPosition`,
`src/lib/scan-state.js`) or a coin move under way
(`isAcoinMoveUnderWayOnThisPosition`, the same module), the handler
returns `409 Conflict` with `{ error, message }` describing why. The
three error codes are:

- `server-stopping` &mdash; `npm run gentle-stop` asked the server to
  stop (`POST /api/stop-when-all-clear`), and it waits for the scans
  running; one started now would be cut off, or hold the stop.
- `scan-in-progress` &mdash; a full lifetime scan is already running.
  Starting a second one is not queued because `_triggerScan` does
  nothing while a scan runs (`isAscanRunningOnThisPosition`), leaving the reload's state
  clears in place while the pre-existing scan writes stale results
  back to disk. User waits for the current scan to finish (up to
  `reloadMaxWaitMs`, a dashboard setting, four hours as shipped) and
  clicks Reload again.
- `coin-move-under-way` &mdash; a rebalance or compound of the position
  has started: a poll is deciding or making it, from its first gate,
  before it holds the rebalance lock and raises `rebalanceInProgress` or
  `compoundInProgress`, to its end; or a Rebalance Now or Compound Now
  waits to be made. The message, the user's words: "A coin move
  (rebalance or compound) for this position has already started. Try
  again once it's complete." Re-scan Prices answers the same.

Every 409 falls through to the same yellow retry modal on the client
(`_showReloadBusyModal` in `dashboard-reload-flow.js`), so all
"busy" outcomes look identical to the operator. The dashboard's
Reload button is also disabled by `paintReloadPositionButton`
whenever `rebalanceInProgress` or `compoundInProgress` is truthy on
the currently-viewed position; the button is NOT tied to a running
scan because a normal startup or post-rebalance scan should not
permanently disable the escape hatch.

**Steps on success:**

1. Cancel any in-flight event scan for the pool
   (`cancelPoolScan(token0, token1, fee, wallet)`).
2. Delete the following on-chain-derived keys from the position's
   disk config, then save via `saveConfig`:
   `compoundedAmount0`, `compoundedAmount1`,
   `nftCompoundedAmountsByTokenId`, `nftGasWeiByTokenId`, `hodlBaseline`,
   `lifetimeHodlAmounts`, `totalLifetimeDepositUsd`,
   `depositUsedFallback`. The canonical list is
   `CHAIN_DERIVED_POSITION_KEYS` in `bot-config-keys.js`, shared with
   `npm run clear-blockchain-scan-cache`, which clears the same keys
   from every position. The compound list, `compoundHistory`, is not
   on it: the rebuild replaces the list whole, and takes from the old
   one what the chain cannot supply, each compound's trigger (Auto or
   Manual) and its Activity Log figures (see
   [Activity Log Figures](#activity-log-figures)). Clearing the
   compounded totals is what starts that rebuild.
3. Clear the pool's entry in the epoch cache
   (`_epochCache.clearCacheEntry(keyOpts)`). That drops its saved epochs,
   lifetime HODL amounts and fresh-deposit totals, so the fresh scan
   recomputes them.
4. Clear the pool's event cache file (`clearPoolCache(position, wallet)`).
5. Reset the same fields on the live bot state and set
   `_needsFullRescan = true`, `_needsEpochRebuild = true`,
   `_catastrophicScanError = null`, `lifetimeScanComplete = false`,
   `rebalanceScanComplete = false`, `totalLifetimeDepositUsd = 0`,
   `depositUsedFallback = false`. See
   `_resetBotState` in `server-reload-position.js`.

   `_needsEpochRebuild` is what makes step 3 mean anything. Clearing
   the cache on disk is not enough on its own: the bot loop holds its
   epochs in memory, so without the flag the completeness guard in
   `reconstructEpochs` would see a full history and do nothing, and the
   next poll would write the untouched set back over the cleared file.
   The flag is consumed
   once by `_consumeRebuildRequest` (`src/lib/epoch-reconstructor.js`),
   which also drops the tracker's closed epochs so a rebuild that
   fails leaves nothing stale behind — the next scan then sees an
   incomplete history and retries on its own. Deliberately not
   `_needsFullRescan`, which every rebalance sets; reusing that would
   rebuild the whole chain from scratch after each one.
6. `state._triggerScan()` &mdash; called synchronously and deliberately
   not awaited. An async function's body runs to its first `await`
   synchronously with its caller, so the scan is running before the
   endpoint returns 200 and the rebalance/compound gates below engage
   before any later poll can land. Until every move of the position is
   cleared, the scan waits instead (`_scanWaiting`) and starts when the
   poll that clears the move ends. The returned promise is dropped so
   the HTTP response does not wait on a scan that runs for minutes.
7. Respond `200 { ok: true, message: "Reload started", liveKey }`.

**Not called by any bot code path.** Reserved for the user's escape
hatch.

### Rebalance / compound suppression during the reload window

While a scan runs on a position, no rebalance or compound of that
position may start &mdash; one would race the state reconstruction and
re-corrupt the numbers the reload is trying to fix. A rebalance's own
scan request would be cleared by the scan running, leaving its deposits
and Activity Log figures out until the next start, and a compound would
be left out of Fees Compounded until the next rebuild of the compound
list. Instead of a bespoke `reloadInProgress` flag, the suppression
rides on the scan's own per-position flag, through the one rule for it
(`isAscanRunningOnThisPosition`, `src/lib/scan-state.js`):

- **Rebalance Now, Compound Now and a re-open retried with Manage** are
  refused at the server. `POST /api/rebalance` and `POST /api/compound`
  answer 409 with `scanInProgress: true` and the position's key, and the
  dialog the request came from waits for the scan to end, then offers
  its confirm button again (`src/client/web/dashboard-scan-wait.js`; Compound
  Now has its own dialog for this, which opens on the refusal).
  `POST /api/position/manage` with `forceRebalance: true` on a running
  position answers 409, asking for Manage again once the read finishes.
  The words are `scanRunningRefusal` (`src/lib/scan-refusal.js`).
- **Automatic rebalance**, the residual cleanup's included:
  `checkStateGates` in `src/lib/bot-cycle-gates.js` returns
  `{ rebalanced: false, scanRunning: true }`.
- **Auto-compound:** `checkCompound` in `src/lib/bot-cycle-compound.js`
  early-returns `false` when `!forced && isAscanRunningOnThisPosition(botSt)`.

The bot holds no Rebalance Now or Compound Now for a scan, so both gates
let one through: none is accepted while a scan runs, and the other way
round, no scan starts until every move of the position is cleared
(`isItOkayToStartAscan`, the negation of
`isAcoinMoveUnderWayOnThisPosition`, which Reload Current Position and
Re-scan Prices are refused on). None starts while a poll decides a rebalance or
compound, allowed or not (`duringMoveInitiation`, around each move path
in `src/lib/bot-cycle.js`), and none while a Rebalance Now or Compound Now
waits to be made (`forceRebalance`, `forceCompound`), however long it
waits, for gas, say. A scan asked for then waits (`_scanWaiting`), and
the bot loop starts it when the poll that clears the move ends
(`_startWaitingScan`). A waiting scan holds back no move: it waits for
the move, which goes first. Two flags are not a Rebalance Now: the
residual cleanup raises `forceRebalance` to pass the range check, and is
an automatic move, decided at each poll; and a dry run that turns a
Rebalance Now down ends it (`gatesFromGuard`), since left asked for it
would hold the position's scans until a restart.

Scans held back resolve to one. Each scan is the same whole operation,
so `_scanWaiting` is one flag however many are asked for, and a scan
asked for while one runs is not run again.

The invariant applies to every scan &mdash; not just reloads &mdash;
so a startup scan, a rebalance-triggered rescan, and a Reload
Current Position scan all get the same protection.

### Dashboard flow (`src/client/web/dashboard-reload-flow.js`)

`_reloadCurrentPosition`:

1. Read the active position from `_posStoreRef.getActive()`. Bail if
   nothing is active. No check of the in-progress flags: the server
   refuses while a coin move is under way, a window they cover only
   part of, and says so in its own words.
2. Show the blocking modal (`_showReloadBlockingModal`). Uses class
   `9mm-pos-mgr-blocking-overlay` (deliberately NOT `modal-overlay`)
   so the global Escape-key handler cannot dismiss it; the whole
   point is that the UI stays locked until the page reloads.
3. `POST /api/position/reload` with the composite key. On a non-OK
   response, remove the overlay and re-enable the button. A 409 with a
   message opens the yellow retry modal with the server's words
   (`_showReloadServerBusyModal`); any other failure `alert()`s the
   server's message (`body.message` when present, falling back to
   `body.error` or HTTP status).
4. Reset client-side caches (`resetHistoryFlag`, `clearHistory`,
   `resetLastFetchedId`) so the eventual page reload lands on a
   clean surface.
5. Poll `/api/status` every `dashboardPollIntervalMs` (3 s as shipped)
   via `_waitForReloadCompletion` until one of:
   - `lifetimeScanComplete === true` on the target position &rarr;
     `outcome = "complete"`.
   - `rebalanceInProgress` or `compoundInProgress` becomes truthy on
     the target position &rarr; `outcome = "raced"`. This is the
     ~500 ms race between the reload endpoint returning 200 and
     `_triggerScan` starting the scan; a poll
     cycle that lands in that window can start an auto-rebalance /
     auto-compound before the gate engages. The reload dismisses the blocking
     overlay and shows a yellow caution modal
     (`_showReloadRaceModal`) telling the user to wait for the
     operation to finish and click Reload again. No page reload &mdash;
     the server left the position untouched (the racing operation
     owns its own writes) and a refresh would show the same state.
   - A brand-new `_catastrophicScanError` with `at > startedAt` on
     the target position &rarr; `outcome = "failed-again"`. Falls
     through to the page reload so the user sees the fresh red modal.
   - `reloadMaxWaitMs` elapses (four hours as shipped) &rarr;
     `outcome = "timeout"`. Falls through anyway; the fresh page shows
     the Syncing badge and the 30 min recovery loop takes over from
     there.
6. `window.location.reload()` for every outcome EXCEPT `raced`
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
`src/lib/price-source-cascade.js` accepts the first source returning any
positive number, with no plausibility check. One bad response therefore
lands in any stored dollar figure — and the lifetime scan deliberately
refuses to rebuild a figure disk already holds, so a bad one is
permanent until something asks for it to be rebuilt.

Reload asks for that, but re-walks the pool's whole Transfer history
(minutes to hours). This route sets `_needsPriceRevalue` on the bot
state and calls `_triggerScan`, so the existing lifetime scan re-values
immediately. `lifetimeScanPlan` reads the request and runs three steps
that a saved figure would otherwise skip:

| Figure | Rebuilt from |
| ------ | ------------ |
| Fees Compounded (`compoundedAmount0` / `compoundedAmount1`, `compoundHistory`, `nftCompoundedAmountsByTokenId`) | the chain's events — the coins, which carry no price |
| Lifetime Deposit (`totalLifetimeDepositUsd`) | the saved deposits, at the historical price for each deposit's own block |
| HODL baseline entry value (`hodlBaseline.entryValue`) | the saved mint amounts, at the historical price for the mint's block |

The token amounts behind all three are read from chain but never
re-derived from the pool's history, which is the cost advantage over
Reload.

Fees Compounded is the odd one in that table, because the row covers
two figures that answer to different rules. The KPI is the saved coins
priced wherever it is shown, so no stored price can make it wrong and
Re-scan Prices cannot improve it. The Compound Log's per-event dollars
are stored (`compoundHistory[].usdValue`), so they can be stale, and
this is the action that rewrites them — the same pass that reads the
chain values each event at the fresh prices. A position slot holding no
coins gets them from the same pass. The Activity Log figures of a
compound the bot recorded when it happened stay as they were; those of
one found only on the chain are worked out again, at prices read past
the cache ([Activity Log Figures](#activity-log-figures)).

**Nothing is deleted.** Each figure is overwritten only once its
replacement exists, and each step keeps the saved figure when its price
source answers with nothing. Only a scan that finishes clears the
request, so a scan that fails is retried on the next pass; the request
lives in memory, so a restart drops it and the figures stand as they
were.

Clearing a figure to make the guard rebuild it is the thing to avoid.
While it is missing another writer can fill it — `_bumpRebalanceFees`
credits a rebalance's fees into whatever is there — and the guard then
reads that partial number as settled, so it survives every later scan.

A price is remembered in two places, and a re-value has to read past
both:

- `app-data/scan-cache/historical-price-cache.json` keeps historical prices with no
  expiry. `fetchHistoricalPriceGecko` takes `refresh`, which skips the
  cached entry and overwrites it with whatever comes back.
- Each deposit entry memoizes the dollar figure it was last given, and
  `totalLifetimeDeposit` returns that figure without asking any source.
  It takes `refresh` for the same reason.

Current-price reads run inside `withFreshPricesAllowed` for the length
of the re-value, so neither the idle pause nor the price cache can
answer with the figure being replaced.

The 30-minute rescan loop also fires on an unanswered request
(`_needsLifetimeRescan`), since the route's own trigger can fail, and a
scan is the only thing that reads it. A scan clears only the requests it
carried in: one that arrives mid-scan describes a chain that scan never
read, so it waits for the next one.

Body: `{ positionKey }`.

Rejects with 409 `not-managed` unless the position's **disk config**
says `status: "running"` — `status` lives on the config, not the
bot-state object, and `src/lib/build-status-positions.js` merges the two for
the API response. Also rejects mid-rebalance, mid-compound, and while a
scan is already running.

Cost: one batched read of the chain's three event histories, from each
NFT's mint. On a long chain that is minutes; see
[One read per pass](#one-read-per-pass) for measured figures.

## Dead Code Detection

[Knip](https://knip.dev) is gated on **unused files only**:
`npm run knip:files` runs inside `npm run lint` and `npm run check`, so a
file nothing reaches fails the build. `knip.json` declares the entry
points knip cannot see for itself — `scripts/`, `util/` and `test/` hold
tools run from a shell, not imported — so that answer can be trusted.

Unused **exports** are deliberately not gated. `src/client/web/dashboard-*.js` is
reached through HTML that knip cannot trace, and `src/lib/` and `util/`
export their internals on purpose so tests and other tools can compose
them. Run bare `npm run knip` to see those, as information.

---

## SVG Assets

**Rule:** every SVG icon in the dashboard lives as a standalone `.svg`
file under `src/client/web/icons/`. No inline `<svg>` markup in HTML or JS.
Two categories exist because two different rendering shapes are needed;
the file-per-icon convention and the shared validation pipeline are
identical for both.

### Category 1 — Activity-Log icons (`act-*.svg`)

Prefix: `act-`. Loaded via **`<img src="icons/act-<name>.svg">`**.
Registered as URL strings in the `ACT_ICONS` map in
`src/client/web/dashboard-helpers.js`.

**Why `<img>`.** These icons render once per Activity Log entry, so an
inline `<svg>` would put dozens of clones of the same markup in one
document, and every `id=""` inside it — for example the
`<defs><path id="rope">` in `act-lasso.svg` — would be duplicated.
`<img>` renders each instance in its own document context, so ids stay
per-file and cannot collide.

**No `currentColor`.** `<img>`-loaded SVGs don't inherit the parent
page's `color`, so every stroke and fill in `act-*.svg` uses an
explicit hex value. Outline icons hard-code `stroke="#e0eaf4"` (the
resolved value of `--text` on the dark chip background); the two
colour icons (`act-acorn.svg`, `act-lasso.svg`) hard-code their
whites and dark green. Don't casually re-introduce `currentColor` on
these files — the log renders them via `<img>` and it won't cascade.

### Category 2 — UI icons (`ui-*.svg`)

Prefix: `ui-`. Inlined into `src/client/web/index.html` **at build time** by
`scripts/inline-svgs.js`. `scripts/build-bundles.js` runs it last, after
esbuild and `cache-bust.js`, so the page it writes carries the stamp; it
does so for `npm run build` and after each `npm run build:watch`
rebuild. Source `src/client/web/index.html` carries
`data-svg="…" data-w=".." data-h=".."` placeholder attributes; the
build script reads each referenced file, sizes the root `<svg>` per
the data-attrs, and writes the composed HTML to
`src/client/web/dist/index.html`. The server prefers `src/client/web/dist/index.html`
at `/` when it exists (see the top of the static-file handler in
`src/server.js`) and falls back to `src/client/web/index.html` when it doesn't —
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
src="…">` icons served from `src/client/web/icons/` get the
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

1. Create `src/client/web/icons/<prefix>-<name>.svg` (`act-` for log entries,
   `ui-` for HTML-embedded icons).
   - Root `<svg>` MUST have `xmlns="http://www.w3.org/2000/svg"` and a
     `viewBox`.
   - `act-*` files: no `currentColor` — hard-code every colour.
   - `ui-*` files: `currentColor` and `var(--…)` both work.
   - No `id=` attributes anywhere in the file.  Repeat shapes
     inline if you'd otherwise reach for `<defs>` + `<use>`.
2. Register it:
   - `act-*` → add `<name>: "icons/act-<name>.svg",` to the
     `ACT_ICONS` object in `src/client/web/dashboard-helpers.js`, then call
     `act(ACT_ICONS.<name>, …)` from a call site.
   - `ui-*` → put a `<span data-svg="icons/ui-<name>.svg" data-w=".." data-h="..">…</span>`
     placeholder into `src/client/web/index.html`.
3. Run `npm run check`.

### Validation

Enforced by `scripts/lint-svg.js`, which runs in **both**
`npm run lint` (so the pre-commit hook catches it) and `npm run check`
as the `lint-svg` gate (so CI catches it). Fails on: malformed XML,
missing root `<svg>`, missing `xmlns` / `viewBox`, or any `id=`
attribute anywhere in a file.

CI runs `npm run check` and nothing else, which is why the gate is in
both. The smoke test below does not cover these rules — an `id=` on a
referenced icon passes it — so the two are complementary, not
redundant.

A separate smoke test (`test/icons-files.test.js`) fails if:

- an `ACT_ICONS` entry has no matching file on disk,
- a `data-svg="icons/…"` placeholder in `index.html` has no matching
  file on disk, or
- a file under `src/client/web/icons/` isn't referenced from either registry.

Both checks run under `npm run check`.

`scripts/lint-svg.js` uses `@xmldom/xmldom` (devDependency) so
validation runs in pure Node — CI doesn't need `xmllint` installed.

---

## CSS Class-Name Escapes

Every utility class in `src/client/web/9mm-pos-mgr.css` starts with a digit, so
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
nothing. No gate catches it: stylelint passes, Prettier passes, the
tests pass, and the only symptom is the declaration not applying in the
browser. Because line width decides which rules break, a long rule can
stop applying while a short rule on the same component keeps working,
so the symptom presents as a behavioural defect rather than a formatting
one.

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

For step-through debugging of `src/server.js` (dashboard + bot) or `src/bot.js`
(headless), use the `debug` / `debug-bot` npm scripts. Both launch the
Node inspector bound to `127.0.0.1:9229` &mdash; local-only by design.

| Script | Command | Use when |
| ------ | ------- | -------- |
| `npm run debug` | `node --inspect src/server.js` | Start a fresh dashboard + auto-started bot with the inspector pre-attached |
| `npm run debug-bot` | `node --inspect src/bot.js` | Start a fresh headless bot with the inspector pre-attached |
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
| `npm start` | One Node process &mdash; `src/server.js` serves the dashboard AND auto-starts the bot **in the same V8 isolate** | `npm run debug-attach` (only). The single `src/server.js` target in `chrome://inspect` already exposes every bot module &mdash; set a breakpoint in `src/lib/bot-loop.js`, `src/lib/bot-cycle.js`, etc. on that target and it hits as the in-process bot polls. `debug-attach-bot` will correctly report "no node bot.js process via pgrep" because there is no separate bot process. |
| `npm run bot` | One Node process &mdash; `src/bot.js`, headless, no dashboard | `npm run debug-attach-bot` (only). |
| `npm start` AND `npm run bot` simultaneously (rare &mdash; two terminals) | Two Node processes that would both try to bind inspector port `9229` &mdash; the second one's inspector start fails silently and stays invisible in `chrome://inspect` | Start one of them with `INSPECTOR_PORT=9230` baked in (`INSPECTOR_PORT=9230 node --inspect-port=9230 src/bot.js`) so the two inspectors don't collide; then attach each on its own port. |

#### Connecting from `chrome://inspect`

1. Run `npm run debug-attach` (server) or `npm run debug-attach-bot`
   (headless bot). The terminal prints the PID it signalled and the
   default WS endpoint `ws://127.0.0.1:9229`.
2. Open `chrome://inspect` in a local Chrome / Chromium tab.
3. Under **Remote Target**, the Node process should appear within a
   second or two. Click the blue **inspect** link below it. A
   dedicated DevTools window opens connected to the process, with full
   Sources / Console / Profiler / Memory access. If the target doesn't
   appear, click **Configure...** and confirm `localhost:9229` is in the
   discovery list.
4. **Sources** tab &rarr; navigate the project tree (`src/`,
   `src/client/web/`, etc.) and set breakpoints. They hit on the next code
   path that runs (e.g. the next poll cycle for bot code).

Stale entries in the **Target discovery settings** dialog (e.g. a
`localhost:9222` left over from a prior session) are harmless &mdash;
no live inspector is bound to them and they will show no targets
underneath. Remove them with the X next to each entry or ignore them.

#### Log timestamp prefix

The `src/lib/log.js` module exports an opt-in `log` object with `info` /
`warn` / `error` methods that prepend a UTC timestamp to every line
&mdash; `log.info("[bot] OOR but within 5% threshold")` emits
`[bot] [2026-06-16 20:32:02] OOR but within 5% threshold`. When the
first argument doesn't start with a `[tag]` prefix, the timestamp is
prepended bare. The browser-side dashboard ships an ES-module mirror
at `src/client/web/dashboard-log.js`.

The wrapper is **opt-in** &mdash; modules that want timestamped output
`require("./log")` and call `log.info(...)` instead of
`console.log(...)`. The global `console` object is **never modified**
(monkey-patching standard JS globals risks clashing with other
libraries and is a security concern). Existing `console.log` call
sites continue to work unchanged; migrate them to `log.info` as you
touch surrounding code.

#### Production debugging (Pi 5 over RealVNC)

Production runs with SSH disabled for security &mdash; all remote
access is via RealVNC. Debugging happens entirely inside the Pi's
RealVNC desktop session, with no port tunneling involved, and in a
Chrome or Chromium tab on that same machine.

1. In the Pi terminal: `npm run debug-attach` attaches to the running
   server with no restart. To start fresh instead, stop LP Ranger with
   `npm run gentle-stop`, which waits for any rebalance, compound or
   scan under way, then run `npm run debug`.
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

The `"dependencies"` block in `package.json` is intentionally small so
the review surface stays tractable. Every runtime dependency is
well-vetted:

- **Cryptography / tokens** — Node's built-in `crypto` module plus
  `csrf` (pillarjs, widely deployed behind Express).
- **EVM math** — `ethers` v6, `@uniswap/v3-sdk`, `jsbi`.
- **Concurrency** — `async-mutex`.
- **Config** — `dotenv`.
- **Validation** — `validator` (the rpc url check).
- **Command lines** — `commander` (the `util/` tools' arguments).
- **Formatting** — `numbro` (dashboard USD figures) and
  `telegram-escape` (Telegram's MarkdownV2).
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

The top-level `"overrides"` object in `package.json` holds these
entries:

| Override | Reason |
| -------- | ------ |
| `@uniswap/v3-staker: 1.0.2` | The parent (`@uniswap/v3-sdk`) declares an exact pin `"1.0.0"`, not a caret range. npm cannot resolve `1.0.2` without the override. No advisory — just a minor bugfix version. |
| `@uniswap/swap-router-contracts` → `hardhat-watcher` → `hardhat` and `chokidar`, both `npm:empty-npm-package@1.0.0` | Hardhat is a ~200 MB Solidity compiler toolchain required as a peer dep by `hardhat-watcher`, which is itself a transitive dep of the Uniswap SDK; `chokidar` is the watcher's file watcher, and carried the `braces` high advisories. LP Ranger never compiles Solidity or runs the watcher, so both are replaced with an empty stub and nothing downloads. |
| `adm-zip: ^0.6.0` | `github-actionlint`, a dev-time workflow linter, pins an older `adm-zip` with two high advisories (a crafted ZIP allocates 4 GB). No runtime exposure. |
| `@exodus/bytes` → `@noble/hashes: ^1.8.0` | jsdom's `@exodus/bytes` needs `^1.8.0`, while the hoisted copy is 1.3.2 from ethers, which made `npm ci` reject the lockfile. |
| `markdownlint-cli2` → `js-yaml: 5.2.2`, `smol-toml: ^1.8.0` | The linter exact-pins both, at versions with high advisories, so no lockfile regeneration can move them. |
| `@scalar/json-magic` → `undici: ^7.29.1` | The API reference's dependency exact-pins an `undici` with a high advisory; the override matches the version jsdom already resolves, so one copy serves both. |

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
8. **Build the bundles** — `npm run build` produces `src/client/web/dist/bundle.js`
   and the User Manual's `src/client/web/dist/manual-figures.js`.
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
- `src/client/web/dist/` — **prebuilt** browser bundles, the dashboard's and
  the User Manual's, so the user's machine never runs esbuild on
  potentially compromised source.
- All `src/`, `src/client/web/`, `docs/`, config — as committed to the
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
(documented in [Security § Supply Chain & Dependencies](security.md#supply-chain--dependencies))
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
[Security § `npm audit`](security.md#npm-audit) for the detailed rationale on
the one currently-accepted ecosystem-wide advisory
(`elliptic` reachable transitively through `@uniswap/v3-sdk`).

The security audits run as three independent jobs in
`.github/workflows/security-audit.yml` (`audit:deps`,
`audit:security`, `audit:secrets`) so each one can be individually
required in branch protection.

### Lifecycle Script Controls

`package.json` declares two lifecycle scripts:

- **`postinstall: node scripts/copy-fonts.js`** — copies self-hosted
  WOFF2 fonts from `node_modules/@fontsource/*` into `src/client/web/fonts/`
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

**Production runtime (`"dependencies"`)** — all vetted per the
Philosophy section above:

- `@fontsource/rye` — self-hosted display font for the disclaimer modal.
- `@uniswap/v3-periphery` — V3 reference contract ABIs.
- `@uniswap/v3-sdk` — exact 160-bit sqrtPrice math
  (`maxLiquidityForAmounts`, `SqrtPriceMath`).
- `async-mutex` — rebalance lock.
- `commander` — argument parsing and `--help` for the `util/` tools.
- `csrf` — CSRF token generation/verification (pillarjs).
- `dotenv` — `.env` file loading.
- `ethers` — EVM math, address checksumming, transaction signing.
- `jsbi` — BigInt shim the Uniswap SDK requires for exact arithmetic.
- `navigo` — client-side router for deep-link URLs.
- `numbro` — number formatting for the dashboard's USD figures.
- `telegram-escape` — escaping for Telegram's MarkdownV2 messages.
- `validator` — the rpc url check (`validator.isURL`).

**Development and CI (`"devDependencies"`)** — tooling only, not
shipped to users at runtime:

- `eslint` (v10), `@eslint/js`, `globals`, `eslint-config-prettier`,
  `eslint-plugin-security`, `eslint-plugin-no-secrets` — ESLint flat
  config in [`eslint.config.js`](../eslint.config.js).
- `stylelint` + `stylelint-config-standard` — CSS linter.
- `html-validate` — HTML linter for `src/client/web/*.html`.
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
- `eslint-plugin-n` — fails lint on an `import` or `require` path that
  does not resolve.
- `@xmldom/xmldom` — XML parsing for `scripts/lint-svg.js`.
- `github-actionlint` — linter for `.github/workflows/*.yml`.
- `jsdom` + `global-jsdom` — a DOM for the dashboard modules' tests.
- `madge` — dependency-cycle finder.
- `yaml` — parses `.github/pages-site.yml` for the Pages builder.
