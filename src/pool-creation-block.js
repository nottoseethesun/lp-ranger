/**
 * @file src/pool-creation-block.js
 * @module poolCreationBlock
 * @description
 * Disk-cached resolver for the V3 pool's `PoolCreated` block on the Factory.
 * Used as a safe lower bound for historical NFT-event scans (HODL baseline,
 * compound classifier, closed-position history, unmanaged-position details)
 * so they don't replay all blocks back to chain genesis.
 *
 * The lookup itself is expensive (chunked scan of Factory PoolCreated logs),
 * so the result is memoized in-process and persisted to disk keyed by
 * `factoryAddress|poolAddress` (lower-cased).  Failure to determine the
 * block returns `0` — preserves prior "scan from genesis" behaviour rather
 * than silently dropping events.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const config = require("./config");
const { findPoolCreationBlock } = require("./event-scanner");

/** Disk-cache file path (overridable via env for tests). */
const _CACHE_PATH =
  process.env.POOL_CREATION_BLOCK_CACHE_PATH ||
  path.join(process.cwd(), "tmp", "pool-creation-blocks-cache.json");

/** In-memory cache: `factoryLower|poolLower` -> blockNumber. */
const _memCache = new Map();
/** In-flight resolver promises, deduped by cache key. */
const _pending = new Map();
let _diskLoaded = false;

/** Build the canonical cache key. */
function _key(factoryAddress, poolAddress) {
  return (
    String(factoryAddress).toLowerCase() +
    "|" +
    String(poolAddress).toLowerCase()
  );
}

/** Load disk cache into memory on first use (best-effort). */
function _loadDisk() {
  if (_diskLoaded) return;
  _diskLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(_CACHE_PATH, "utf8"));
    for (const [k, v] of Object.entries(raw)) {
      if (Number.isFinite(v) && v >= 0) _memCache.set(k, v);
    }
  } catch {
    /* no cache file yet — that's fine */
  }
}

/** Persist in-memory cache to disk (best-effort). */
function _saveDisk() {
  try {
    fs.mkdirSync(path.dirname(_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      _CACHE_PATH,
      JSON.stringify(Object.fromEntries(_memCache), null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Resolve the V3 pool's creation block, with memo + disk cache.
 * Returns the block number when found, or `0` if the lookup cannot be
 * completed (preserves the prior "scan from genesis" lower bound rather
 * than silently dropping events).
 *
 * @param {object} opts
 * @param {object} opts.provider        ethers.js provider
 * @param {object} opts.ethersLib       ethers library (for Contract)
 * @param {string} opts.factoryAddress  V3 Factory address
 * @param {string} opts.poolAddress     Pool address
 * @returns {Promise<number>}  block number (>=0); 0 means "unknown / use genesis"
 */
async function getPoolCreationBlockCached(opts) {
  const { provider, ethersLib, factoryAddress, poolAddress } = opts || {};
  if (!provider || !ethersLib || !factoryAddress || !poolAddress) return 0;
  _loadDisk();
  const k = _key(factoryAddress, poolAddress);
  const cached = _memCache.get(k);
  if (Number.isFinite(cached)) return cached;
  if (_pending.has(k)) return _pending.get(k);
  const p = (async () => {
    try {
      const currentBlock = await provider.getBlockNumber();
      const block = await findPoolCreationBlock(provider, ethersLib, {
        factoryAddress,
        poolAddress,
        fromBlock: 0,
        toBlock: currentBlock,
      });
      const value = Number.isFinite(block) && block >= 0 ? block : 0;
      _memCache.set(k, value);
      _saveDisk();
      console.log(
        "[pool-creation-block] " +
          poolAddress +
          " -> block " +
          value +
          (value === 0 ? " (unknown — using genesis)" : ""),
      );
      return value;
    } catch (err) {
      console.warn(
        "[pool-creation-block] lookup failed for " +
          poolAddress +
          ": " +
          err.message,
      );
      return 0;
    } finally {
      _pending.delete(k);
    }
  })();
  _pending.set(k, p);
  return p;
}

/**
 * Resolve a pool address from a tokenId by reading
 * `positions(tokenId).{token0,token1,fee}` and asking the Factory for the
 * pool.  Returns null on any failure.
 *
 * @param {object} opts
 * @param {object} opts.provider
 * @param {object} opts.ethersLib
 * @param {string} opts.positionManagerAddress
 * @param {string} opts.factoryAddress
 * @param {string|number} opts.tokenId
 * @returns {Promise<string|null>}
 */
async function resolvePoolAddressForToken(opts) {
  const {
    provider,
    ethersLib,
    positionManagerAddress,
    factoryAddress,
    tokenId,
  } = opts || {};
  if (!provider || !ethersLib || !positionManagerAddress || !factoryAddress)
    return null;
  try {
    const pmAbi = [
      "function positions(uint256) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
    ];
    const pm = new ethersLib.Contract(positionManagerAddress, pmAbi, provider);
    const pos = await pm.positions(tokenId);
    const factoryAbi = [
      "function getPool(address,address,uint24) view returns (address)",
    ];
    const factory = new ethersLib.Contract(
      factoryAddress,
      factoryAbi,
      provider,
    );
    const pool = await factory.getPool(pos.token0, pos.token1, pos.fee);
    if (!pool || pool === ethersLib.ZeroAddress) return null;
    return pool;
  } catch {
    return null;
  }
}

/**
 * Resolve the pool's creation block from a `position` shape (token0/token1/fee).
 * Spins up its own provider via `config.RPC_URL` so callers without a provider
 * handle in scope (e.g. bot-recorder's lifetime scan) can still tighten their
 * lower bound.  Returns 0 on any failure — preserves prior behaviour.
 *
 * @param {object} opts
 * @param {string} opts.factoryAddress  V3 Factory address
 * @param {object} opts.position        Position with `token0`, `token1`, `fee`
 * @returns {Promise<number>}
 */
async function resolvePoolCreationBlockForPosition(opts) {
  const { factoryAddress, position } = opts || {};
  if (
    !factoryAddress ||
    !position?.token0 ||
    !position?.token1 ||
    !Number.isFinite(position?.fee)
  )
    return 0;
  try {
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    const factoryAbi = [
      "function getPool(address,address,uint24) view returns (address)",
    ];
    const factory = new ethers.Contract(factoryAddress, factoryAbi, provider);
    const poolAddress = await factory.getPool(
      position.token0,
      position.token1,
      position.fee,
    );
    if (!poolAddress || poolAddress === ethers.ZeroAddress) return 0;
    return await getPoolCreationBlockCached({
      provider,
      ethersLib: ethers,
      factoryAddress,
      poolAddress,
    });
  } catch {
    return 0;
  }
}

/** Test-only: clear caches between cases. */
function _resetForTests() {
  _memCache.clear();
  _pending.clear();
  _diskLoaded = false;
  try {
    fs.unlinkSync(_CACHE_PATH);
  } catch {
    /* ignore */
  }
}

module.exports = {
  getPoolCreationBlockCached,
  resolvePoolAddressForToken,
  resolvePoolCreationBlockForPosition,
  _resetForTests,
  _CACHE_PATH,
};
