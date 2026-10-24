/**
 * @file src/bot-config-keys.js
 * @module bot-config-keys
 * @description
 *   The config vocabulary: which keys exist in `bot-config.json`, which
 *   section each belongs to, and what each one means.
 *
 *   Pure data, no dependencies. Split out of `bot-config-v2.js` at the
 *   500-line cap, and the right seam besides: the openapi-sync gate and
 *   the shipped-defaults reader ask only "what keys are there?" and have
 *   no business loading the config machinery to find out.
 */

"use strict";

/** Keys that belong in the global section. */
const GLOBAL_KEYS = [
  /*- `positionManager` and `factory` are deliberately NOT here.  The
   *  bot resolves each from .env / chains.json at startup and never
   *  reads them back from this file, so accepting one here would write
   *  an address to disk that nothing acts on.
   *
   *  They stay un-settable rather than being wired up, because both
   *  scope the on-disk caches (event cache, LP position cache, epoch
   *  cache) — changing one mid-life orphans every cache keyed to the
   *  old address.  That belongs to a fresh install.  See
   *  docs/configuration.md § "Contract Addresses".
   *
   *  A value left in an existing bot-config.json from before is retired
   *  (`RETIRED_GLOBAL_KEYS`): nothing reads it, the next save drops it,
   *  and POST /api/config will no longer accept a new one. */
  "rpcUrls",
  /*-
   *  Whether the stored Moralis key may be used.  Separate from whether
   *  a key exists: an operator whose quota has run out wants the calls
   *  to stop without throwing the key away and pasting it back later.
   *  Default true, so a key that has never been toggled behaves exactly
   *  as it did before this setting existed.
   */
  "moralisEnabled",
  "approvalMultiple",
  /*-
   *  Maximum gas cost as a percentage of swap value before the gas gate
   *  trips (see `src/swap-gates.js`).  Single global knob shared by all
   *  three swap call sites: initial Rebalance, corrective Rebalance,
   *  Compound.  Stored as a percent (e.g. `1` = 1%); UI bounds 0.1–15.
   *  Default in `app-config/app-defaults-for-user-configurable/bot-config-defaults.json`.
   */
  "gasFeePct",
  /*-
   *  Price-source cache TTL in milliseconds for `src/price-fetcher.js`
   *  (the in-memory cache that backs `fetchTokenPriceUsd`).  Read once
   *  per process at module-load time (no live reload — restart to
   *  apply).  Default `120000` (2 min).  See the idle-driven price-
   *  lookup pause section in docs/architecture.md for context.
   */
  "priceCacheTtlMs",
  /*-
   *  Multiplier that derives the dust-unit price's cache lifetime
   *  (`getDustUnitPriceCacheTtlMs`, src/price-fetcher-gate.js) from
   *  `priceCacheTtlMs` (`dust = price * multiplier`).  Default `30`
   *  reproduces the original 1-h dust-unit-price cache when paired with
   *  the 120000 ms price TTL default (120000 * 30 = 3_600_000 ms).
   *  Must be a positive integer >= 1; a runtime assertion where the
   *  lifetimes are worked out guards the integer-multiple invariant.
   */
  "dustUnitPriceCacheMultiplier",
  /*-
   *  Cache TTL while inside a `withFreshPricesAllowed` scope
   *  (rebalance/compound).  Default `4000` ms (4 s).  Replaces the
   *  earlier "bypass cache + dedup entirely in-move" behaviour that
   *  caused the rapid-fire burst when multiple rebalance stages each
   *  called `fetchTokenPriceUsd` for the same token within a few
   *  seconds (4-6 source hits per token per move).  See
   *  `src/price-fetcher-gate.js#inMove`.
   */
  "moveCacheTtlMs",
  /*-
   *  Balanced-band Telegram notifier (`src/telegram-notifications/balanced-notifier.js`):
   *  multiplier on `CHECK_INTERVAL_SEC` for the cadence at which the
   *  notifier fetches fresh USD prices to evaluate the balanced band
   *  (`positionBalancedBandPct`): a fetch every this many poll
   *  intervals.  Only consulted when the
   *  `positionBalanced` Telegram event is enabled — otherwise zero
   *  load.  See `app-config/app-defaults-for-user-configurable/bot-config-defaults.json`
   *  `_pricePauseExceptionPollWindowMultiple_comment` for operator
   *  guidance.
   */
  "pricePauseExceptionPollWindowMultiple",
];

/** Keys that belong in a per-position (per-pool) section. */
/**
 * Position-config keys whose values are derived from scanning the chain.
 *
 * Every one can be rebuilt by a fresh scan, and each would otherwise
 * compete with that scan: the lifetime scan treats a value already on
 * disk as settled and skips re-deriving it. Two callers clear exactly
 * this set, and must agree on it:
 *
 * - Reload Current Position (`server-reload-position.js`), for one
 *   position, so the rebuild it triggers is authoritative;
 * - `npm run clear-blockchain-scan-cache`, for every position, so a
 *   cold start is actually cold rather than cold for the scan caches only.
 *
 * Not included, deliberately: settings, and values recorded live that a
 * scan cannot reproduce — `residuals` (collected minus minted at each
 * rebalance) and `lastCompoundAt` (the auto-compound throttle).
 *
 * Nor is `compoundHistory`. A scan does rebuild it, but its entries also
 * carry what the bot recorded when each compound happened: whether it was
 * Auto or Manual, and its Activity Log figures. The rebuild replaces the
 * list and keeps those, matched by transaction
 * (src/compound-activity-figures.js), so it needs the old list in place
 * until the new one is written. The rebuild still runs, because clearing
 * the compounded totals here is what starts it.
 */
const CHAIN_DERIVED_POSITION_KEYS = Object.freeze([
  "compoundedAmount0",
  "compoundedAmount1",
  "nftCompoundedAmountsByTokenId",
  "nftGasWeiByTokenId",
  "hodlBaseline",
  "lifetimeHodlAmounts",
  "totalLifetimeDepositUsd",
  /*-
   *  Travels with the total: a stale "fallback price was used" flag left
   *  behind would mislabel the freshly rebuilt deposit.
   */
  "depositUsedFallback",
]);

/**
 * A position's records: what the bot worked out or logged about it, as
 * against a setting, which the operator chooses. The chain-derived ones
 * above, less the retired `lifetimeHodlAmounts`; `compoundHistory`, which
 * a scan rebuilds while keeping what the bot recorded live in it; and
 * three the bot records live that no scan can reproduce: `residuals`
 * (collected minus minted at each rebalance), `lastCompoundAt` (the
 * auto-compound spacing) and `failedMoveGas` (the gas each failed
 * rebalance or compound paid, with when: src/spent-gas.js). Reload Current
 * Position clears the chain-derived ones for its rebuild, which also
 * replaces `compoundHistory`, and leaves those three alone.
 *
 * They are kept in `app-data/position-records.json`, apart from the
 * settings in bot-config.json (src/position-records.js), and each is saved
 * as the bot reports it (`_persistPositionConfig`,
 * src/server-positions.js). `POST /api/config` takes none of them: only
 * settings are saved from outside the bot.
 */
const RECORD_POSITION_KEYS = Object.freeze([
  "hodlBaseline",
  "residuals",
  "compoundHistory",
  "compoundedAmount0",
  "compoundedAmount1",
  "nftGasWeiByTokenId",
  "nftCompoundedAmountsByTokenId",
  "lastCompoundAt",
  "totalLifetimeDepositUsd",
  "depositUsedFallback",
  "failedMoveGas",
]);

/**
 * Position-config keys the app no longer reads or writes.
 *
 * The first three stored a **dollar total** for compounded fees. The app
 * now stores the coins instead (`compoundedAmount0` / `compoundedAmount1`,
 * `nftCompoundedAmountsByTokenId`) and prices them where they are
 * displayed, because a saved dollar figure is true only at the price
 * that computed it — an error that grows with the position's age. The
 * rest are settings that were retired; each says why where it is listed.
 *
 * Nothing reads these, so leaving them would be dead weight in a file
 * operators open and read. `saveConfig` drops them from every slot on
 * the next write. They carry no information the app wants back: the
 * compound totals' replacement is re-derived from the chain, never
 * from these.
 *
 * This is not a migration and must not grow into one. A key belongs
 * here only once it has no reader anywhere.
 */
const RETIRED_POSITION_KEYS = Object.freeze([
  "totalCompoundedUsd",
  "nftCompoundedUsdByTokenId",
  "collectedFeesUsd",
  /*-
   *  The single per-position slippage, left behind when the Slippage
   *  row became two per-token rows. Dropped rather than migrated: it
   *  was one number covering both sides, and there is no honest way to
   *  split it into two — the two exist because the sides differ. A
   *  position that had it falls back to the default until the operator
   *  sets each token's own, which is where the dashboard has been
   *  pointing them since the row was split.
   */
  "slippagePct",
  /*-
   *  Gas Strategy. Its row offered Auto, Fast and Economy, but the
   *  server refused all but Auto and the bot never read the setting,
   *  so no choice changed anything. The row is gone and so is the
   *  value.
   */
  "gasStrategy",
  /*-
   *  A position's own Check Interval. How often the bot checks is one
   *  global setting, `checkIntervalSec` in bot-config-defaults.json
   *  (or `CHECK_INTERVAL_SEC` in `.env`), because the dashboard's idle
   *  and wake timing are all built on that one value. The bot never
   *  scheduled a check by a position's own value, so dropping it
   *  changes nothing that runs.
   */
  "checkIntervalSec",
  /*-
   *  The pool's lifetime HODL amounts. They live in the epoch cache
   *  (app-data/scan-cache/pnl-epochs-cache.json), and the position's bot state is built
   *  from them there; a copy in the slot was never read back.
   */
  "lifetimeHodlAmounts",
]);

/**
 * Global-section keys the app no longer reads or writes, dropped from
 * `bot-config.json` on the next save on the same terms as
 * `RETIRED_POSITION_KEYS`: nothing reads them, and nothing is carried
 * over from them.
 */
const RETIRED_GLOBAL_KEYS = Object.freeze([
  /*-
   *  The rebalance trigger's type. It was saved through
   *  `POST /api/config` with no control on the page, and only one type,
   *  out of range, ever existed. Nothing read it.
   */
  "triggerType",
  /*-
   *  The position manager's and the pool factory's addresses, saved by
   *  Bot Settings fields that releases from April to September 2026
   *  offered. The bot takes both from `.env` and chains.json, and the
   *  dashboard takes a position's contract from its key.
   */
  "positionManager",
  "factory",
  /*-
   *  The single rpc address that releases before September 2026 saved
   *  whenever the rpc field changed or one of its presets was clicked.
   *  The list in `rpcUrls` replaced it, and nothing reads it.
   */
  "rpcUrl",
]);

const POSITION_KEYS = [
  /*-
   * Impermanent Loss Guard, percent.  The most impermanent loss a
   * position may carry before the bot refuses to rebalance it: the
   * hypothetical post-rebalance position is compared against holding the
   * coins the held NFT was minted with, at today's prices (the Current
   * panel's IL/G), and the rebalance is rejected when the projection
   * falls more than this far below holding.
   * Evaluated read-only in `checkIlGuard` (src/il-guard.js), upstream
   * of `executeRebalance`, so a rejection can never drain the position.
   * See src/il-guard.js for the rule and its consequences.
   */
  "impermanentLossGuardPct",
  "rebalanceOutOfRangeThresholdPercent",
  "rebalanceTimeoutMin",
  /*-
   * Persistent per-position override for the rebalance range width, in
   * percent of current price.  When set, every subsequent rebalance
   * (manual OR automatic) uses this width via `_computeRange()` in
   * src/rebalancer.js.  When unset, the bot falls back to
   * `rangeMath.preserveRange()` (existing default — preserves the
   * on-chain tick spread).  No shipped default literal per
   * feedback_one_literal_per_shipped_default; empty === use fallback.
   * Set from the "Price Range Extension" input in the Range subsection
   * of Bot Settings (see public/dashboard-price-range-extension.js
   * `saveRangeWidth`).  Only consulted when `rangeOverrideEnabled`
   * resolves true.
   */
  "rebalanceRangeWidthPct",
  /*-
   * The Range subsection's "No Override" toggle.  `false` means re-use
   * the position's existing on-chain range on the next rebalance,
   * ignoring every other Range key; `true` means apply them.  Absent
   * means "the user has not touched the toggle" and is resolved by
   * `resolveRangeOverrideEnabled` in src/range-override.js — an empty
   * slot resolves to `false`, a slot already carrying Range settings
   * resolves to `true`.  The toggle never clears the other Range keys:
   * they stay on disk (greyed out in the UI) so flipping it back
   * restores the user's settings intact.
   */
  "rangeOverrideEnabled",
  /*-
   * Persistent per-position toggle for full-range rebalances.  When
   * `true`, every subsequent rebalance mints at MIN_TICK / MAX_TICK
   * via `rangeMath.fullRange()`, ignoring any saved
   * `rebalanceRangeWidthPct`.  When `false` (or unset), the normal
   * precedence applies: custom Price Range Extension if set, else
   * `preserveRange()`.  Driven by the "Full-Range" checkbox next to
   * the Price Range Extension input in Bot Settings — replaces the
   * old `rebalanceRangeWidthPct === 100` full-range sentinel.
   */
  "fullRangeRebalanceEnabled",
  /*-
   *  Slippage is two settings, one per token, and nothing else. The
   *  swap layer picks by DESTINATION token: a token0 → token1 swap
   *  uses `slippagePctToken1`, a token1 → token0 swap uses
   *  `slippagePctToken0`. A token with no setting of its own falls
   *  back to the `slippagePct` default in bot-config-defaults.json
   *  (0.75 as shipped, overridable by the operator's copy), which is a
   *  default and not a per-position setting.
   *
   *  There was a third, `slippagePct` saved per position, left behind
   *  when the single Slippage row became two. It was dormant for
   *  rebalances and still honoured by compounds, so one position could
   *  swap at two different slippages depending on which move it was
   *  making. Retired: `RETIRED_POSITION_KEYS` drops it on the next
   *  save, and nothing reads it in the meantime.
   */
  "slippagePctToken0",
  "slippagePctToken1",
  "minRebalanceIntervalMin",
  "maxRebalancesPerDay",
  "hodlBaseline",
  "residuals",
  "initialDepositUsd",
  "priceOverride0",
  "priceOverride1",
  "priceOverrideForce",
  "decimalsOverride0",
  "decimalsOverride1",
  "decimalsOverrideForce0",
  "decimalsOverrideForce1",
  "autoCompoundEnabled",
  "autoCompoundThresholdUsd",
  "compoundHistory",
  /*-
   *  The coins this position has compounded, in token units, across every
   *  NFT in its rebalance chain.  Saved instead of a dollar total: the
   *  figure on screen is priced at the moment it is shown, so it follows
   *  the pair rather than freezing at the price some earlier scan saw.
   */
  "compoundedAmount0",
  "compoundedAmount1",
  /*-
   *  Per-NFT total gas wei (mint TX gas + standalone compound TX gas) keyed
   *  by tokenId.  Populated by the lifetime scan
   *  (`bot-recorder-lifetime.js`) and the on-demand per-NFT scan
   *  (`bot-pnl-current-nft._scanNftTotals`).  Drives the Current
   *  panel's "Gas" row so Managed and Unmanaged report the same figure for
   *  the same NFT.  Lifetime panel still uses the per-epoch tracker sum;
   *  this field is Current-panel only.
   */
  "nftGasWeiByTokenId",
  /*-
   *  Per-NFT compounded coins (`{amount0, amount1}` in token units) keyed
   *  by tokenId.  Populated by the same per-NFT scan that fills
   *  nftGasWeiByTokenId.  Drives the Managed Current panel's "Fees
   *  Compounded" row when compoundHistory lacks entries for this NFT
   *  (e.g. the unmanaged scan ran first and the bot's lifetime scan was
   *  gated off by `hasCompoundData`).  Priced where it is shown, like
   *  every other current figure.  Current-panel only.
   */
  "nftCompoundedAmountsByTokenId",
  "lastCompoundAt",
  "offsetToken0Pct",
  /*-
   *  Lifetime deposit (USD) and the "fallback price source was used" flag
   *  produced by `computeDepositUsd` in `bot-hodl-scan.js`.  Persisted so
   *  that the disk-as-source-of-truth gate in `_scanLifetimePoolData` can
   *  read them on the next bot start and skip a redundant deposit
   *  recompute.
   */
  "totalLifetimeDepositUsd",
  "depositUsedFallback",
  /*-
   *  The gas each failed rebalance or compound paid, with when
   *  (`src/spent-gas.js`): no chain scan finds it, so it is a record the
   *  P&L counts in its period on every poll, and Reload leaves it alone.
   */
  "failedMoveGas",
  /*-
   *  User override for the "alive since" start date used by Lifetime
   *  Day Count and APR denominators.  Stored as an ISO YYYY-MM-DD (UTC)
   *  so it's timezone-neutral and human-readable in `bot-config.json`.
   *  When set, `ltStartDate()` in `dashboard-date-utils.js` uses it
   *  ahead of every auto-detected candidate (firstEpochDateUtc,
   *  hodlBaseline.mintDate, poolFirstMintDate).  Cleared by POSTing
   *  `null` — the null-sweep in server-routes.js POST /api/config
   *  handler deletes the key from disk so bot-config.json stays clean.
   *  The dashboard input accepts a number of days; the save handler
   *  computes `today - days` and stores the result as this string.
   */
  "lifetimeStartDateOverrideUtc",
];

/**
 * The per-position keys that are settings: every position key but the
 * records. These are what bot-config.json holds for a position, beside
 * its `status`, and all `POST /api/config` takes for one.
 */
const SETTING_POSITION_KEYS = Object.freeze(
  POSITION_KEYS.filter((k) => !RECORD_POSITION_KEYS.includes(k)),
);

/**
 * Whether a position slot carries a compounded total that the chain
 * classification established.
 *
 * `compoundedAmount0` / `compoundedAmount1` mean *the whole rebalance
 * chain's* re-deposited fees, and only the lifetime scan's chain-wide
 * classification can say what that is. Absence is therefore a statement,
 * not a gap: it says the chain has not been classified. That is exactly
 * what `clear-blockchain-scan-cache` and Reload Current Position assert
 * by deleting these keys, and what `_resolveDiskState` in
 * `bot-recorder-lifetime.js` reads to decide whether to classify.
 *
 * Which is why the incremental writers — a standalone compound, and the
 * fee credit on a rebalance — ask this before adding. **They may add to
 * a total that exists; they may not create one.** A compound landing
 * between the clear and the scan would otherwise write its own amount
 * into a slot that claims to hold the chain's, and the scan would read
 * that real number as proof the work was already done and skip it for
 * good. Declining costs nothing: the compound is on chain, so the
 * classification counts it whenever it runs.
 *
 * The test is **presence, not magnitude**. A stored zero is an answer —
 * a chain whose NFTs never compounded — and re-deriving it would walk
 * the whole chain again to arrive back at zero, on every scan, for as
 * long as the position runs. Only absence means "not asked yet". That is
 * also why a zero reached by clearing must delete the keys rather than
 * write `0` over them: see `_resetBotState` in
 * `server-reload-position.js`, which nulls them for exactly this reason.
 *
 * A non-finite or negative value is treated as absent. Neither is a
 * figure any classification produced — coins re-deposited cannot be
 * fewer than none — so both mean something upstream went wrong, and
 * accepting either would freeze it in place instead of re-deriving it.
 *
 * @param {number|undefined|null} amount0  Saved token0 compounded coins.
 * @param {number|undefined|null} amount1  Saved token1 compounded coins.
 * @returns {boolean}  True when a chain-established total is present.
 */
function hasCompoundedTotal(amount0, amount1) {
  return isRecordedCoinTotal(amount0) || isRecordedCoinTotal(amount1);
}

/**
 * Whether one saved coin figure is one a classification wrote.
 *
 * Exported because the writers need it per side, not just as the pair
 * test above. Either side alone establishes the total, so the other may
 * still hold anything the config file can express — and these values are
 * read straight out of JSON, where a hand-edited `"100"` is a string.
 * Adding to that string concatenates instead of summing, and the result
 * reaches `toFixed` and throws, in the middle of recording a compound
 * whose transactions already landed on chain. Each side is therefore
 * tested on its own and falls back to zero.
 *
 * @param {*} v  Candidate value.
 * @returns {boolean}
 */
function isRecordedCoinTotal(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

module.exports = {
  GLOBAL_KEYS,
  POSITION_KEYS,
  SETTING_POSITION_KEYS,
  RECORD_POSITION_KEYS,
  CHAIN_DERIVED_POSITION_KEYS,
  RETIRED_POSITION_KEYS,
  RETIRED_GLOBAL_KEYS,
  hasCompoundedTotal,
  isRecordedCoinTotal,
};
