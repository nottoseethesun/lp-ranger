---
name: project_9mm_api_sunset
description: "9mm's old api hosts, api.9mm.pro among them, stop answering Monday 2026-10-19. data.9mm.pro replaces their data routes but offers NO swap quotes. Production falls back to the V3 router. The Dex Detail Page link already lands on app.9mm.pro's home page"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-18T03:15:27.307Z
---

# 9mm api sunset

Verified 2026-10-16 against the data.9mm.pro docs page, curl, and the
9mm-exchange/deployments repo.

- **The deadline.** graph, graph-api, graph-dev, info-api, subgraph,
  rest, wallet-api, price-api, api, tokens and token-registry (each
  `.9mm.pro`) stop answering on Monday 2026-10-19. LP Ranger's only
  runtime call to any of them is the aggregator swap quote,
  `GET api.9mm.pro/pulsechain/swap/v1/quote`. No test calls it live.
- **The replacement has no quotes.** data.9mm.pro
  (`/v1/chains/369/…`, GET only, no key, 20 requests a second per
  address) serves tokens, pools, prices, events and wallet positions.
  Swap quotes are "not offered". The page says to quote on chain
  instead: QuoterV2 `0x500260dD7C27eCE20b89ea0808d05a13CF867279` and
  MixedRouteQuoterV1 `0xBa53762F281A293B6bE73C9D2d3b740C433635cA` (both
  also listed in deployments `pulsechain/v3.json`), the V2 router
  `0xcc73b59f8d7b7c532703bdfea2808a28a488cf47`, and the universal router
  `0x6541b436b0604244e04025a959dd93973e83f60d` for executing.
- **The new app has an unsupported quote service.** 9mm's own app gets
  its routes from `GET https://app.9mm.pro/v1/chains/369/quote?in=&out=&amount=`
  (optional `pool=` forces one pool; `protocol=` is silently ignored).
  It needs no key and sends no CORS header. It answers
  `{data: {amountIn, amountOut, priceImpact (a fraction), route:
  [{protocol, pool, fee, tokenIn, tokenOut}], candidates, quoted}}`.
  That is a route through 9MM's own V2 and V3 pools only — not
  calldata, and not PulseX. The same path on data.9mm.pro answers 404
  `not_offered`, "Quotes are not part of the public API". 9mm's app
  re-prices the route on chain (`quoteExactInput` on QuoterV2 or
  MixedRouteQuoterV1), then executes it through the universal router
  with Permit2 `0x97d143ef1223e90ce50b5910ea5aacabfe4e1152`, using
  commands V3_SWAP_EXACT_IN (0), V2_SWAP_EXACT_IN (8) and
  PERMIT2_PERMIT (10).
- **The aggregator moved; it did not shut down (user, 2026-10-16).** It
  went to Watergun in the early-October split and is now "Watergun
  Swap" (swap.watergun.pro). The live swap app's config names its
  PulseChain backend `https://api-dev.9mm.pro/pulsechain`, which is not
  on 9mm's shutdown list. Asked the same quote, it answered exactly
  like api.9mm.pro: same price, same exchange proxy
  `0xd5b775d1f15a864a5f6b94624e049cf758d013f7`, and calldata identical
  but for its last nine bytes, which hold the quote's own id and unix
  timestamp and differ on every fresh quote.
  LP Ranger's aggregator code therefore works with it unchanged.
  Watergun's own proxy (`swap.watergun.pro/api/aggregator/369/swap/v1/quote`)
  routed the same request differently. Watergun's docs
  (`/developers/integrations`) still give `https://api.9mm.pro` as the
  PulseChain address, which looks stale given 9mm's shutdown. They also
  list a flat 0.05% routing fee; whether direct api callers pay it was
  not established.
- **Far-future note (user, 2026-10-16):** the non-PulseChain aggregator
  now lives at `https://dex.watergun.pro/`.
- **The user's direction, 2026-10-16:** the aggregator stays the primary
  route. That withdrew every earlier alternative: router-only, LP
  Ranger finding its own routes, another aggregator, and the
  app.9mm.pro quote service with the universal router.
- **The contracts did not change.** The factory, position manager and
  SwapRouter in `chains.json` match deployments `pulsechain/v3.json`.
- **Production keeps swapping on 2026-10-19 without a release.** 0.9.7,
  0.9.8 (on Prod) and 0.9.9 all fall back from a failed aggregator quote
  to the V3 router, swapping in the position's own pool. Two costs
  remain until the branch ships. The quote's `fetch` has no timeout, so
  a host that hangs rather than refuses delays every swap before the
  fallback, with the coins out of the pool meanwhile. And the Mission
  Control "Routing through: 9mm Aggregator" badge, the Swap Routing
  dialog and the disclosure keep naming a route no swap takes.
- **Open bug, live now.** Pool Details → Dex Detail Page is built from
  `lp-providers.json` as `https://dex.9mm.pro/info/v3/pulsechain/pairs/{poolId}`.
  That 302s to `https://app.9mm.pro/` and drops the path, so the link
  lands on the home page. The new app's pool page is `/pools/:address`,
  read from its route table.
- **Other links.** `9mm.pro` and every `dex.9mm.pro` path also 302 to
  the app's home page. `scan.9mm.pro` is dead (Cloudflare 526), yet
  `.env.example` still tells operators to verify addresses there.

- **Every redirecting link goes direct (user, 2026-10-16), so it is in
  the branch's scope.** The sweep that day found these: the Dex Detail
  Page template and its two JSDoc examples (→ `app.9mm.pro/pools/{pool}`);
  `9mm.pro` in the header logo, the User Manual and the README
  (→ `https://app.9mm.pro/`); the README's `dex.9mm.pro/liquidity`
  (→ `app.9mm.pro/add`); the README's badge links and issues link,
  still on the old repo name `9mm-lp-position-manager` (→ `lp-ranger`);
  `moralis.io` in engineering.md (two hops → `https://moralis.com/`);
  the whitepaper link in `src/range-math.js`
  (→ `app.uniswap.org/whitepaper-v3.pdf`); and `snowpack.dev` in a
  `.gitignore` comment (→ `www.snowpack.dev`). Proposed to leave: the
  SVG namespace name, the Apache license's own text, and `knip.json`'s
  `knip@5` schema range.
- **Untraced, separate from the migration.** The same announcement
  starts weekly WPLS payouts, from 2026-10-16, to every wallet holding
  at least 1,000 9MM. Per [[project_fresh_deposit_detection]] the
  deposit scan skips only transfers from the position manager or the
  pool, so if a bot wallet qualifies, those payouts could count as
  deposits on its WPLS-paired positions. Not checked against the code.

**Why:** the deadline is external and invisible in the code, and it
changes which route every swap takes whether or not anything ships.

**State at 18:30 UTC 2026-10-16 (uncommitted on the branch, `npm run
check` green):** the aggregator url is per chain (`chains.json` →
`aggregator.url`; PulseChain = `https://swap.watergun.pro/api/aggregator/369`,
the user's choice over `api-dev.9mm.pro`; the testnet has none). 9mm's
api key is gone. The route is renamed "Watergun Aggregator", and
`/api/status` carries `swapRouteLabel`. Watergun is in the No Affiliation
list and the disclosure is dated 2026-10-16. The redirecting links go
direct. Testnet plumbing: `parseCompositeKey` reads from the right, there
is a `GET /api/chain` route plus `public/dashboard-chain.js`, the
dashboard's `compositeKey` callers take the chain from it (six other
key builders still hard-coded `pulsechain` until the evening; see
below), and the contract addresses no longer fall back to mainnet's. Still open: 9mm's testnet addresses were
NOT FOUND anywhere public and the user was asked; a funded testnet
wallet; two Conflicts of Interest sentences for the user to rule on.

**Later the same day:** testnet work deferred (see
[[project_pulsechain_testnet_exploration]]). Swap and aggregator test
coverage was raised to 100% lines on every swap and aggregator file
except `swap-gates.js` (99%) and `rebalancer-pools.js` (99%), with four
new test files. Branch coverage is still low on `rebalancer-router.js`
(61%) and `rebalancer-correct.js` (60%); the user's 95% target was
taken as lines. The user then asked for branches at 95% too, and for
the region to be documented. Done the same day: every one of the 11
swap and aggregator files is at ≥95% lines AND branches. The "95%
Coverage Regions" section in `docs/claude/CLAUDE-TESTING.md` lists the
files, the lcov recipe for finding missed branches, and why each
remaining branch is uncovered. The shared aggregator stage is in
`test/helpers/aggregator-harness.js`. The 95% is documented, not gated
in `npm run check`. The disclosure now has FOUR sentences awaiting the user:
$9MM, $9INCH, $PLSX and the Venue intro. Watergun's aggregator routes
through 14 sources, PulseX and 9inch among them. The user deferred them
until after the code work.

**Audit, evening of 2026-10-16 (user-requested: rules, state, sequence,
two steps out).** Corrected on the branch:

- The dashboard no longer guesses "pulsechain" when `GET /api/chain`
  fails. It holds no chain until the server answers and asks again every
  three seconds. Tests learn the chain through `test/helpers/active-chain.js`.
- The badge's route label and the swap share one test of "is there an
  aggregator", `aggregatorBaseUrl()`.
- The reload's epoch-cache clear is back to the committed key. Every
  writer of that cache leaves the chain to its default, so a
  `config.CHAIN_NAME` key would have missed the entry on any other chain.
- The aggregator test harness serves quotes from a local http server
  instead of swapping the global `fetch`.
- `npm run check` now writes `test/report-artifacts/raw-data/lcov.info`,
  so missed branches never need a separate test run.
- "formerly the 9mm DEX Aggregator" was removed from code comments and
  technical docs; it stays in the help dialog and disclosure pending the
  user. The help dialog's sentence about testnet swaps was removed,
  since no 9mm contracts exist there.

Two of the audit's slips touched operator files and were cleaned up. A
whole-suite `node --test` under `wipe-settings` alone left four
pid-named test caches in `tmp/` (deleted) and, probably, three fixture
symbols in `tmp/token-symbol-cache.json` (removed; a copy is in that
session's scratchpad). Never run the whole suite outside `npm run check`.

**Second round, late evening 2026-10-16 (user-requested).**

- `npm run check` deletes `logs/error.log` and its last copy first, and
  renames what the tests wrote to `logs/error-npm-run-check.log`
  ([[project_tests_write_operator_error_log]]).
- The dashboard's chain query gives each request `chainQueryTimeoutMs`
  (3000, now `ui-defaults_non-layout_for-server-down-scenario.json`, bundled at build time since it is needed
  before the server answers). Every request that ends without a chain
  is logged to the browser console with what happened. The user chose
  the console over `logs/lp-ranger.log`, which only the server writes.
- The route names are static config: `chains.json` → `aggregator.name`
  and `contracts.swapRouter` (now `{address, name}`). `src/config.js`
  refuses to start without them, or without an `aggregator.url` string.
  `public/dashboard-routing-labels.js` and the badge's `index.html` text
  are gone; the badge is empty until the first poll (user approved).
  The user's rule behind it: [[feedback_one_literal_per_shipped_default]].
- Reload Current Position is chain-agnostic. The epoch cache takes the
  active chain itself, so writers and Reload's clear agree on any chain;
  PulseChain keys are byte-identical, so nothing went stale. Reload's
  dashboard key, Unmanage, Remove, the rebalance-events cache key, the
  edited-field keys, the deposit storage keys and `compositeKey` (whose
  `pulsechain` default is gone) all use `activeChainId()`. Legacy-key
  detection and one log-context wallet now read keys from the right.
- Not changed, reported: the scan pipeline still names PulseChain's
  price services (GeckoTerminal network `"pulsechain"` in
  `bot-hodl-scan.js` ×2 and `hodl-baseline.js` ×2, price-fetcher
  defaults); `liquidityPairScopeKey` keeps five letters of the chain
  name, `pulse` for both chains; five `"PulseChain"` display-name
  fallbacks in the dashboard.
- Both gates 4430/4430; the region stays at or above 95%. With all seven
  fixes reverted, exactly the 11 new cases failed.

**Third round, night of 2026-10-16 (user-requested).** The user ruled
that nothing in lp-ranger may be hard-coded to a blockchain
([[feedback_never_hard_code_a_chain]]). Done:

- `chains.json` gained `homepage`, `logo`, `blockTimeSec`,
  `nativeCurrencySymbol`, `cacheTag` and `priceServices`; `src/config.js`
  checks each at startup. The price fetcher, historical prices and the
  Moralis key check ask each service by the chain's own id, and skip a
  service whose id is ""; the Moralis table in code is gone, and the dust
  tokens carry `moralisChain`. The current-price fetchers moved to
  `src/price-sources-current.js` (500-line cap).
- Cache names use the chain's `cacheTag` (`pulse` on PulseChain, so no
  existing cache is orphaned; the testnet's is `pulsetest`). The LP
  position cache's callers now pass the chain; they never had.
- The event scanner's five years and the compounder's reposition window
  (`app-runtime.json` → `compound.repositionWindowSec`, 500000 s, which is
  exactly the old 50,000 blocks at ten seconds) use `blockTimeSec`.
- The startup banner, the low-gas message, a gas log line, the cancel
  wording ("zero-value self-transfer"), the chart-link fallback, CLI help
  and five diagnostic tools no longer name PulseChain.
- The dashboard's six `"PulseChain"` fallbacks are blank until the first
  poll, and the header's chain logo and link come from `GET /api/chain`.
- The dashboard's status and Reload polls and the server's copy read
  `dashboardPollIntervalMs`, which the server sends the page (since
  2026-10-17 from `ui-defaults_non-layout_for-server-up-scenario.json`,
  override applied); the CSRF refresh starts
  from csrf.json's value.
- The PID file is removed by an `exit` hook on every exit the server
  makes itself (`POST /api/shutdown` never removed it), and `npm stop`
  signals the PID only while it still runs `server.js`. The stale file
  found that night came from a session whose log just stops on
  2026-10-08, killed outright.
- Eight 2026-10-01 test caches deleted from `tmp/`. Of the two tests
  that left them, `epoch-cache.test.js` then removed its own file, but
  `epoch-reconstructor.test.js` did not: a later block recreated the
  file after the first block's cleanup. The second audit below moved
  both tests' files into the system's temporary directory.

Both gates 4466/4466; the 95% region holds; mutation proofs failed
exactly the expected cases both rounds. Open for the user: the help
dialogs, user manual, donation text and disclosure still give
PulseChain-specific prose.

**First audit after the third round (night of 2026-10-16).** Fixed:

- Five dashboard keys were built from `activeChainId()` with no null
  check, so before the chain was known they read `"null-…"` or `"-…"`:
  the rebalance-event cache (which would have kept a `"null-…"` entry
  in localStorage), the edited-field flags, the Manage button's pool
  gates and Re-scan Prices, which would have sent an empty-chain key
  instead of its "not ready" message.
- `POST /api/position/manage` took a `blockchain` field from the
  request and could mark a position running on a chain the server does
  not run. It keys on the server's own chain now.
- Four pre-existing `displayName ?? "?"` fallbacks were removed as dead,
  since config checks the name at startup, without asking first.
- `activeChainId()` hoisted out of 19 argument lists; timer refusals
  name milliseconds for keys ending in "ms"; the header's chain link is
  painted into a static slot.

**Second audit (same night, user-requested again).** Fixed:

- The double-swap guard on the chunk path had no test: a chunk whose
  nonce is left unsettled must stop `swapIfNeeded` before the V3 router
  swaps the full balance. Removing the guard now fails that test, and
  showed the router really would swap.
- `epoch-reconstructor.test.js` left its cache file in `tmp/` (see the
  third round); both epoch tests now use the system's temporary
  directory, set once per file.
- `nativeWrappedToken` is checked at startup, since the new Moralis key
  probe and five other readers take it as a string.
- The branch's 122 comments in the old `/*-` form were converted
  ([[feedback_multiline_comment_style]]); a test comment named a
  renamed test file; a test header still said `fetch` was stubbed.

Gates after the second audit: Node 24 and Node 22 both 4476/4476,
every lint stage clean, 96.8% lines; the 95% region holds, with the
same branch figures on both.

Open for the user after the second audit: keep or restore the four
removed `?? "?"` fallbacks; the same class is still in the code and
dead — the aggregator's `|| "(empty)"` log label and the
`_attemptLabel ||` fallbacks in the aggregator and the router. Five
fixture-named event caches sit in `tmp/` from about 2026-09-19.

**Audit of 2026-10-17 (user-requested: rules, state and sequence, two
steps out, plus a sweep of hard-coded values into JSON).** Every value
found in code went to the JSON files: the failover window, the budget of
the reads someone waits on (shared by pool state and the re-open check),
the history lookback (one module now, `src/history-lookback.js`, for the
three scans that wrote five years and ten-second blocks themselves), the
event cache's lifetime, scan reuse, the pairing window, the gas-price
log interval, the send retries, a chain's default gas floor, the
dashboard-poll multiple, the error log's path, the price services' urls
(`price-services.json`) and nine dashboard timings. Dead code was
removed wherever a caller or a startup check made it unreachable, with
the tests that only reached it. Fixed: a slippage save freed every
paused position, not only its own; a request refused for its position
key had already applied its global settings, rebuilt the rpc providers
and freed paused loops; the Manage request's contract check compared
addresses with their letter case; an unknown envelope type sent legacy
transactions silently. Found and left for the user, in PROJECT-STATE.md:
[[project_failed_aggregator_gas_dropped]]; two more were settled by the
user the same day (below). Gates: Node 24 and Node 22 both 4567/4567,
every lint stage clean, 96.9% lines; the 95% region holds (two files at
99.1% and 98.8% branches); nine mutations each failed their own tests
and nothing else.

**The user's answers, 2026-10-17, worked the same day, uncommitted
until the user's browser check:** a quote naming no price impact is now
refused with a log line and falls back to the V3 router; a transaction
from outside the bot taking a move's nonce is not a bug, since the
operator controls the wallet ([[feedback_operator_controls_the_wallet]]);
every range moved into `setting-bounds.json` and the doubling numbers
into `bot-config-defaults.json` → `throttleDoubling`; the help reads the
daily cap and every other figure it quotes from those files, and carries
the user's low-volume advice; failing to learn the blockchain counts
toward HALTED; every cache of chain data is keyed chain-first
([[feedback_cache_keys_lead_with_the_chain]]).

**How to apply:** the work is committed on branch
`migrate-to-new-9mm-data-api` and pushed, not merged. Next: the user's
browser check of the badge, the header chain link, the dialogs and the
disclosure, then the four disclosure sentences, then the merge.
The user ruled out building a 9mm api failover on this branch. Related:
[[project_aggregator_swap_wait_double_swap]], [[project_swap_serialized]],
[[project_tests_write_operator_error_log]].
