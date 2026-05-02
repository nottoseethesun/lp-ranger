/**
 * @file src/liquidity-pair-details.js
 * @module liquidityPairDetails
 * @description
 * Disk-backed JSON cache of "extra" details about a (blockchain, NFT factory,
 * wallet, token0, token1, fee) liquidity-pair scope — i.e. one entry per
 * unique asset configuration regardless of which specific pool address holds
 * the position at any given time.  The same scope key is used as the suffix
 * of `event-cache-*.json` filenames; see {@link liquidityPairScopeKey} in
 * `cache-store.js`.
 *
 * The first cached field is `initialResidualData`: the wallet's balances of
 * token0/token1 (and their USD prices) at the block immediately preceding
 * the very first `IncreaseLiquidity` event for that scope.  This "genesis"
 * residual is what the wallet held before any LP activity began, and so
 * must be subtracted out of the live `walletResiduals()` figure to avoid
 * inflating Lifetime Net P&L with pre-existing balances.
 *
 * Cache file: `tmp/liquidity-pair-details-cache.json` (gitignored).  Wiped
 * by the standard cache-cleanup utilities — this is a pure performance
 * optimisation, never a source of truth.
 *
 * Lazy-loaded on first access; written atomically (tmp + rename) on each
 * mutation so that a SIGINT mid-write cannot leave a truncated file.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { liquidityPairScopeKey } = require("./cache-store");
const { fetchHistoricalPriceGecko } = require("./price-fetcher");

// Path can be overridden via env var so tests cannot ever clobber the
// production file, regardless of how the test is invoked.
const _CACHE_PATH =
  process.env.LIQUIDITY_PAIR_DETAILS_CACHE_PATH ||
  path.join(process.cwd(), "tmp", "liquidity-pair-details-cache.json");

/** Minimal ERC-20 ABI fragment — only what we need for historical balances. */
const _ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/**
 * @typedef {Object} InitialResidualData
 * @property {string} date          - ISO timestamp of the genesis block.
 * @property {number} token0Amount  - Human-readable float (decimals applied).
 * @property {number} token1Amount  - Human-readable float (decimals applied).
 * @property {number} token0Price   - USD price at genesis block.
 * @property {number} token1Price   - USD price at genesis block.
 */

/** @type {Record<string, { initialResidualData?: InitialResidualData }>|null} */
let _cache = null;

/** Lazy-load the cache from disk.  Silently starts empty on any error. */
function _ensureLoaded() {
  if (_cache !== null) return;
  try {
    _cache = JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
  } catch {
    _cache = {};
  }
}

/** Atomically persist the in-memory cache to disk. */
function _persist() {
  if (!_cache) return;
  const dir = path.dirname(_CACHE_PATH);
  const tmp = _CACHE_PATH + ".tmp";
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(_cache, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, _CACHE_PATH);
  } catch (err) {
    console.warn(
      "[liquidity-pair-details] Could not persist cache:",
      err.message,
    );
  }
}

/**
 * Return the `initialResidualData` entry for the given scope key, or null
 * if the cache has no entry yet.
 *
 * @param {string} scopeKey - As built by {@link liquidityPairScopeKey}.
 * @returns {InitialResidualData|null}
 */
function loadInitialResidualData(scopeKey) {
  _ensureLoaded();
  const entry = _cache[scopeKey];
  return entry && entry.initialResidualData ? entry.initialResidualData : null;
}

/**
 * Resolve the wallet's pre-LP "genesis" residual for one token at the block
 * immediately preceding the first IncreaseLiquidity.
 *
 * @param {Object}  args
 * @param {string}  args.tokenAddress
 * @param {string}  args.wallet
 * @param {number}  args.blockTag        - Block number to read at.
 * @param {Object}  args.provider        - ethers JsonRpcProvider.
 * @param {Object}  args.ethersLib       - ethers module reference.
 * @returns {Promise<number>} Human-readable float balance.
 */
async function _readHistoricalBalance({
  tokenAddress,
  wallet,
  blockTag,
  provider,
  ethersLib,
}) {
  const erc20 = new ethersLib.Contract(
    tokenAddress,
    _ERC20_BALANCE_ABI,
    provider,
  );
  const [raw, decimals] = await Promise.all([
    erc20.balanceOf(wallet, { blockTag }),
    erc20.decimals(),
  ]);
  return Number(ethersLib.formatUnits(raw, decimals));
}

/** Validate required args; return false if any are missing/invalid. */
function _hasRequiredArgs(args) {
  const {
    chain,
    factory,
    wallet,
    token0,
    token1,
    fee,
    firstMintBlock,
    firstMintTimestamp,
    poolAddress,
    provider,
    ethersLib,
  } = args;
  if (!chain || !factory || !wallet || !token0 || !token1) return false;
  if (fee === undefined || fee === null) return false;
  if (!firstMintBlock || !firstMintTimestamp || !poolAddress) return false;
  if (!provider || !ethersLib) return false;
  return true;
}

/** Resolve genesis-block balances for both tokens, or null on failure. */
async function _fetchGenesisBalances({
  token0,
  token1,
  wallet,
  blockTag,
  provider,
  ethersLib,
  scopeKey,
}) {
  try {
    const [t0, t1] = await Promise.all([
      _readHistoricalBalance({
        tokenAddress: token0,
        wallet,
        blockTag,
        provider,
        ethersLib,
      }),
      _readHistoricalBalance({
        tokenAddress: token1,
        wallet,
        blockTag,
        provider,
        ethersLib,
      }),
    ]);
    return { token0Amount: t0, token1Amount: t1 };
  } catch (err) {
    console.warn(
      "[liquidity-pair-details] historical balanceOf failed for scope %s at block %d: %s",
      scopeKey,
      blockTag,
      err.message ?? err,
    );
    return null;
  }
}

/** Resolve genesis-block USD prices; degrades to zeros on failure. */
async function _fetchGenesisPrices({
  poolAddress,
  firstMintTimestamp,
  firstMintBlock,
  chain,
  token0,
  token1,
  scopeKey,
}) {
  try {
    const { price0, price1 } = await fetchHistoricalPriceGecko(
      poolAddress,
      firstMintTimestamp,
      chain,
      {
        token0Address: token0,
        token1Address: token1,
        blockNumber: Number(firstMintBlock),
      },
    );
    return {
      token0Price: Number(price0) || 0,
      token1Price: Number(price1) || 0,
    };
  } catch (err) {
    console.warn(
      "[liquidity-pair-details] historical price fetch failed for scope %s: %s",
      scopeKey,
      err.message ?? err,
    );
    return { token0Price: 0, token1Price: 0 };
  }
}

/**
 * Return the cached `initialResidualData` for a scope; if missing, fetch the
 * wallet's token0/token1 balances at `firstMintBlock - 1`, fetch their USD
 * prices at the same block via GeckoTerminal, persist, and return.
 *
 * Idempotent: a populated cache entry is returned untouched.
 *
 * @param {Object} args
 * @param {string} args.chain               - Internal chain name (e.g. 'pulsechain').
 * @param {string} args.factory             - NFT position-manager address.
 * @param {string} args.wallet              - Owner wallet address.
 * @param {string} args.token0
 * @param {string} args.token1
 * @param {number|string} args.fee
 * @param {number} args.firstMintBlock      - Block number of the first IncreaseLiquidity.
 * @param {number} args.firstMintTimestamp  - Unix seconds of the first IncreaseLiquidity.
 * @param {string} args.poolAddress         - Pool address active at first mint (for OHLCV).
 * @param {Object} args.provider            - ethers JsonRpcProvider.
 * @param {Object} args.ethersLib           - ethers module reference.
 * @returns {Promise<InitialResidualData|null>}
 */
async function ensureInitialResidualData(args) {
  if (!_hasRequiredArgs(args)) return null;
  const {
    chain,
    factory,
    wallet,
    token0,
    token1,
    fee,
    firstMintBlock,
    firstMintTimestamp,
    poolAddress,
    provider,
    ethersLib,
  } = args;

  const scopeKey = liquidityPairScopeKey({
    blockchain: chain,
    factory,
    wallet,
    token0,
    token1,
    fee,
  });

  const cached = loadInitialResidualData(scopeKey);
  if (cached) return cached;

  const blockTag = Number(firstMintBlock) - 1;
  const balances = await _fetchGenesisBalances({
    token0,
    token1,
    wallet,
    blockTag,
    provider,
    ethersLib,
    scopeKey,
  });
  if (!balances) return null;
  const prices = await _fetchGenesisPrices({
    poolAddress,
    firstMintTimestamp,
    firstMintBlock,
    chain,
    token0,
    token1,
    scopeKey,
  });

  const data = {
    date: new Date(Number(firstMintTimestamp) * 1000).toISOString(),
    token0Amount: balances.token0Amount,
    token1Amount: balances.token1Amount,
    token0Price: prices.token0Price,
    token1Price: prices.token1Price,
  };

  _ensureLoaded();
  if (!_cache[scopeKey]) _cache[scopeKey] = {};
  _cache[scopeKey].initialResidualData = data;
  _persist();

  console.log(
    "[liquidity-pair-details] %s genesis residual recorded (t0=%s @$%s, t1=%s @$%s)",
    scopeKey,
    data.token0Amount,
    data.token0Price,
    data.token1Amount,
    data.token1Price,
  );

  return data;
}

/** Reset in-memory state (for testing). */
function _resetForTest() {
  _cache = null;
}

module.exports = {
  loadInitialResidualData,
  ensureInitialResidualData,
  _resetForTest,
  _CACHE_PATH,
};
