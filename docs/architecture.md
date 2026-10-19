# LP Ranger — System Architecture

LP Ranger is built as two cooperating halves: a **backend bot** that handles all
data-side and networking work, and a **web application** that serves as a
real-time view into the bot with GUI controls. The two halves communicate
through a well-defined HTTP API, documented in an interactive local Scalar
API reference (`npm run api-doc`).

Four companion references sit alongside this one:

- [`docs/configuration.md`](configuration.md): how the app is configured —
  every environment variable, where each setting lives, and which are
  deliberately not editable.
- [`docs/security.md`](security.md): the controls protecting the wallet and
  the gates enforcing them.
- [`docs/npm-project-commands.md`](npm-project-commands.md): every npm command
  and its flags.
- [`docs/engineering.md`](engineering.md): runtime state, development tools
  and the check-report pipeline.

---

## Table of Contents

- [The Two Halves](#the-two-halves)
  - [Backend: The Bot](#backend-the-bot)
  - [Frontend: The Web App](#frontend-the-web-app)
- [The API Layer](#the-api-layer)
- [Data Flow](#data-flow)
  - [Bot → Dashboard](#bot--dashboard)
  - [Dashboard → Bot](#dashboard--bot)
  - [Persistence](#persistence)
- [The Rebalance Pipeline](#the-rebalance-pipeline)
- [The Compound Pipeline](#the-compound-pipeline)
- [Multi-Position Concurrency](#multi-position-concurrency)
- [P&L Tracking](#pl-tracking)
  - [Lifetime P&L Components](#lifetime-pl-components)
  - [Lifetime Impermanent Loss / Gain](#lifetime-impermanent-loss--gain)
  - [Scan Architecture: Single Fetch, Two Classifiers](#scan-architecture-single-fetch-two-classifiers)
  - [Lifetime Sync vs Bot Loop](#lifetime-sync-vs-bot-loop)
- [Idle-Driven Price-Lookup Pause](#idle-driven-price-lookup-pause)
- [Security Model](#security-model)
- [Technology Choices](#technology-choices)

---

## The Two Halves

### Backend: The Bot

The bot is the engine. It manages one or more concentrated liquidity positions
on a Uniswap V3-compatible DEX, polling the blockchain at regular intervals,
detecting when positions drift out of range, and executing multi-step rebalance
transactions to re-center them. It also tracks profit and loss, collects and
compounds trading fees, and maintains a complete history of every rebalance
going back up to five years.

All blockchain interaction flows through the bot: RPC calls to read pool state,
transaction signing and submission, gas price management, and on-chain event
scanning. The bot holds the wallet's private key in memory (never written to
disk in plaintext) and serializes all transactions through a single async mutex
to prevent nonce collisions when managing multiple positions from the same
wallet.

The bot can run in two modes:

- **With dashboard** (`npm start` / `npm run build-and-start`): the default.
  `server.js` starts an HTTP server that serves the web app and simultaneously
  runs bot loops for all managed positions.
- **Headless** (`npm run bot`): `bot.js` runs the bot without any UI. Useful
  for server deployments where no browser access is needed.

### Frontend: The Web App

The web app is a single-page dashboard served as static files from the same
Node.js process that runs the bot. It provides a real-time view of every
managed position — current value, fee earnings, P&L breakdown, range status,
rebalance history — and a set of controls for managing the bot's behavior.

The dashboard is built from small ES module source files in `public/`
(`dashboard-*.js`), bundled by esbuild into a single `bundle.js`. It uses no
frontend framework — just vanilla JavaScript, DOM manipulation, and CSS.
Fonts are self-hosted (no CDN dependencies). Client-side URL routing via
Navigo provides bookmarkable deep links to specific positions.

Nearly everything the dashboard displays comes from the bot via the HTTP
API, and every action the user takes (start or stop managing a position,
trigger a rebalance, change settings) is a POST or DELETE to an API
endpoint. Two reads go elsewhere. When a wallet is imported, the browser asks
the primary rpc endpoint how many transactions the address has sent, to tell
a used wallet from a new one. And opening Check for Updates & About asks
GitHub's api for the latest release.

---

## The API Layer

The HTTP API is the contract between the two halves. It is documented in an
OpenAPI 3.0 spec (`docs/openapi.json`) and can be browsed interactively via
the Scalar API reference (`npm run api-doc` on port 5556).

The endpoints fall into these groups, which are the reference's tags:

- **Status** — `GET /api/status`, which the dashboard polls every
  `dashboardPollIntervalMs` (three seconds as shipped), returns the full
  state of all managed positions: pool prices, P&L snapshots, throttle
  state and scan progress.
- **Config** — `POST /api/config` saves per-position settings (slippage,
  threshold, timeout, auto-compound) and global ones (rpc list, gas fee
  limit, approval multiple).
- **Wallet** and **API Keys** — import, unlock, reveal and clear the
  encrypted wallet; store the encrypted third-party api keys.
- **Positions** — scan the wallet for LP positions; start and stop
  management; fetch quick details or full lifetime P&L; re-open, reload or
  re-scan prices; and answer whether a position is managed or being
  adjusted.
- **Rebalance** and **Compound** — force either on demand.
- **UI** — the dashboard settings, the help's figures, the Bot Configuration
  defaults and the LP providers.
- **Telegram** and **Price Lookups** — alert settings and a test message;
  pausing and resuming price lookups.
- **System** — `GET /health` and a graceful shutdown.

The server uses Node's built-in `http` module with a simple route table — no
Express or other framework. Responses are JSON. The API has no login.
Instead it binds to `localhost` by default, refuses a POST or DELETE sent
from any browser origin but the dashboard's own, and requires a CSRF token
in the `x-csrf-token` header of every POST and DELETE.

---

## Data Flow

### Bot → Dashboard

Each managed position runs its own independent `startBotLoop()` instance.
Every poll cycle (default 300 seconds), the bot reads the pool's current state
from the blockchain, computes P&L, and writes the results to an in-memory
state map via an `updateBotState` callback. When the dashboard polls
`GET /api/status`, the server reads this map and returns the full state for
all positions.

The dashboard flattens the response, matches it to the currently-viewed
position by composite key (`blockchain-wallet-contract-tokenId`), and updates
the DOM. This polling architecture means the dashboard is stateless — a page
refresh picks up exactly where it left off.

### Dashboard → Bot

User actions flow in the opposite direction as HTTP POST/DELETE requests.
When the user clicks "Manage" on a position, the dashboard sends
`POST /api/position/manage { tokenId }`. The server starts a new bot loop
for that position and responds with success. When the user saves a slippage
setting, the dashboard sends `POST /api/config { slippagePctToken0,
positionKey }` (or `slippagePctToken1`), and the server updates the
per-position config on disk.

### Persistence

The bot persists its state to three locations:

1. **`app-config/` directory** — all app-managed config, in two
   subdirectories. `app-defaults-for-user-configurable/` holds the tracked
   shipped defaults, `chains.json` among them. `user-configurable/` holds
   the operator's files: `bot-config.json` (managed positions and
   per-position settings) and its automatic snapshot
   `bot-config.backup.json`; the encrypted wallet `wallet.json` (AES-256-GCM,
   PBKDF2-SHA512 at 600,000 iterations); the encrypted third-party api keys
   `api-keys.json`; and any override of a shipped file.
2. **`app-data/` directory** — per-install runtime data. Contains the
   historical rebalance event log (`rebalance_log.json`) and each
   position's records (`position-records.json`: HODL baseline, compound
   history and coins, gas per NFT, lifetime deposit, residuals).
   Separate from `app-config/` because it's per-install data, not config.
3. **`app-data/scan-cache/` directory** — JSON file caches for expensive
   blockchain queries (event scan results, P&L epoch history, historical
   prices, block times, LP position lists, pool orientation). Deleting
   these forces a rebuild from the blockchain on next startup, which takes
   about an hour per position, so they live with the install's data
   rather than in the disposable `tmp/`.

The dashboard persists its own state to browser `localStorage` — the position
store (up to 300 entries), last-viewed position, realized gains, and initial
deposit values.

---

## The Rebalance Pipeline

A rebalance starts when the position is out of range and either the price
has passed the OOR threshold or the OOR timeout has run out. Every gate must
pass first — the throttle, the pool's daily cap and the Impermanent Loss
Guard among them — and the gas check must find gas cheap enough. Rebalance
Now skips the gates but not the gas check. The pipeline then runs as one
sequence under the rebalance lock:

1. **getPoolState** — read the current tick, price, decimals and **tick
   spacing** from the pool. Tick spacing comes from
   `factory.feeAmountTickSpacing(fee)`, fresh on every call. V3 forks like
   9mm Pro define fee tiers missing from upstream Uniswap's built-in map
   (`fee=20000` → `spacing=400`), so a cached or built-in fee→spacing table
   would mint positions that revert on those pools.
2. **ownerOf** — verify the wallet still owns the NFT.
3. **removeLiquidity** — drain the position via `decreaseLiquidity` +
   `collect` (atomic multicall). The old NFT is kept, not burned.
4. **computeDesiredAmounts** — use the Uniswap V3 SDK's exact sqrtPrice math
   to determine how much of each token the new position needs at the target
   tick range.
5. **swapIfNeeded** — convert the excess token into the deficient one. The
   primary path is the active chain's aggregator: on PulseChain, the
   Watergun Aggregator, which routes across PulseChain DEXes for the lowest
   slippage. The V3 SwapRouter is the fallback, and the only path on a
   chain with no aggregator. Two **swap-gates** (`src/swap-gates.js`) run
   before every swap:
   - **Dust gate** (first) — skips a swap worth less than the gold-pegged
     dust threshold. It is cheaper and more reliable to evaluate than the
     gas gate, so it runs first and short-circuits.
   - **Gas gate** — skips a swap whose estimated gas would cost more than
     `gasFeePct` of its value (Settings → Gas Fee Threshold; 1% as shipped),
     so gas cannot eat the swap on a volatile or thin route.

   When either gate trips, the rebalance goes on to mint with the balances
   unswapped; any leftover is mopped up later by the corrective swaps or the
   residual-cleanup rebalance.
6. **Corrective swaps** (`src/rebalancer-correct.js`) — a swap routed
   through the position's own pool moves that pool's price, which can leave
   the coins off the new range's ratio. The pool is read again, and while
   the imbalance is above the dust threshold another swap follows, up to
   `correctiveSwapMaxRounds` rounds.
7. **mintPosition** — mint a new NFT at the re-centered tick range with the
   swapped balances.

A transaction stuck in this pipeline is recovered in four phases
(`_waitOrSpeedUp`, in `src/tx-speedup.js`): wait for confirmation; resend at
the same nonce with higher gas (1.5× on PulseChain); wait again; then send a
zero-value self-transfer at that nonce to cancel it, and wait until something
mines there. This covers every transaction that goes through
`sendTx.sendTransaction`, which is every step above except the aggregator
swap. That swap brings its own loop: after its wait it cancels and asks for
a fresh quote. If neither the swap nor its cancel has mined, the rebalance
fails rather than swap the same balance again through the V3 router.

---

## The Compound Pipeline

Compounds are simpler than rebalances — same NFT, same range, just sweep
unclaimed fees back into liquidity. The flow:

1. **collect** — pull unclaimed fees from the position into the wallet.
2. **swapForCompound** (`src/compounder-swap.js`) — optional
   ratio-correcting swap so the collected fees match the ratio the
   position currently expects. Without this step, the Position Manager
   would only accept the side that fits and leave the rest as residual.
   Reuses the same `computeDesiredAmounts` math and `swapIfNeeded` path
   as the rebalance pipeline, gated by the same dust-then-gas gates.
3. **increaseLiquidity** — re-deposit the (now ratio-balanced) tokens into
   the same NFT.

When the swap-gates skip the swap (a dust-sized imbalance, or gas too dear),
the compound offers just the collected fees. The position takes what fits
its ratio, and the rest stays in the wallet as a tracked residual for the
next rebalance to fold back in.

When the swap does fire, the deposit is offered the wallet's whole
post-swap balance of both tokens. So any other balance of them goes in too,
as far as it fits the ratio: a residual from an earlier rebalance, or the
same coin left over from another position. `residual-tracker` caps its
reported residual to the actual `balanceOf`, so its figures correct
themselves on the next read.

---

## Multi-Position Concurrency

LP Ranger manages multiple positions simultaneously from a single wallet.
Each position runs its own poll loop independently, but all positions share
a single provider, signer, and — critically — a single rebalance lock.

The lock ensures only one position sends transactions at a time. Without it,
two positions trying to rebalance simultaneously would use the same nonce,
causing one transaction to fail or replace the other. The lock has no
timeout: a move holds it until the move has ended and its transactions have
settled on chain.

Polling continues for all positions even while one holds the lock. A position
that needs to rebalance or compound waits for the lock, executes its full
pipeline, then releases it for the next position.

---

## P&L Tracking

P&L is tracked per position across "epochs" — each epoch spans from one
rebalance to the next. When a rebalance occurs, the current epoch closes
(recording exit value, fees earned, gas spent) and a new epoch opens.

For positions with history, LP Ranger reconstructs past epochs by scanning
on-chain Transfer events up to five years back, identifying the rebalance
chain (consecutive NFT mints by the same wallet in the same pool), and
fetching historical token prices from Moralis when a key is stored, else from
GeckoTerminal's OHLCV API.

Epoch data is cached to disk (`app-data/scan-cache/pnl-epochs-cache.json`) keyed by pool
identity — not by tokenId — so P&L history survives rebalances (which mint
new NFTs) without migration.

### Lifetime P&L Components

Three figures from the lifetime scan feed the Lifetime panel's P&L:

- **Lifetime deposited amounts** (`lifetimeHodlAmounts`) — the tokens
  deposited into the pool from outside across the whole rebalance chain,
  computed by `src/lifetime-hodl.js` and kept in the pool's epoch cache
  (`app-data/scan-cache/pnl-epochs-cache.json`). The first NFT's mint is the original
  deposit; a later IncreaseLiquidity worth more than the fees collected is
  an external deposit.

  **Fresh deposit detection algorithm** — for each rebalance boundary
  (drain on NFT[i-1] → mint/IncreaseLiquidity on NFT[i]):

  1. **Identify the window** — from the previous NFT's mint block to the
     current NFT's mint (or IncreaseLiquidity) block.
  2. **Scan wallet Transfer events** for token0 and token1 across the
     full window.  This covers both pre-drain deposits and post-drain
     deposits without counting residuals from prior rebalances.
  3. **Drop LP traffic** — transfers sent from the position manager or the
     pool (a drain, a collect, a refund) are not deposits, and neither is a
     transaction in which both tokens only come in.
  4. **Group transfers by txHash** — if a single TX decreases one token
     and increases the other, it is a **swap** and both legs are excluded.
  5. **Credit native-coin wraps** — when one token is the wrapped native
     coin, a wrap into it (its `Deposit` event) counts as a fresh deposit of
     that token, with or without a Transfer event.
  6. **Sum remaining inbound transfers** — these are genuine fresh deposits.
  7. **Accumulate** into lifetime HODL amounts.

  The first NFT in the chain has no drain — its full mint amounts are the
  original deposit.  When no provider is available (e.g. tests without
  RPC), rebalance mints contribute zero and the system falls back to the
  current HODL baseline.

  **Incremental caching:** Fresh deposit totals (raw BigInt amounts + last
  scanned block) are cached in `app-data/scan-cache/pnl-epochs-cache.json` via
  `getCachedFreshDeposits` / `setCachedFreshDeposits` in `epoch-cache.js`.
  On subsequent runs, only rebalance boundaries past the cached block are
  scanned — previously accumulated fresh amounts are restored from cache.
  Each boundary costs four log scans (two tokens, in and out), plus one for
  wraps when a token is the wrapped native coin; each scan is split into
  windows of `getLogsChunkSize` blocks.

  The scan a rebalance triggers takes exactly this path. That rebalance
  minted with the wallet's whole balance of both tokens, so any coins
  that arrived since the previous mint are now deposits in the position;
  the one new boundary is scanned and the rest come back from cache.

- **Lifetime compounded amount** (`compoundedAmount0` / `compoundedAmount1`,
  saved with the position's config) — the **coins** each NFT earned in fees
  and re-deposited, whether by a compound or by the rebalance that closed
  it. Each NFT's figure is its Collect amounts less the principal its
  DecreaseLiquidity events released (`lifetimeFeeAmounts`). The per-event
  compound history is the IncreaseLiquidity events after the mint, less the
  rebalance-adjacent ones (`_filterRebalances`).

  The saved figure is coins, never dollars. A stored dollar total is true
  only at the price that computed it, so on an old position its error grows
  without bound. `snap.totalCompoundedUsd` is therefore computed fresh on
  every poll, coins × current price, through `src/coin-value.js`. The
  historical figures keep their own prices on purpose: Total Lifetime
  Deposit values each deposit at its own block, the HODL Baseline's Entry
  Value stands at the NFT's mint, and a closed epoch in the Per-Day P&L
  table keeps the dollars it closed at.

- **Lifetime gas** (`totalGas`) — the native coin every transaction of the
  chain paid: each NFT's mint plus every charge against it, summed from the
  receipts and kept per NFT (`nftGasWeiByTokenId`). The Lifetime line prices
  that coin at today's native-token price; the Per-Day P&L table keeps each
  closed period's gas at its close day's price.

### Lifetime Impermanent Loss / Gain

Lifetime IL/G answers: "compared to simply holding every token I deposited,
how has LPing performed?"  The formula:

```text
IL = (LP_value − compoundedFees + walletResidual)
     − (hodlAmount0 × currentPrice0 + hodlAmount1 × currentPrice1)
```

Compounded fees come off the LP side. Compounding calls
`increaseLiquidity`, so those fees are part of the liquidity
`positionValueUsd` measures, while the HODL side stays fixed at the
amounts deposited. Leaving them in would report reinvested earnings as
LP outperformance, and the Profit figure already counts them. The
lifetime figure removes `snap.totalCompoundedUsd`; the current-NFT figure
removes only that NFT's share, since its mint value already contained
the earlier compounds. Both are the saved coins priced at the current
poll, so IL/G does not drift as the pair moves after a compound.

`ilFigures` (`src/bot-pnl-il.js`) computes both, and is the only place
either is computed; it calls `computeHodlIL` from `src/il-calculator.js`.
It is pure — every input is an argument — which is what lets the bot tier
and the unmanaged details endpoint share it despite holding their state in
different shapes. A position therefore reports the same IL/G managed or
not: managing one changes nothing on chain, so nothing on screen may move
when it starts or stops. (Comparing the raw LP value instead would differ
by the whole compounded amount, enough on a long-running position to flip
the sign.)

The lifetime figure's HODL amounts come from `lifetimeHodlAmounts`
(accumulated by the fresh deposit detection algorithm), falling back to the
first closed epoch or the current HODL baseline while the scan has not
run yet.

### Scan Architecture: Single Fetch, Two Classifiers

To avoid duplicate RPC calls, the lifetime scan fetches IncreaseLiquidity,
DecreaseLiquidity, and Collect events for the **whole rebalance chain in one
batched read** (`scanChainNftEvents` in `src/nft-events-batch.js`). `tokenId`
is the first indexed parameter on all three events, and a log filter's topic
slot OR-matches an array, so one filter carries every NFT in the chain. The
node returns the logs interleaved; the batch partitions them by `topics[1]`,
floors each NFT's logs at its own mint block, and puts them in chain order.
The same pre-fetched events are then passed to two classifiers:

1. **Compound classifier** (`classifyCompounds`) — identifies fee re-deposits.
2. **Lifetime HODL classifier** (`computeLifetimeHodl`) — accumulates external
   deposits.

Both classifiers share `_filterRebalances` to distinguish rebalance-adjacent
events from genuine deposits/compounds.

The unmanaged details view reads no chain at all. It shows no Lifetime
panel and no Per-Day P&L, so there is nothing it would walk a chain to
produce. Its Current-panel Fees Compounded and Gas come from one scan of
the NFT being looked at, floored at that NFT's own mint block
(`_detectCurrentNftValues`), or from the coins already on disk.

Epoch reconstruction needs a subset of the same history — Collect and
DecreaseLiquidity for the closed NFTs — before it builds any epoch. When the
lifetime side is going to read the chain in the same pass, reconstruction
takes its histories from that read: the bot's scan pass prepares the
lifetime read before reconstruction (`prepareLifetimeRead`). Otherwise
reconstruction reads the closed NFTs itself, in one batch
(`scanChainCollectAndDrain`). Either way the chain is read once per pass.
Reconstruction runs for the bot only; the unmanaged view builds no
epochs, because it renders no Per-Day P&L.

The scan reads the chain only when it has something to compute. Once the
HODL amounts, the compound total and the lifetime deposit are all on disk
(`lifetimeFiguresSaved`), it reads nothing, so after the first complete scan
a restart reads nothing for them. Two requests make it read again:

- **A rebalance flags a full rescan.** That rebalance minted with the
  wallet's whole balance, so coins that arrived since the previous mint are
  deposits in the new NFT. The HODL amounts and the lifetime deposit are
  derived again.
- **Re-scan Prices asks for a re-pricing.** The amounts stand, and every
  dollar figure built on them is fetched again at fresh prices. See
  docs/engineering.md § `POST /api/position/rescan-prices`.

A read starts at the pool's creation block, lifted to the chain's first mint
and taken from the pool when the read runs, because a figure computed from
scratch needs the whole chain. The compound total and the lifetime deposit
are saved and restored with the position's config (`PERSISTED_STATE_KEYS` in
`src/server-positions.js`), and compounds and rebalances add to the compound
total as they happen. The HODL amounts are kept in the pool's epoch cache.

A pass whose event scan fails computes none of these figures. The chain the
bot holds would be whatever it held before the pass — nothing, on a cold
start — and figures computed from it would be saved and kept by later
passes. So when the pass needed a read, the position stays unready instead,
and the 30-minute rescan retries the pass.

### Lifetime Sync vs Bot Loop

Dashboard readiness — the "Synced" badge and the blur over the Lifetime
panel — tracks whether the lifetime scan has completed, not whether the bot
loop is running. The two are different jobs. The lifetime scan (event scan,
epoch reconstruction, price fetching) produces the reporting; the bot loop
exists to monitor the position and act on it — rebalance when out of range,
auto-compound when the fee threshold is crossed.

Kept apart, a position's badge does not depend on when its own bot loop
starts. Only a managed position has a Lifetime panel, so only its own scan
can mark it "Synced": an unmanaged position's details fetch never sets the
flag, so it cannot show "Synced" for a position whose managed scan has not
started yet. One thing overrides every position's badge: after a launch,
while the server is still starting the positions saved as managed, one at
a time, the badge reads "Syncing" whatever is on screen. The server reports
that start-up's progress in `GET /api/status` (`startingManagedPositions`),
and the Syncing state keeps Manage and Stop Managing disabled until it ends.

---

## Idle-Driven Price-Lookup Pause

Token-price endpoints (Moralis, GeckoTerminal, DexScreener) are quota-limited.
When nobody is watching the dashboard and no rebalance or compound is
imminent, fetching prices on every poll cycle just burns quota for data
nobody reads. The idle-driven pause stops the cascade in those windows
while keeping it instantly available for any move.

All gating happens at the public API of `src/price-fetcher.js`, before the
source cascade. The same module is required by both the bot tier
(rebalance / compound hot path) and the server tier (view-only endpoints
for unmanaged-position detail and closed-position history) — it is the
single chokepoint. Adding or removing a price source later requires zero
changes here.

These set the pause flag, or bypass it:

| Source | Effect | Notes |
| --- | --- | --- |
| `server.js` startup | flag = `false` | Browser idle tracker / endpoints take over from there. |
| Server-side idle tracker | flag = `true` after 15 min of no `/api/*` traffic | Catches the "browser fully closed" case (`src/server-idle-tracker.js`). |
| Browser-side idle (`public/dashboard-idle.js`) | flag = `true` via `POST /api/pause-price-lookups` after 15 min with no input; flag = `false` via `POST /api/unpause-price-lookups` on the next activity (focus / mouse / keyboard / touch / pointer) | 500 ms throttle on activity events. |
| Move scope (`withFreshPricesAllowed`) | counter increment > 0 forces fresh fetches inside the move; restores prior flag on completion (success or throw) | Wraps every auto- and manual-triggered rebalance / compound. Purely scoped — no "remember to re-pause." |
| `bot.js` headless startup | flag = `true` (default); opt out with `--start-with-price-lookups-unpaused` | No dashboard, no idle signal — only moves need prices. |

`/api/*` traffic resets the server-side idle countdown but does NOT
auto-unpause. The 3-second `/api/status` poll loop would otherwise fight
the browser-issued pause. Unpausing is always explicit.

Pool-tick polling is unaffected by pause state. OOR detection, threshold
checks, and OOR-timeout countdowns are tick-based on-chain RPC calls, not
part of the price-source cascade. When paused with an empty cache,
`fetchTokenPriceUsd` returns `0`, which the P&L snapshot tolerates. The gas
check before a rebalance never meets that `0`: it runs inside the move
scope, so it always gets a fresh price.

Three global keys tune the caching. They are saved in `bot-config.json`'s
global section, with their defaults in `bot-config-defaults.json`:
`priceCacheTtlMs` (120000 as shipped), `dustUnitPriceCacheMultiplier` (30)
and `moveCacheTtlMs` (4000, the cache's life inside a move). The
dust-unit-price TTL is computed at module init as
`priceCacheTtlMs × multiplier`, with a runtime assertion guarding the
integer-multiple invariant.

The browser-side flag (`isBrowserPaused()` in `public/dashboard-idle.js`)
is also the gate for `playSound()` in `public/dashboard-sounds.js`:
polling-driven rebalance and compound jingles are suppressed while the
dashboard is idle, so a user returning to a long-untouched tab is not
greeted with a backlog of event sounds. `playSoundAlways()` (Easter Egg,
title tune) is unaffected. The move scope never touches the browser flag,
so a rebalance or compound that runs while the user is away plays no sound.

---

## Security Model

- **Private keys** are never written to disk in plaintext. On disk they
  are encrypted with AES-256-GCM, under a key derived from the wallet
  password and a random salt (PBKDF2-SHA512, 600,000 iterations). The
  encrypted file is gitignored.
- **Localhost only** by default. The server binds to `127.0.0.1` so only
  local connections are accepted. CORS is locked to `localhost:<PORT>`,
  mutating requests from non-localhost origins are rejected, and every POST
  and DELETE must carry a CSRF token.
- **Nonce safety** is enforced by the async mutex rebalance lock — only one
  transaction chain executes at a time.
- **Slippage protection** uses quote-based minimums (not spot price) and
  aborts when price impact exceeds the user's setting.
- **Automated security checks** run in CI: dependency CVE audit, ESLint
  security plugin, and secretlint for hardcoded credentials.
- Find complete Security engineering details in the [Security reference](https://github.com/nottoseethesun/lp-ranger/blob/main/docs/security.md).

---

## Technology Choices

LP Ranger is deliberately minimal in its dependency footprint:

- **No web framework.** The HTTP server uses Node's built-in `http` module
  with a plain route table. This keeps the attack surface small and avoids
  framework churn.
- **No frontend framework.** The dashboard is vanilla JS with direct DOM
  manipulation. esbuild bundles it from ES modules into a single file.
- **No database.** All state is JSON files on disk. The app remains stateless
  — caches are pure optimization, rebuilt from the blockchain if deleted.
- **Exact math where it matters.** Token ratio calculations use the Uniswap
  V3 SDK's 160-bit sqrtPrice math (via JSBI) to avoid floating-point errors
  that could cause failed mints.
