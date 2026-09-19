# LP Ranger — Configuration Reference

This is the canonical reference for **how LP Ranger is configured**: every
environment variable, the layered defaults system, where each setting lives on
disk, and which settings are deliberately not editable.

**Configure LP Ranger through the JSON files under `app-config/`**, or through
the dashboard's Bot Settings panel, which writes to them for you.
[JSON Configuration Values](#json-configuration-values) is where to start.
`.env` is for headless or unattended operation, and for experiments.

Configuration reaches the app through three layers — shipped JSON defaults,
per-install operator overrides, and `.env`, in that order of increasing
precedence. [Configuration Precedence](#configuration-precedence) is the rule
that decides which wins, and most surprises come from not knowing it: `.env`
sits on top, so a line left there overrides anything set later in the
dashboard.

For the runtime mechanisms these settings govern, see
[`docs/engineering.md`](engineering.md). For the commands that read this
configuration, see
[`docs/npm-project-commands.md`](npm-project-commands.md). For how the bot and dashboard
cooperate at a higher level, see [`docs/architecture.md`](architecture.md).
For the controls protecting the wallet, see [`docs/security.md`](security.md).

---

## Table of Contents

- [JSON Configuration Values](#json-configuration-values)
  - [Where each setting lives](#where-each-setting-lives)
  - [How to change one](#how-to-change-one)
- [Environment Variables](#environment-variables)
  - [Overview](#overview)
  - [Configuration Precedence](#configuration-precedence)
  - [Server (`.env`)](#server-env)
  - [Request Security](#request-security)
  - [Chain Selection (`.env`)](#chain-selection-env)
  - [Wallet (`.env`, Required for Bot)](#wallet-env-required-for-bot)
  - [Position Discovery (`.env`)](#position-discovery-env)
  - [Bot Behaviour (`.env`)](#bot-behaviour-env)
    - [RPC endpoints](#rpc-endpoints)
  - [Contract Addresses](#contract-addresses)
    - [Why contract addresses are not editable](#why-contract-addresses-are-not-editable)
  - [File Paths and Diagnostics](#file-paths-and-diagnostics)
  - [Where Other Configuration Lives](#where-other-configuration-lives)
- [RPC Request Pacing and Log Chunking](#rpc-request-pacing-and-log-chunking)
  - [Why chunking exists](#why-chunking-exists)
  - [Why pacing is global](#why-pacing-is-global)
  - [Cost](#cost)

---

## JSON Configuration Values

**The JSON files under `app-config/` are where LP Ranger is configured.**
That is the normal path, and for a dashboard install it is the only one you
need. Almost every setting has a home there, and most of them also have a
control in the dashboard's Bot Settings panel, which writes to those files
for you.

`.env` exists for two narrower purposes:

- **Headless and unattended operation.** Running `npm run bot` on a
  Raspberry Pi there is no Bot Settings panel to press Save in, so the same
  tunables are settable as environment variables. The wallet credentials
  belong to this case as well: `PRIVATE_KEY` and `WALLET_PASSWORD` are how
  an install unlocks itself with no browser present. A dashboard install
  imports its wallet through the UI instead, and it is held encrypted in
  `wallet.json`.
- **Experiments.** A one-off override to try without editing a file and
  without it persisting.

Outside those two cases, prefer the JSON files. A value set in `.env`
outranks the JSON layers (see
[Configuration Precedence](#configuration-precedence)), so a stale line in
`.env` silently overrides whatever you later set in the dashboard — the
panel accepts the change, writes it to disk, and the bot goes on using the
environment value.

### Where each setting lives

| What | File | Edited by |
| --- | --- | --- |
| Server and process settings — listen port and host, default chain, TX recovery timing, scan timeout | `app-config/app-defaults-for-user-configurable/app-runtime.json` | you, by hand |
| Per-chain static tunables — RPC endpoints, contract addresses, gas multipliers, aggregator timeouts | `app-config/app-defaults-for-user-configurable/chains.json` | you, by hand |
| Shipped defaults for bot behaviour — thresholds, intervals, caps, chunk size, pacing | `app-config/app-defaults-for-user-configurable/bot-config-defaults.json` | you, by hand |
| Managed positions and per-position settings — HODL baselines, thresholds, slippage, auto-compound | `app-config/user-configurable/bot-config.json` | the dashboard and the bot; not hand-edited |
| Encrypted wallet | `app-config/user-configurable/wallet.json` | the dashboard import flow |
| Encrypted third-party API keys (Moralis, Telegram) | `app-config/user-configurable/api-keys.json` | the dashboard Settings dialog |

Seven more shipped-default files cover narrower concerns — CSRF token TTL,
the dust threshold, RPC error-classifier strings, logging, LP-provider
metadata, dashboard first-visit defaults and setting labels. The
engineering reference linked below inventories them all.

### How to change one

To override a shipped default without losing it on the next release, copy
the key into the matching file under `app-config/user-configurable/` and
edit it there. `loadMergedDefaults()` deep-merges your file over the shipped
one, and the `user-configurable/` directory is gitignored and survives a
tarball upgrade. Editing the shipped file directly works too, but the next
release overwrites it.

Settings with a dashboard control need no file editing at all — change them
in Bot Settings and press Save.

See [The `app-config` Directory](engineering.md#the-app-config-directory) in
the engineering reference for the full file inventory and the rules for
where future config files should go.

---

## Environment Variables

### Overview

**Use `.env` only for headless or unattended operation, and for
experiments.** Anything with a JSON home or a dashboard control belongs
there instead — see
[JSON Configuration Values](#json-configuration-values) above. That
includes `PORT` and `HOST`, whose defaults live in
`app-config/app-defaults-for-user-configurable/app-runtime.json`.

`PRIVATE_KEY` and `WALLET_PASSWORD` have no JSON home by design, but they
are not an exception to the rule — they *are* the headless case. A
dashboard install imports its wallet through the UI and unlocks it in the
browser, and never needs either one.

The reason to be careful is precedence: `.env` is the **top** layer, so a
value set here beats both the shipped default and your own
`user-configurable/` override, and it beats anything the dashboard writes
later. A forgotten line in `.env` produces a Bot Settings panel that accepts
your change, saves it, and has no effect.

With that said, the rest of this section is the complete list of what `.env`
accepts — every variable on its own row, with the JSON key it overrides
recorded on that row. Copy [`.env.example`](../.env.example) to `.env` and set
only what you need.

A row reading **none** in the JSON counterpart column means there is no JSON
key for that variable, and the reason is on the row. Most variables are read
by [`src/config.js`](../src/config.js) at startup; the overrides under
[File Paths and Diagnostics](#file-paths-and-diagnostics) are read by the
module that owns each file instead, and three of those rows record that
nothing in the running app reads the variable at all.

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
Save in when running `npm run bot` on a Raspberry Pi. The **JSON
counterpart** column in the tables that follow names the key each variable
overrides.

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

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `PORT` | `5555` | `app-runtime.json` → `server.port` | HTTP port the dashboard is served on. The CORS origin guard is locked to `localhost:<PORT>`, so changing this updates the allowed origin with it. |
| `HOST` | `127.0.0.1` | `app-runtime.json` → `server.host` | Bind address. Localhost only by default; `0.0.0.0` exposes the dashboard to the local network. |

### Request Security

Mutating API endpoints (POST, DELETE) are protected by three layers —
network binding, CORS origin guard, and CSRF tokens. GET requests
require none of them. Full details and the lint/test enforcement behind
each layer live in [`docs/security.md`](security.md).

### Chain Selection (`.env`)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `CHAIN_NAME` | `pulsechain` | `app-runtime.json` → `defaults.chain` | Selects which entry the bot loads out of `chains.json`. `pulsechain-testnet` is PulseChain Testnet v4. The per-chain RPC endpoints, contract addresses and gas multipliers live in that file, not here. Leaving this out of `.env` is the normal case, and `defaults.chain` then applies — as it does for a line left blank, which is no override either. A name matching no entry in `chains.json` stops the app at startup with an error naming the chains that are configured. It does not fall back to another chain, because the entry carries the contracts and endpoints every transaction is built against. |

### Wallet (`.env`, Required for Bot)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `PRIVATE_KEY` | *(unset)* | **none, by design** | This setting is for Headless Operation only (running the bot only, and not the web app). Hex signing key, `0x`-prefixed, in plaintext. A dashboard install imports its wallet through the UI and unlocks it in the browser instead. |
| `WALLET_PASSWORD` | *(unset)* | **none, by design** | This setting is for Headless Operation only (running the bot only, and not the web app). It decrypts the wallet and the stored API keys at startup without prompting, which is what lets an unattended bot sign. The trade-off is a plaintext password in `.env` — see [Wallet password persistence](claude/CLAUDE-SECURITY.md#wallet-password-persistence). Read by [`src/bot-private-key.js`](../src/bot-private-key.js) and [`src/server-routes.js`](../src/server-routes.js), not by `config.js`. A dashboard install is asked for the password in the browser instead, and `node server.js --headless` asks in the terminal. |

### Position Discovery (`.env`)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `POSITION_ID` | *(unset)* | **none** — a run mode, not a setting | A single NFT token ID for `npm run bot` to start when `bot-config.json` lists no managed positions. Blank scans the wallet. `server.js` ignores it and starts whatever the config marks `running`. An ID that is not among the wallet's valid positions does not fail — detection falls back to the first position it found. |

### Bot Behaviour (`.env`)

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `RPC_URL` | `https://rpc-pulsechain.g4mm4.io` | `chains.json` → `<chain>.rpc.urls[0]` | First JSON-RPC endpoint. |
| `RPC_URL_FALLBACK` | `https://rpc.pulsechain.com` | `chains.json` → `<chain>.rpc.urls[1]` | Second endpoint. |
| `RPC_URL_FALLBACK_2` | `https://rpc.pulsechain.box` | `chains.json` → `<chain>.rpc.urls[2]` | Third endpoint. Free tier, 50 requests per 10 seconds per IP. |
| `REBALANCE_OOR_THRESHOLD_PCT` | `5` | `bot-config-defaults.json` → `rebalanceOutOfRangeThresholdPercent` | How far past the position's price boundary the price must move before the distance condition fires, as a percentage of the position's own range width. `0` fires the moment the position leaves range. |
| `REBALANCE_TIMEOUT_MIN` | `180` | `bot-config-defaults.json` → `rebalanceTimeoutMin` | Minutes continuously out of range before a rebalance fires whatever the distance. `0` disables it. |
| `IMPERMANENT_LOSS_GUARD_PCT` | `50` | `bot-config-defaults.json` → `impermanentLossGuardPct` | How far below its own mint value a position may fall before the bot stops rebalancing it. Accepted range 1–100. |
| `SLIPPAGE_PCT` | `0.75` | `bot-config-defaults.json` → `slippagePct` | Most slippage a swap may take, measured against the quoted output rather than the spot price. |
| `CHECK_INTERVAL_SEC` | `300` | `bot-config-defaults.json` → `checkIntervalSec` | Seconds between on-chain poll cycles. |
| `MIN_REBALANCE_INTERVAL_MIN` | `10` | `bot-config-defaults.json` → `minRebalanceIntervalMin` | Shortest wait between two rebalances of one position. |
| `MAX_REBALANCES_PER_DAY` | `5` | `bot-config-defaults.json` → `maxRebalancesPerDay` | Daily cap, counted per pool rather than per wallet. |
| `REBALANCE_RETRY_SWAP_LIMIT` | `8` | `app-runtime.json` → `tx.retrySwapLimit` | Consecutive swap-backoff retries before the bot pauses rebalancing and waits for the operator. |
| `TX_SPEEDUP_SEC` | `120` | `app-runtime.json` → `tx.speedupSec` | Seconds a transaction may stay pending before a same-nonce replacement goes out at 1.5× gas. |
| `DEADLINE_SEC` | `900` | `app-runtime.json` → `tx.deadlineSec` | On-chain deadline stamped into removeLiquidity, swap and mint calldata. |
| `TX_CANCEL_SEC` | `3600` | **derived** — `app-runtime.json` → `tx.deadlineSec` × `tx.cancelToDeadlineMultiple` | Seconds before a stuck transaction is cancelled by a zero-value self-transfer at its nonce. Setting it here fixes it to one number and it stops tracking the deadline; raise `cancelToDeadlineMultiple` instead. |
| `AGGREGATOR_URL` | `https://api.9mm.pro` | `app-runtime.json` → `aggregator.url` | 9mm DEX Aggregator endpoint. |
| `AGGREGATOR_API_KEY` | `f9275849-2a1d-406b-b2a2-a6be1ac127dc` | `app-runtime.json` → `aggregator.apiKey` | `0x-api-key` header sent with aggregator quotes. Public and embedded in 9mm's own product, not an operator credential, which is why it ships in a tracked file rather than the encrypted key store. |
| `LOG_FILE` | `./app-data/rebalance_log.json` | `app-runtime.json` → `log.file` | Path to the JSON rebalance log, relative to the project root. |
| `DRY_RUN` | `false` | **none** — a run mode, not a setting | Connects, detects and polls, but sends no transactions. Accepts `1`, `true` or `yes`. |
| `VERBOSE` | `false` | **none** — a run mode, not a setting | Verbose logging. Accepts `1`; `--verbose` and `-v` on the command line do the same thing. |

#### RPC endpoints

The shipped list lives in `chains.json` under `rpc.urls`; the three variables
override it positionally, so setting only `RPC_URL` leaves the endpoints behind
it intact. See
[RPC Request Pacing and Log Chunking](#rpc-request-pacing-and-log-chunking).

There is a fourth source, and it outranks all of these: **Bot Settings →
Network** in the dashboard. The **RPC URL** dropdown lists every endpoint in
the order the bot tries them, each marked `PRIMARY` or `FAILOVER`. The selected
option *is* the primary — picking a different one promotes it to the front of
the failover order immediately. **Add RPC** opens a dialog with Save and Close
buttons for entering a new endpoint, so one is only ever added deliberately.

What you add becomes the new primary, and everything already listed stays
behind it as automatic failover — so pointing LP Ranger at your own node does
not cost you redundancy. Add a second, and it becomes the primary in turn,
pushing the first down one place. Added endpoints are stored in
`bot-config.json` under `rpcUrls`, newest first. Duplicates are dropped keeping
the earliest position, which is what makes promotion work: selecting an
endpoint prepends it, and the duplicate further down is discarded. That holds
for shipped endpoints too, so selecting one of those records it under `rpcUrls`
as your preference.

Unlike the layers above, an addition is applied to the running process the
moment you save it; no restart. The endpoint is not contacted before being
added — an endpoint can be down at the moment you add it and fine a minute
later, and the failover list already handles one that never answers.

### Contract Addresses

**These are not editable from the dashboard, by design.** The Bot
Settings panel once offered Position Manager and Factory fields; they
have been removed. See [why](#why-contract-addresses-are-not-editable)
below.

The shipped addresses live in
`app-config/app-defaults-for-user-configurable/chains.json`, per chain:

```json
"contracts": {
  "positionManager": {
    "address": "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
    "mintGasLimit": 600000
  },
  "factory": "0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68",
  "swapRouter": "0x7bE8fbe502191bBBCb38b02f2d4fA0D628301bEA"
}
```

Canonical deployment addresses:
<https://github.com/9mm-exchange/deployments/blob/main/pulsechain/v3.json>

Override them in `app-config/user-configurable/chains.json`, the same way
as any other shipped default. `.env` accepts all three on the usual terms —
headless installs and experiments, outranking both JSON layers.

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `POSITION_MANAGER` | `0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2` | `chains.json` → `<chain>.contracts.positionManager.address` | NonfungiblePositionManager, the contract that holds every V3 position NFT. |
| `FACTORY` | `0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68` | `chains.json` → `<chain>.contracts.factory` | V3 Factory, used to resolve a pool address from its two tokens and fee tier. |
| `SWAP_ROUTER` | `0x7bE8fbe502191bBBCb38b02f2d4fA0D628301bEA` | `chains.json` → `<chain>.contracts.swapRouter` | V3 SwapRouter, the fallback swap path when an aggregator quote cannot be used. |

In normal operation you should never set them. The only reason to is to
point the bot at a different deployment of the 9mm Pro V3 contracts, and
that needs a fresh install rather than an edit — see below.

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

### File Paths and Diagnostics

These are not operator settings. Each one redirects a single file that a
module owns, or feeds a development script. **Leave every one of them unset
in a normal install** — the defaults are the layout the rest of the app,
`npm run clean` and the upgrade scripts all expect.

The seven path overrides exist for one purpose: so that a test run can never
write over a production file, whatever directory it is invoked from. Each is
read by the module named on its row, not by `config.js`. None has a JSON
counterpart, and none should — a key in a shipped defaults file would present
these as a supported way to lay out an install, which they are not.

| Variable | Default | JSON counterpart | Notes |
| --- | --- | --- | --- |
| `WALLET_FILE_PATH` | `app-config/user-configurable/wallet.json` | **none** | Encrypted wallet file, read and written by [`src/wallet-manager.js`](../src/wallet-manager.js). |
| `API_KEYS_FILE_PATH` | `app-config/user-configurable/api-keys.json` | **none** | Encrypted third-party API keys, read and written by [`src/api-key-store.js`](../src/api-key-store.js). |
| `PRICE_CACHE_PATH` | `tmp/historical-price-cache.json` | **none** | Historical USD price cache ([`src/price-cache.js`](../src/price-cache.js)). |
| `BLOCK_TIME_CACHE_PATH` | `tmp/block-time-cache.json` | **none** | Block-number-to-timestamp cache ([`src/block-time-cache.js`](../src/block-time-cache.js)). |
| `GECKO_POOL_CACHE_PATH` | `tmp/gecko-pool-cache.json` | **none** | Which way round GeckoTerminal quotes each pool ([`src/gecko-pool-cache.js`](../src/gecko-pool-cache.js)). |
| `LIQUIDITY_PAIR_DETAILS_CACHE_PATH` | `tmp/liquidity-pair-details-cache.json` | **none** | Initial-residual snapshot per pool scope ([`src/liquidity-pair-details.js`](../src/liquidity-pair-details.js)). |
| `POOL_CREATION_BLOCK_CACHE_PATH` | `tmp/pool-creation-blocks-cache.json` | **none** | Resolved pool deployment blocks ([`src/pool-creation-block.js`](../src/pool-creation-block.js)). |
| `LP_RANGER_PID` | *(unset)* | **none** | The process for `npm run debug-attach` to signal, for when the port and `pgrep` lookups find the wrong one. Read by [`scripts/_debug-attach.js`](../scripts/_debug-attach.js); the server and bot never read it. |
| `INSPECTOR_PORT` | `9229` | **none** | Port `npm run debug-attach` reports the V8 inspector on. Read by [`scripts/_debug-attach.js`](../scripts/_debug-attach.js); the server and bot never read it. |
| `MORALIS_API_KEY` | *(unset)* | **none** | Read only by `util/diagnostic/verify-compound-usd`. The key LP Ranger itself uses for price lookups is the one entered in Settings and stored encrypted in `api-keys.json`; setting this variable does not change it and does not enable Moralis. |

### Where Other Configuration Lives

Everything not listed in this section — per-chain tunables, contract
addresses, bot-behaviour defaults, managed positions, the encrypted wallet
and the encrypted API keys — lives in the JSON files under `app-config/`.
See [Where each setting lives](#where-each-setting-lives) for the file-by-file
table, and
[The `app-config` Directory](engineering.md#the-app-config-directory) in the
engineering reference for the full inventory.

---

## RPC Request Pacing and Log Chunking

Two settings govern how LP Ranger talks to an RPC endpoint. Both live in
`app-config/app-defaults-for-user-configurable/bot-config-defaults.json`, both
are deliberately **absent from the dashboard**, and they only make sense as a
pair: the chunk size decides how many requests a scan produces, the interval
decides how fast they leave.

| Setting | Default | What it governs |
| ------- | ------- | --------------- |
| `getLogsChunkSize` | `9000` | Maximum block span per `eth_getLogs` call |
| `globalRPCRequestRateIntervalMS` | `222` | Minimum gap between *any* two requests |

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
it a range and a query function; it walks the range in capped windows.

The default of 9,000 is 90% of the published 10,000-block limit, verified
accepted on all three configured endpoints. `g4mm4` enforces 10,000 exactly —
12,000 is rejected — while `rpc.pulsechain.com` and `rpc.pulsechain.box` accept
wider, so 10,000 is the binding figure. The remaining 1,000 blocks of headroom
cover an endpoint that enforces slightly under its published limit.
`src/bot-config-defaults.js` clamps the setting at 10,000 regardless.

**Failures propagate.** A chunk that fails fails the scan, unless a call site
explicitly opts into `bestEffort`. Swallowing a query error and returning an
empty array would report "this wallet has no deposits" when the truth is "we
could not read", and callers act on those two answers in opposite directions —
an empty scan result is taken as settled fact, not as a gap to retry. When an
endpoint rejects a range, the error names the span, the cap and this setting,
because ethers reports a JSON-RPC `-32602` as a generic `UNKNOWN_ERROR` with
the real code nested, which is not actionable as raised.

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

That figure is the worst case, and in practice almost nothing scans that
wide. What actually determines a cold start is **where each scan starts**,
and every scan in the app starts from a bound it already knows:

| Scan | Starts at |
| --- | --- |
| Pool rebalance events | the later of the five-year floor, the pool's creation block, and the last cached block |
| Per-NFT event history | that NFT's own mint block, and runs to the current block |
| Pool creation lookup | the newest block, working backwards, stopping at the first match |

The per-NFT floor is the one that moves the needle on a long rebalance
chain. Every scan runs to the current block, including a retired NFT's:
a dust mint left by a failed rebalance looks exactly like a real one in
the Transfer log, so the app never assumes an NFT has stopped emitting —
one that appears replaced can still hold coins and release them later.
The saving comes from the floor. On a 132-rebalance position in a pool
two years older than the first deposit, that is up to 168 chunked queries
per NFT instead of 954. See
[Per-NFT Scan Windows](engineering.md#per-nft-scan-windows).

Two consequences worth knowing:

- **The bot's polling shares the queue with any running scan.** A long
  scan slows ordinary poll cycles and vice versa — they interleave, each
  at roughly half rate, rather than one blocking the other.
- **An interrupted scan starts over.** The pool rebalance-event scan
  saves its progress only when it completes. The per-NFT event history
  is read afresh after a restart. Interrupting a long first scan means
  the next start repeats it. Let the first one finish.
