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
  "triggerType",
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
   *  A value left in an existing bot-config.json from before is inert:
   *  nothing reads it, and POST /api/config will no longer accept a
   *  new one. */
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
   *  Multiplier that derives `_DUST_UNIT_PRICE_TTL_MS` from
   *  `priceCacheTtlMs` (`dust = price * multiplier`).  Default `30`
   *  reproduces the original 1-h dust-unit-price cache when paired with
   *  the 120000 ms price TTL default (120000 * 30 = 3_600_000 ms).
   *  Must be a positive integer >= 1; a runtime assertion at module
   *  load guards the integer-multiple invariant.
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
   *  notifier fetches fresh USD prices to evaluate the ±5% balanced
   *  condition.  Default `10` → fetch every 10× poll interval (50 min
   *  at the default 300 s poll).  Only consulted when the
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
 *   cold start is actually cold rather than cold for `tmp/` only.
 *
 * Not included, deliberately: settings, and values recorded live that a
 * scan cannot reproduce — `residuals` (collected minus minted at each
 * rebalance) and `lastCompoundAt` (the auto-compound throttle).
 */
const CHAIN_DERIVED_POSITION_KEYS = Object.freeze([
  "compoundHistory",
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
 * Position-config keys the app no longer reads or writes.
 *
 * All three stored a **dollar total** for compounded fees. The app now
 * stores the coins instead (`compoundedAmount0` / `compoundedAmount1`,
 * `nftCompoundedAmountsByTokenId`) and prices them where they are
 * displayed, because a saved dollar figure is true only at the price
 * that computed it — an error that grows with the position's age.
 *
 * Nothing reads these, so leaving them would be dead weight in a file
 * operators open and read. `saveConfig` drops them from every slot on
 * the next write. They carry no information the app wants back: the
 * replacement is re-derived from the chain, never from these.
 *
 * This is not a migration and must not grow into one. A key belongs
 * here only once it has no reader anywhere.
 */
const RETIRED_POSITION_KEYS = Object.freeze([
  "totalCompoundedUsd",
  "nftCompoundedUsdByTokenId",
  "collectedFeesUsd",
  /*- The single per-position slippage, left behind when the Slippage
   *  row became two per-token rows. Dropped rather than migrated: it
   *  was one number covering both sides, and there is no honest way to
   *  split it into two — the two exist because the sides differ. A
   *  position that had it falls back to the shipped default until the
   *  operator sets each token's own, which is where the dashboard has
   *  been pointing them since the row was split. */
  "slippagePct",
]);

const POSITION_KEYS = [
  /*-
   * Impermanent Loss Guard, percent.  The most a position may have lost
   * before the bot refuses to rebalance it: the hypothetical
   * post-rebalance position is compared against the held NFT's own USD
   * value at mint (`hodlBaseline.entryValue`), and the rebalance is
   * rejected when the projection falls more than this far below it.
   * Evaluated read-only in `_checkIlGuard` (src/bot-cycle.js), upstream
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
   *  back to the shipped `slippagePct` default in
   *  bot-config-defaults.json (currently 0.75), which is a default and
   *  not a per-position setting.
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
  "checkIntervalSec",
  "minRebalanceIntervalMin",
  "maxRebalancesPerDay",
  "gasStrategy",
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
 * write `0` over them: see `_resetStateForReload` in
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
  CHAIN_DERIVED_POSITION_KEYS,
  RETIRED_POSITION_KEYS,
  hasCompoundedTotal,
  isRecordedCoinTotal,
};
