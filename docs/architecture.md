# LP Ranger — System Architecture

LP Ranger is built as two cooperating halves: a **backend bot** that handles all
data-side and networking work, and a **web application** that serves as a
real-time view into the bot with GUI controls. The two halves communicate
through a well-defined HTTP API, documented in an interactive local Swagger
doc-set (`npm run swagger`).

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

The dashboard is built from 20 modular ES module source files in `public/`,
bundled by esbuild into a single `bundle.js`. It uses no frontend framework —
just vanilla JavaScript, DOM manipulation, and CSS. Fonts are self-hosted
(no CDN dependencies). Client-side URL routing via Navigo provides
bookmarkable deep links to specific positions.

The dashboard never talks to the blockchain directly. Every piece of data it
displays comes from the bot via the HTTP API, and every action the user takes
(start/stop a position, trigger a rebalance, change settings) is a POST to
an API endpoint.

---

## The API Layer

The HTTP API is the contract between the two halves. It is documented in an
OpenAPI 3.0 spec (`docs/openapi.json`) and can be browsed interactively via
Swagger UI (`npm run swagger` on port 5556).

The API has roughly 20 endpoints organized into groups:

- **Status** — the dashboard polls `GET /api/status` every 3 seconds to get
  the full state of all managed positions, including pool prices, P&L
  snapshots, throttle state, and scan progress.
- **Config** — `POST /api/config` updates per-position settings (slippage,
  threshold, timeout, auto-compound) and global settings (gas strategy).
- **Wallet** — import, unlock, reveal, and clear the encrypted wallet.
- **Positions** — scan the wallet for LP positions, start/stop management,
  fetch quick details (Phase 1) or full lifetime P&L (Phase 2).
- **Actions** — force a rebalance or compound on demand.
- **System** — health check and graceful shutdown.

The server uses Node's built-in `http` module with a simple route table — no
Express or other framework. Responses are JSON. The API is local-only (bound
to `localhost` by default) and has no authentication layer — security relies on
network isolation.

---

## Data Flow

### Bot → Dashboard

Each managed position runs its own independent `startBotLoop()` instance.
Every poll cycle (default 60 seconds), the bot reads the pool's current state
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
for that position and responds with success. When the user changes slippage,
the dashboard sends `POST /api/config { slippagePct, positionKey }` and the
server updates the per-position config on disk.

### Persistence

The bot persists its state to three locations:

1. **`.bot-config.json`** — the single source of truth for which positions are
   managed and their per-position settings (threshold, slippage, HODL baseline,
   residuals, compound history). Written atomically via temp-file + rename.
2. **`tmp/` directory** — JSON file caches for expensive blockchain queries
   (event scan results, P&L epoch history, historical prices, LP position
   lists). Pure performance optimization — deleting these forces a rebuild
   from the blockchain on next startup.
3. **`.wallet.json`** — AES-256-GCM encrypted wallet key (PBKDF2-SHA512,
   600,000 iterations). Survives server restarts. Gitignored.

The dashboard persists its own state to browser `localStorage` — the position
store (up to 300 entries), last-viewed position, realized gains, and initial
deposit values.

---

## The Rebalance Pipeline

When the bot detects a position is out of range, the rebalance pipeline
executes as a single synchronous sequence under the rebalance lock:

1. **getPoolState** — read current tick, price, and decimals from the pool
   contract.
2. **ownerOf** — verify the wallet still owns the NFT.
3. **removeLiquidity** — drain the position via `decreaseLiquidity` +
   `collect` (atomic multicall). The old NFT is kept, not burned.
4. **computeDesiredAmounts** — use the Uniswap V3 SDK's exact sqrtPrice math
   to determine how much of each token the new position needs at the target
   tick range.
5. **swapIfNeeded** — convert the excess token into the deficient one. The
   primary path uses the 9mm DEX Aggregator (multi-hop routing across all
   PulseChain DEXes for lowest slippage), with the V3 SwapRouter as fallback.
6. **mintPosition** — mint a new NFT at the re-centered tick range with the
   swapped balances.

Every transaction in this pipeline is wrapped in a 4-phase recovery system
(`_waitOrSpeedUp`): wait for confirmation, speed-up with 1.5x gas, wait
again, then auto-cancel with a 0-value self-transfer if still stuck. This
ensures nonces are never permanently blocked.

---

## Multi-Position Concurrency

LP Ranger manages multiple positions simultaneously from a single wallet.
Each position runs its own poll loop independently, but all positions share
a single provider, signer, and — critically — a single rebalance lock.

The lock ensures only one position sends transactions at a time. Without it,
two positions trying to rebalance simultaneously would use the same nonce,
causing one transaction to fail or replace the other. The lock has no timeout;
it releases only after the transaction confirms on-chain.

Polling continues for all positions even while one holds the lock. A position
that needs to rebalance waits for the lock, executes its full pipeline, then
releases it for the next position.

---

## P&L Tracking

P&L is tracked per position across "epochs" — each epoch spans from one
rebalance to the next. When a rebalance occurs, the current epoch closes
(recording exit value, fees earned, gas spent) and a new epoch opens.

For positions with history, LP Ranger reconstructs past epochs by scanning
on-chain Transfer events up to five years back, identifying the rebalance
chain (consecutive NFT mints by the same wallet in the same pool), and
fetching historical token prices from GeckoTerminal's OHLCV API.

Epoch data is cached to disk (`tmp/pnl-epochs-cache.json`) keyed by pool
identity — not by tokenId — so P&L history survives rebalances (which mint
new NFTs) without migration.

### Lifetime P&L Components

Three data points feed the Lifetime panel's P&L calculation, each computed
during the startup scan and cached in the epoch cache
(`tmp/pnl-epochs-cache.json`, pool-keyed):

- **Lifetime deposited amounts** (`lifetimeHodlAmounts`) — the total tokens
  externally deposited into the pool across the entire rebalance chain.
  Computed by `src/lifetime-hodl.js` from IncreaseLiquidity events.  The first
  NFT's mint is the original deposit; subsequent IncreaseLiquidity events that
  exceed collected fees are classified as external deposits.  Rebalance mints
  (drain → swap → re-mint) contribute zero because the token ratio change is
  from the swap, not from new capital.  When the event scan cannot distinguish
  wallet-level deposits that were swept into a rebalance mint, the system falls
  back to the current HODL baseline (which always reflects the latest mint's
  actual token amounts).

- **Lifetime compounded amount** (`totalCompoundedUsd`) — the total USD value
  of fees that were re-deposited as liquidity via compound operations.
  Detected by scanning IncreaseLiquidity events after the mint on each NFT and
  filtering out rebalance-adjacent ones (`_filterRebalances`).  Amounts are
  capped per-token by total Collect amounts so compounds never exceed
  collected fees.

- **Lifetime gas** (`totalGas`) — the cumulative gas cost in USD across all
  rebalance and compound transactions.  Extracted from TX receipts during
  epoch reconstruction: the mint TX receipt (already fetched for entry value)
  and the close TX receipt (one additional RPC call per epoch).

### Lifetime Impermanent Loss / Gain

Lifetime IL/G answers: "compared to simply holding every token I deposited,
how has LPing performed?"  The formula:

```text
IL = LP_value − (hodlAmount0 × currentPrice0 + hodlAmount1 × currentPrice1)
```

Both the managed and unmanaged paths use the same `computeHodlIL` function
from `src/il-calculator.js`.  The HODL amounts come from
`lifetimeHodlAmounts` (accumulated external deposits) or the current HODL
baseline — whichever produces the larger HODL value, since the baseline
captures wallet-level deposits the event scan may miss.

### Scan Architecture: Single Fetch, Two Classifiers

To avoid duplicate RPC calls, the lifetime scan fetches IncreaseLiquidity,
DecreaseLiquidity, and Collect events **once per NFT** via `scanNftEvents`
(3 parallel `getLogs` calls per NFT).  The same pre-fetched events are then
passed to two classifiers:

1. **Compound classifier** (`classifyCompounds`) — identifies fee re-deposits.
2. **Lifetime HODL classifier** (`computeLifetimeHodl`) — accumulates external
   deposits.

Both classifiers share `_filterRebalances` to distinguish rebalance-adjacent
events from genuine deposits/compounds.  The scan is incremental:
`lastNftScanBlock` is cached so subsequent startups only query new blocks.

### Lifetime Sync vs Bot Loop

The lifetime P&L scan (event scan, epoch reconstruction, price fetching) is
**the same work** for managed and unmanaged positions. The bot loop exists
solely to monitor the position and act on it — rebalance when out of range,
auto-compound when the fee threshold is hit. The lifetime sync is not a
bot-loop concern. Dashboard readiness (the "Synced" badge and blur overlay)
tracks whether the lifetime scan has completed, not whether the bot loop is
running. This separation prevents the badge from coupling to bot startup
timing (e.g. stagger delays between positions) or falsely showing "Synced"
when an unmanaged detail fetch completes for a position whose managed scan
hasn't started yet.

---

## Security Model

- **Private keys** exist only in memory during signing. On disk, they are
  encrypted with AES-256-GCM (PBKDF2-SHA512 key derivation, 600,000
  iterations). The encrypted file is gitignored.
- **No remote access** by default. The server binds to `0.0.0.0` but is
  intended for local use. There is no authentication on the API.
- **Nonce safety** is enforced by the async mutex rebalance lock — only one
  transaction chain executes at a time.
- **Slippage protection** uses quote-based minimums (not spot price) and
  aborts when price impact exceeds the user's setting.
- **Automated security checks** run in CI: dependency CVE audit, ESLint
  security plugin, and secretlint for hardcoded credentials.

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
