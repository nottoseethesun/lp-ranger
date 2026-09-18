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
[`server.js`](#serverjs) section below, which walks through the startup
sequence.

---

## Table of Contents

- [Terminology](#terminology)
- [Quick Start](#quick-start)
- [`npm` Project Commands](#npm-project-commands)
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
- [Per-NFT Scan Windows](#per-nft-scan-windows)
  - [Cost](#cost)
  - [Batched chain reads](#batched-chain-reads)
    - [One read per pass](#one-read-per-pass)
  - [Call sites](#call-sites)
  - [The dashboard does not scan a position the bot owns](#the-dashboard-does-not-scan-a-position-the-bot-owns)
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
- [Security](#security) → [`docs/security.md`](security.md)
- [Check Report Artifacts](#check-report-artifacts)
- [API Documentation](#api-documentation)
- [`server.js`](#serverjs)
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

---

## `npm` Project Commands

Every command defined in `package.json`. Run with `npm run <name>`;
`start`, `test` and `stop` also work without `run`. Flags go after a
`--` separator, as shown in the examples.

### Lifecycle Commands

Starting and stopping a running install.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `bot` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h`, `--start-with-price-lookups-unpaused` | Headless bot, no dashboard. Requires `PRIVATE_KEY` in `.env` or an imported wallet. Price lookups start paused to conserve quota; the flag disables that for continuous P&L cache warming. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run bot -- --start-with-price-lookups-unpaused` |
| `clear-blockchain-scan-cache` | `--dry-run` | Delete every blockchain scan cache in `tmp/`. Refuses to run while the server is up. `--dry-run` lists what would go without deleting. | `npm run clear-blockchain-scan-cache -- --dry-run` |
| `start` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h`, `--headless` | Start the dashboard server and auto-start every position saved as `running`. `--headless` prompts for the wallet password on the terminal instead of needing a browser. Does not build first; a `prestart` hook verifies the artifacts exist. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm start -- --verbose` |
| `stop` | — | Clean shutdown: reads `tmp/lp-ranger.pid` and sends SIGTERM, the same path as Ctrl+C. Falls back to an lsof-by-port lookup when no PID file exists. | `npm stop` |

### Developer Tools

Building, running from source, debugging, inspecting the codebase, and resetting local state.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `api-doc` | — | Serve the Scalar API reference at `http://localhost:5556`. | `npm run api-doc` |
| `build` | — | Full build: version stamp, manual and disclosure content, UI tokens, the esbuild bundle, cache-bust stamps, inlined SVGs. | `npm run build` |
| `build-and-start` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h` | Build the dashboard bundle, then start the server. The usual command after pulling changes. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run build-and-start -- --log-file /tmp/burn-in.log` |
| `build:watch` | — | esbuild in watch mode. Rebuilds the bundle on change; skips the one-off generators `build` runs. | `npm run build:watch` |
| `clean` | — | Full reset to fresh-clone state: wallet, bot config, API keys, rebalance log, every `tmp/` cache, logs and build artifacts. Rebuild before starting again. | `npm run clean` |
| `clean:log` | — | Truncate `logs/lp-ranger.log`. | `npm run clean:log` |
| `debug` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h` | Start the server under `node --inspect`. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run debug` |
| `debug-attach` | — | Attach a debugger to an already-running server and print the URL to visit. | `npm run debug-attach` |
| `debug-attach-bot` | — | The same for a running headless bot. | `npm run debug-attach-bot` |
| `debug-bot` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h` | Start the headless bot under `node --inspect`. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run debug-bot` |
| `dev` | `--verbose`/`-v`, `--log-file [PATH]`, `--help`/`-h` | Build, then start under `node --watch` so the server restarts on file changes. `--log-file` with no path writes to `logs/lp-ranger.log`, or the `path` set in `logging.json`. | `npm run dev -- --verbose` |
| `dev-clean` | — | The same, but keeps the price, block-time and Gecko caches, which cost API quota to rebuild. | `npm run dev-clean` |
| `format` | — | Prettier write pass over the tracked file set. | `npm run format` |
| `knip` | — | Dead-code detection. The `dashboard-*.js` files report as unused because knip cannot trace HTML `<script>` tags — those are false positives. | `npm run knip` |
| `lint` | — | Linters only: ESLint, stylelint, html-validate, SVG policy, openapi-sync, markdownlint, Prettier across JS/JSON/YAML, actionlint. | `npm run lint` |
| `lint:fix` | — | The same set with autofix where each tool supports it. | `npm run lint:fix` |
| `nuke` | — | Delete `node_modules` and `package-lock.json` for a clean reinstall. | `npm run nuke` |
| `reset-wallet` | — | Delete `wallet.json` and scrub `WALLET_PASSWORD` from `.env`. | `npm run reset-wallet` |
| `restore-settings` | — | Restore whatever `wipe-settings` backed up. | `npm run restore-settings` |
| `show-dependency-cycles` | — | madge circular-import report across the whole source tree. | `npm run show-dependency-cycles` |
| `show-gallery` | — | Serve a Pages-accurate preview of the screenshot gallery at `http://localhost:5557`. | `npm run show-gallery` |
| `view-report` | — | Open the PDF report produced by the last `check`. | `npm run view-report` |
| `wipe-settings` | — | Back up operator settings to `tmp/.settings-backup/` to simulate a fresh install. `check` uses this, so never run it against a live server. | `npm run wipe-settings` |

### Test

The gates. `check` runs all of them and is what must pass before a commit.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `audit:deps` | — | `npm audit` at the `high` threshold. | `npm run audit:deps` |
| `audit:secrets` | — | secretlint across the repo. | `npm run audit:secrets` |
| `audit:security` | — | The custom security lint rules. | `npm run audit:security` |
| `check` | — | The full gate: every linter, the test suite, coverage and the audits, summarised in one table. What must pass before a commit. Writes reports to `test/report-artifacts/`. | `npm run check` |
| `format:check` | — | Prettier in check mode; fails rather than rewriting. | `npm run format:check` |
| `test` | any `node --test` flag | Run the suite with a concurrency of 24. | `npm test -- --test-name-pattern="failover"` |
| `test:coverage` | — | The suite with V8 coverage collection. | `npm run test:coverage` |
| `test:util` | — | Only the `util/diagnostic/` suites. | `npm run test:util` |
| `test:watch` | — | Re-run affected tests on file change. | `npm run test:watch` |

### Commands That Are Usually Not Run Alone

npm lifecycle hooks and helpers. These run automatically around the command each is named for.

| Command | Flags | Description | Example |
| ------- | ----- | ----------- | ------- |
| `clean:reports` | — | Remove `test/report-artifacts/`. Invoked by all nine `pre*` hooks — `precheck`, `prelint`, `prelint:fix`, `pretest`, `pretest:coverage`, `pretest:watch` and the three `preaudit:*` — so every gate starts without stale reports. | `npm run clean:reports` |
| `copy-fonts` | — | Copy the self-hosted WOFF2 files from `node_modules` into `public/fonts/`. Also runs automatically via `postinstall`. | `npm run copy-fonts` |
| `postinstall` | — | Runs automatically after `npm install`; copies the fonts. | automatic |
| `precheck`, `prelint`, `prelint:fix`, `pretest`, `pretest:coverage`, `pretest:watch`, `preaudit:deps`, `preaudit:security`, `preaudit:secrets` | — | Run automatically before the command each is named for; clear stale reports and regenerate generated content so the gate starts from a known state. | automatic |
| `prepare` | — | Runs automatically after `npm install`; installs the husky hooks. | automatic |
| `prestart` | — | Runs automatically before `start`; verifies the build artifacts exist. | automatic |

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
| Residual tracker | `residual-tracker.js` | Per-pool leftovers across rebalances. Feeds both the IL/G credit and the cleanup sweep. |
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
totals persisted and is safe to shut down — by Ctrl+C or `npm stop`,
which share a shutdown handler.

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
while both the dashboard and the server are idle — those lookups are
quota-limited and there is nobody watching.

Then the price decides which of two things can happen.

**In range — compound.** If auto-compound is on and unclaimed fees have
grown past the configured threshold, the fees are collected and added
back to the same NFT. No new NFT, no change of range. A minimum spacing
between compounds stops small positions burning gas on dust.

**Out of range — rebalance.** A series of gates run first: recent
rebalance frequency, the pool's daily cap, the Impermanent Loss Guard,
and a gas check that defers the move if it would cost too much relative
to the position. A manual **Rebalance Now** skips the gates but still
counts against the daily cap.

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

It then starts each position whose saved status is **running**,
confirming the wallet still owns each NFT first — one sold or transferred
since the last run is dropped from management rather than started against
an NFT that is gone.

Positions start staggered rather than together. With the default poll
interval and two positions, the second waits 150 seconds. That spreads
both their polling and their scans instead of firing every request at
once.

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

When a rebalance fails, the position enters a degraded state: the error
is recorded, polling backs off to a longer interval, and the dashboard
shows the position as stuck. Nothing about that state expires on its
own. Something has to notice when the position is healthy again, clear
it, and tell the operator.

This section is how the app decides that a poll means **recovered**. The
decision is one predicate, and both ways of getting it wrong cost
something real:

- **Missing a recovery** leaves a working position flagged as broken and
  polling at the backed-off interval, so it reacts late to the next move.
- **Declaring one falsely** discards the error explaining why the
  position is stuck, and announces a still-blocked position as
  recovered.

### What recovery does

`_handleRecovery` in [`src/bot-loop.js`](../src/bot-loop.js) restores
normal operation in one step:

| Cleared or restored | Effect |
| ------------------- | ------ |
| `rebalanceError`, `rebalancePaused`, `rebalanceFailedMidway` | The dashboard stops showing the position as stuck |
| `firstFailureAt`, `midwayRetryCount` | The failure streak is forgotten, so the next failure starts a fresh one |
| `currentIntervalMs` | Back to the configured poll interval, undoing the failure backoff |
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
equivalent and is not. A poll can decline to rebalance for at least nine
distinct reasons, and most return a shape that names no reason at all:

| Result shape | Returned by |
| --- | --- |
| `{rebalanced: false}` | throttle, pool daily cap, dry run, aborted-and-drained short-circuit, drain timer |
| `{…, withinThreshold: true}` | out of range but inside the OOR threshold |
| `{…, priceVolatile: true}` | volatile-price deferral |
| `{…, scanRunning: true}` | scan in progress |
| `{…, swapBackoff: true}` | swap backoff |

A negative test reads every row above as a recovery. It would also need a
new clause each time a gate is added, and the failure mode of forgetting
one is silent.

### Why `inRange` can be trusted

`inRange` is set by `_checkRangeAndThreshold`
([`src/bot-cycle.js`](../src/bot-cycle.js)), which runs **before** every
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
`src/telegram-notifications/balanced-notifier.js` (`BALANCED_THRESHOLD`, `BALANCED_COOLDOWN_MS`)
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
   `tmp/pool-creation-blocks-cache.json`, making it a once-per-pool cost
   paid only on a cold cache.

3. **Disk cache** (subsequent runs resume from the last scanned block)

   Results from a completed scan are persisted to
   `tmp/event-cache-{blockchain}-{contract}-{wallet}-{token0}-{token1}-{fee}.json`
   via `cache-store.js`. On the next run `loadCache()` reads the cached
   events and sets `scanFrom = lastScannedBlock + 1`, so only blocks
   produced since the previous scan are queried. A 5-year first-time
   scan issues ~1,750 chunked queries (9,000 blocks per chunk, every
   request released by the global request queue — see
   [RPC Request Pacing and Log Chunking](configuration.md#rpc-request-pacing-and-log-chunking));
   a warm-cache rescan on the same wallet issues a handful.

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

`src/nft-mint-blocks.js` owns the floor rule:

| Function | Answers |
| --- | --- |
| `mintBlocksByTokenId(events)` | tokenId → mint block |
| `nftScanFrom(mints, id, sharedFloor)` | where one NFT's scan starts |
| `nftScanFromBlock({mintBlock, sharedFloor})` | the same, for a caller holding the block rather than the events |
| `chainScanFloor(events, poolFloor)` | the floor for the chain's oldest NFT |

Two rules within that module decide correctness:

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
  Per-Day P&L table, and `_applyFirstMint` in `src/position-history.js`
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
so a scan's wall-clock time is its request count divided by four per
second. Chunk width is 9,000 blocks.

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

Every read of a whole chain is one pass, not one pass per NFT. Three
places read a chain, all through `scanChainNftEvents`
(`src/nft-events-batch.js`):

| Reader | Events | NFTs | Serves |
| --- | --- | --- | --- |
| `fetchAllNftEvents` (`src/bot-recorder-scan-helpers.js`), prepared by `prepareLifetimeRead` | all three | the whole chain | the bot's lifetime scan — Fees Compounded, lifetime HODL, deposit — and epoch reconstruction in the same pass |
| `scanChainCollectAndDrain` (`src/position-history-scan-helpers.js`) | `Collect`, `DecreaseLiquidity` | closed NFTs not already in the epoch resume buffer | epoch reconstruction, when nothing else in its pass reads the chain |
| `_detectCurrentNftValues` (`src/position-details-compound.js`) | all three | the one NFT being looked at | the unmanaged view's Current-panel Fees Compounded and Gas |

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

A scan pass needs the chain's history twice: epoch reconstruction wants
Collect and DecreaseLiquidity for the closed NFTs, and the lifetime
figures want all three event types for every NFT. The first is a subset
of the second, so when the lifetime side is going to read the chain in
that pass, reconstruction takes its histories out of that read
(`collectAndDrainOf`) rather than making its own. A read shared this way
is made once however many consumers ask (`shareRead`).

- **The bot.** `_scanAndReconstruct` asks `lifetimeScanPlan` as soon as
  the event scan has found the chain. When the lifetime scan will read,
  the pass prepares that read (`prepareLifetimeRead`,
  `src/bot-recorder-lifetime-read.js`) and hands it to reconstruction;
  the lifetime scan then uses the same read. When the read runs, it
  looks up the pool's creation block and decides whether the resume
  buffer can still be trusted.
- **The unmanaged view.** Nothing to share: it builds no epochs, because
  it renders no Per-Day P&L, and reads no chain.

Three rules keep the sharing sound:

| Rule | Why |
| --- | --- |
| Reconstruction shares only a read that will happen anyway | Otherwise it pays for a third event type and the live NFT to save nothing; with nothing else reading, its own two-type read is cheaper |
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

The three chain readers in the table above each hand the batch the
chain's mint blocks, so every NFT is floored at its own mint.

Three places read a single NFT, floored at that NFT's own mint:
`src/bot-pnl-current-nft.js` and `_detectCurrentNftValues` in
`src/position-details-compound.js` read the current NFT, and
`src/position-history.js` reads a closed position looked at on its own.
The last takes its floor from `result.mintBlockNumber`, which
`_supplementFromEvents` fills from the rebalance events before any scan
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

`src/compounder.js` is exempt because it defines the single-NFT scan and
leaves the floor to its caller. Three files are exempt because they
search *for* a mint block and so cannot be bounded below by one:
`src/event-scanner-mint-lookup.js`, which instead stops at the first
chunk that yields a hit, `src/hodl-baseline.js` and
`src/position-history-mint.js`.

### The dashboard does not scan a position the bot owns

The dashboard's unmanaged-details path computes the same per-NFT
history the bot computes for a position it manages. Running both is two
full passes over every NFT in the chain, so the dashboard suppresses its
fetch for a managed position.

`shouldSkipUnmanagedFetch()` in `public/dashboard-unmanaged.js` is the
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
`managedPositions` (`src/handle-api-status.js`) is the union of live bot
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
assemble both ways into two directories and `diff -r` them. The failure
this catches is a page silently paired with the wrong stylesheet, which
renders without erroring and looks plausible until someone opens it.

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
`src/bot-cycle-compound.js` adds the same compound's **coins** to the
position's `compoundedAmount0` / `compoundedAmount1`, and those coins
priced at the current poll are half of the dashboard's lifetime
fee-earnings figure (`currentFeesUsd + snap.totalCompoundedUsd`, see
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
  the decimals heal / override path in `src/bot-recorder-decimals-heal.js`
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
**deliberately mutate local state** to put the app into a specific
recovery path on demand. Distinct from the read-only Node tools above:
each script backs the original up to a timestamped sibling first and
prints the exact restore command.

- `inject-stuck-lifetime-state.sh` — Sets every pool entry in
  `tmp/pnl-epochs-cache.json` to `freshDeposits: null` and
  `lifetimeHodlAmounts: null`. On the next
  `npm start` that combination drives the lifetime-scan recovery path in
  `src/bot-recorder-lifetime.js` and `src/bot-loop.js` (see
  [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause)
  for the surrounding price-lookup gating), which is what exercises the
  `lifetimeScanComplete` flag and the Syncing badge. A cache built by a
  normal run never has that shape, so the path is otherwise unreachable
  locally.

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
exposes, eight more keys with no input of their own, and three nested
groups. The dashboard fetches it at init via
`GET /api/bot-config-defaults`; the server falls back to it when
`getConfig` is asked for a value the user has not overridden. Per-user
overrides live in `app-config/user-configurable/bot-config.json`.

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

**No Bot Settings input.** These have no field in the Bot Settings panel.
Whether they can be changed at runtime at all depends on membership of
`GLOBAL_KEYS` in [`src/bot-config-v2.js`](../src/bot-config-v2.js): a key
in that list is accepted by `POST /api/config`, and one that is not can
only be changed by editing
`app-config/user-configurable/bot-config-defaults.json` and restarting.

| Key | Default | Changed by | Description |
| --- | --- | --- | --- |
| `moralisEnabled` | `true` | the Moralis API Key dialog | Whether the stored Moralis key is used for price lookups. Separate from whether a key exists, so switching it off stops the calls without discarding the key — which is what an operator wants when a quota runs out. The control is disabled when no key is configured |
| `priceCacheTtlMs` | `120000` | `POST /api/config` | In-memory token-price cache TTL — see [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause) |
| `dustUnitPriceCacheMultiplier` | `30` | `POST /api/config` | Dust-unit-price TTL as a multiple of `priceCacheTtlMs` |
| `moveCacheTtlMs` | `4000` | `POST /api/config` | Cache TTL for the fresh-price window around a rebalance or compound |
| `pricePauseExceptionPollWindowMultiple` | `10` | `POST /api/config` | Poll cycles between the balanced-band notifier's fresh-price probes. The dashboard reads it to label the resulting cadence next to the checkbox, but offers no field to set it |
| `getLogsChunkSize` | `9000` | the JSON file, then restart | Widest block span any `eth_getLogs` call may request. Clamped to 10,000 by [`src/bot-config-defaults.js`](../src/bot-config-defaults.js) — see [RPC Request Pacing and Log Chunking](configuration.md#rpc-request-pacing-and-log-chunking) |
| `globalRPCRequestRateIntervalMS` | `222` | the JSON file, then restart | Minimum milliseconds between any two JSON-RPC requests leaving the process. `0` disables pacing, which is only sensible against a local node |

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
   builds the server object. `requestTimeout` is left at Node's own
   default: it bounds how long a client may take to **send** a request,
   not how long a handler may take to answer one, so raising it does
   nothing for a long-running scan and only weakens a slow-client
   guard.
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

## How Scans Survive RPC Failures

A chunked log scan issues thousands of `eth_getLogs` requests, so over a
five-year range it will meet a failing endpoint. This section covers what
the app does about that: the retry that keeps a failure from costing
data, the two cases that can still leave blocks unread, and how those
blocks are picked up afterwards.

The short version: **an unhealthy endpoint costs time, not data.**

### A failed read is retried until it succeeds

Every read in the app goes through `getManagedReadProvider()`
(`src/send-transaction.js`). When a read fails with an error that
indicates the endpoint rather than the request — `SERVER_ERROR`,
`TIMEOUT`, `NETWORK_ERROR`, or any 5xx — the call moves to the next
configured endpoint and is tried again. The loop
(`src/rpc-read-retry.js`) has no exit condition: it keeps cycling
endpoints until one serves the read.

Errors that say the *request* is at fault are not retried. An
`AbortError`, a block-range-cap rejection, and any other
non-failover-eligible error propagate on the first occurrence.

Two design choices follow from what a dropped read would cost.

**It never gives up.** A dropped read is a dropped block window, and a
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
(`src/get-logs-chunked.js`) rethrows an `AbortError` and a
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
   `getPoolState` contract: both tokens must read cleanly
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

   Re-open collects no per-rebalance width of its own: range width is a
   persistent Bot Settings field, so the reopened position uses the same
   settings every other rebalance does.

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
config's compounded coins had been populated entirely by a single
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
`_recordScanFailure` in `src/bot-recorder-lifetime.js` and the
token-decimals heal (`_handleHealResult`) in
`src/bot-recorder-decimals-heal.js`. Do NOT add `writeErrorLog()` calls
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
   `compoundHistory`, `compoundedAmount0`, `compoundedAmount1`,
   `nftCompoundedAmountsByTokenId`, `nftGasWeiByTokenId`, `hodlBaseline`,
   `lifetimeHodlAmounts`, `totalLifetimeDepositUsd`,
   `depositUsedFallback`. The canonical list is
   `CHAIN_DERIVED_POSITION_KEYS` in `bot-config-v2.js`, shared with
   `npm run clear-blockchain-scan-cache`, which clears the same keys
   from every position.
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
coins gets them from the same pass.

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

- `tmp/historical-price-cache.json` keeps historical prices with no
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
bot-state object, and `src/build-status-positions.js` merges the two for
the API response. Also rejects mid-rebalance, mid-compound, and while a
scan is already running.

Cost: one batched read of the chain's three event histories, from each
NFT's mint. On a long chain that is minutes; see
[One read per pass](#one-read-per-pass) for measured figures.

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
