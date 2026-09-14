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
[`docs/engineering.md`](engineering.md). For how the bot and dashboard
cooperate at a higher level, see [`docs/architecture.md`](architecture.md).

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
  - [Contract Addresses](#contract-addresses)
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
accepts. Copy [`.env.example`](../.env.example) to `.env` and set only what
you need. Every variable below is read by
[`src/config.js`](../src/config.js) at startup.

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
as any other shipped default. `.env` accepts `POSITION_MANAGER`, `FACTORY`
and `SWAP_ROUTER` on the usual terms — headless installs and experiments,
outranking both JSON layers.

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
wide. What actually determines a cold start is **how tightly each scan is
bounded**, and every scan in the app is bounded by something it already
knows:

| Scan | Bounded by |
| --- | --- |
| Pool rebalance events | five-year floor, pool creation block, last cached block |
| Per-NFT event history | that NFT's own mint block → the block it was replaced |
| Pool creation lookup | scans newest-first, stops at the first match |

The per-NFT bound is the one that moves the needle on a long rebalance
chain: a retired NFT covers only the hours it was alive, not every block
since. On a 132-rebalance position that is the difference between hours
and minutes. See
[Per-NFT Scan Windows](engineering.md#per-nft-scan-windows).

Two consequences worth knowing:

- **The bot's polling shares the queue with any running scan.** A long
  scan slows ordinary poll cycles and vice versa — they interleave, each
  at roughly half rate, rather than one blocking the other.
- **A scan only records its resume checkpoint when it completes.**
  Interrupting a long first scan means the next start repeats it from
  the same place. Let the first one finish.
