# LP Ranger — Configuration Reference

This is the canonical reference for **how LP Ranger is configured**: every
environment variable, the layered defaults system, where each setting lives on
disk, and which settings are deliberately not editable.

Configuration reaches the app through three layers — shipped JSON defaults,
per-install operator overrides, and `.env` — and the
[Configuration Precedence](#configuration-precedence) section below is the rule
that decides which wins. Read that first; most surprises come from not knowing
it.

For the runtime mechanisms these settings govern, see
[`docs/engineering.md`](engineering.md). For how the bot and dashboard
cooperate at a higher level, see [`docs/architecture.md`](architecture.md).

---

## Table of Contents

- [Environment Variables](#environment-variables)
  - [Configuration Precedence](#configuration-precedence)
  - [Server (`.env`)](#server-env)
  - [Request Security](#request-security)
  - [Chain Selection (`.env`)](#chain-selection-env)
  - [Wallet (`.env`, Required for Bot)](#wallet-env-required-for-bot)
  - [Position Discovery (`.env`)](#position-discovery-env)
  - [Bot Behaviour (`.env`)](#bot-behaviour-env)
  - [Contract Addresses](#contract-addresses)
  - [Where Other Configuration Lives](#where-other-configuration-lives)
- [RPC Request Pacing and Log Chunking](#rpc-request-pacing-and-log-chunking)
  - [Why chunking exists](#why-chunking-exists)
  - [Why pacing is global](#why-pacing-is-global)
  - [Cost](#cost)

---

## Environment Variables

**All settings in this section live in `.env`** at the project root. Copy
[`.env.example`](../.env.example) to `.env` and edit the values you need.
Every variable below is read by [`src/config.js`](../src/config.js) at
startup. Nothing in this section belongs in
`app-config/app-defaults-for-user-configurable/chains.json`, `app-config/user-configurable/bot-config.json`, or
`app-config/user-configurable/api-keys.json` — for those files, see the
[The `app-config` Directory](engineering.md#the-app-config-directory) section
of the engineering reference.

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
each layer live in the [Security](engineering.md#security) section of the
engineering reference.

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

There is a fourth source, and it outranks all of these: the **RPC URL** field
in the dashboard's Bot Settings. It is saved to `bot-config.json` and goes
first in the list, with the endpoints above kept behind it as automatic
failover — so pointing LP Ranger at your own node does not cost you
redundancy. Unlike the layers above, it is applied to the running process the
moment you save it; no restart.

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

See the [The `app-config` Directory](engineering.md#the-app-config-directory) section
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
