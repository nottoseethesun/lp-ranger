"use strict";

/**
 * @file event-scanner.js
 * @module eventScanner
 * @description
 * Scans on-chain Transfer events from the NonfungiblePositionManager to build
 * a history of rebalance events for a given wallet.  Queries Transfer events in
 * chunks and pairs out/in transfers within 5 min to form RebalanceEvent records.
 *
 * Results are cached to disk via {@link createCacheStore} so that the expensive
 * 5-year lookback (~7,800 RPC queries) is only performed once.  Subsequent
 * calls scan only the new blocks since the last cached scan and merge results.
 * The cache is a pure performance optimisation — delete it and the scanner
 * rebuilds from the blockchain.
 */

/** PulseChain ~10 s block time → blocks per year. */
const _BLOCKS_PER_YEAR = Math.round((365.25 * 24 * 3600) / 10); // 3_155_760

/** Default chunk size for getLogs queries. */
const _DEFAULT_CHUNK_SIZE = 10000;

/** Maximum seconds between paired Transfer-out and Transfer-in. */
const _PAIRING_WINDOW_SEC = 300;

/** Milliseconds to wait between RPC chunk queries (rate limiting). */
const _CHUNK_DELAY_MS = 250;

const { PM_ABI } = require("./pm-abi");

const POOL_CREATED_ABI = [
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];

/**
 * @typedef {object} RebalanceEvent
 * @property {number}  index       - 1-based sequence number.
 * @property {number}  timestamp   - Unix seconds of the mint transaction.
 * @property {string}  dateStr     - ISO 8601 date string.
 * @property {string}  oldTokenId  - NFT ID of the closed position.
 * @property {string}  newTokenId  - NFT ID of the new position.
 * @property {string}  txHash      - Transaction hash of the mint.
 * @property {number}  blockNumber - Block number of the mint.
 */

/**
 * Fetch all Transfer events in a single chunk, swallowing RPC errors.
 * @param {object} contract - ethers Contract bound to the position manager.
 * @param {string} walletAddress - Checksummed wallet address.
 * @param {number} fromBlock - Start of range (inclusive).
 * @param {number} toBlock   - End of range (inclusive).
 * @returns {Promise<object[]>} Raw ethers event objects.
 */
async function queryChunk(contract, walletAddress, fromBlock, toBlock) {
  const results = [];
  try {
    const filterIn = contract.filters.Transfer(null, walletAddress);
    const filterOut = contract.filters.Transfer(walletAddress, null);
    const [eventsIn, eventsOut] = await Promise.all([
      contract.queryFilter(filterIn, fromBlock, toBlock),
      contract.queryFilter(filterOut, fromBlock, toBlock),
    ]);
    results.push(...eventsIn, ...eventsOut);
  } catch (err) {
    console.warn(
      `[event-scanner] chunk ${fromBlock}–${toBlock} failed: ${err.message}`,
    );
  }
  return results;
}

/**
 * Resolve block timestamps for unique block numbers via the provider.
 * @param {object} provider - ethers provider.
 * @param {number[]} blockNumbers - Block numbers (may contain duplicates).
 * @returns {Promise<Map<number, number>>} blockNumber to Unix timestamp.
 */
async function fetchTimestamps(provider, blockNumbers) {
  const map = new Map();
  const unique = [...new Set(blockNumbers)];
  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    const blocks = await Promise.all(
      batch.map((n) => provider.getBlock(n).catch(() => null)),
    );
    blocks.forEach((b, idx) => {
      if (b) map.set(batch[idx], b.timestamp);
    });
  }
  return map;
}

/**
 * Pair transfers to form rebalance records.  Supports two patterns:
 *   1. Burn+Mint: Transfer-out (wallet→0x0) followed by Transfer-in (0x0→wallet)
 *      within 5 min.
 *   2. Consecutive mints: When the rebalancer does not burn the old NFT
 *      (just removes liquidity), consecutive Transfer-in events from 0x0
 *      represent rebalances — each new mint replaces the previous position.
 * @param {object[]} transfers - Sorted transfer descriptors.
 * @returns {RebalanceEvent[]}
 */
function pairTransfers(transfers) {
  const results = [];
  const used = new Set();
  const ZERO = "0x0000000000000000000000000000000000000000";

  // Pass 1: classic burn+mint pairing (out then in within window)
  for (let i = 0; i < transfers.length; i++) {
    const out = transfers[i];
    if (out.direction !== "out" || used.has(i)) continue;

    for (let j = i + 1; j < transfers.length; j++) {
      const inp = transfers[j];
      if (inp.direction !== "in" || used.has(j)) continue;
      if (inp.timestamp - out.timestamp > _PAIRING_WINDOW_SEC) break;

      used.add(i);
      used.add(j);
      results.push({
        index: 0,
        timestamp: inp.timestamp,
        dateStr: new Date(inp.timestamp * 1000).toISOString(),
        oldTokenId: out.tokenId,
        newTokenId: inp.tokenId,
        txHash: inp.txHash,
        blockNumber: inp.blockNumber,
      });
      break;
    }
  }

  // Pass 2: consecutive mint pairing (no burn — rebalancer drains old NFT)
  const mints = transfers.filter(
    (t, i) => !used.has(i) && t.direction === "in" && t.from === ZERO,
  );

  for (let i = 1; i < mints.length; i++) {
    results.push({
      index: 0,
      timestamp: mints[i].timestamp,
      dateStr: new Date(mints[i].timestamp * 1000).toISOString(),
      oldTokenId: mints[i - 1].tokenId,
      newTokenId: mints[i].tokenId,
      txHash: mints[i].txHash,
      blockNumber: mints[i].blockNumber,
    });
  }

  results.sort((a, b) => a.timestamp - b.timestamp);
  results.forEach((r, idx) => {
    r.index = idx + 1;
  });
  return results;
}

/**
 * Find the block number at which a V3 pool was created by querying the
 * Factory's PoolCreated event.  This lets the scanner skip all blocks before
 * the pool existed, potentially saving thousands of RPC queries.
 *
 * @param {object} provider   - ethers.js provider.
 * @param {object} ethersLib  - ethers library (for Contract).
 * @param {object} opts
 * @param {string} opts.factoryAddress - V3 Factory contract address.
 * @param {string} opts.poolAddress    - The pool address to search for.
 * @param {number} opts.fromBlock      - Earliest block to search from.
 * @param {number} opts.toBlock        - Latest block to search to.
 * @param {number} [opts.chunkSize=50000] - Block range per query (wider since
 *                                          PoolCreated events are rare).
 * @returns {Promise<number|null>} Block number of pool creation, or null.
 */
async function findPoolCreationBlock(provider, ethersLib, opts) {
  const {
    factoryAddress,
    poolAddress,
    fromBlock,
    toBlock,
    chunkSize = 50_000,
    onProgress,
  } = opts;
  if (!factoryAddress || !poolAddress) return null;
  try {
    const factory = new ethersLib.Contract(
      factoryAddress,
      POOL_CREATED_ABI,
      provider,
    );
    const poolLower = poolAddress.toLowerCase();
    const totalChunks = Math.ceil((toBlock - fromBlock + 1) / chunkSize);
    let chunkIdx = 0;
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);
      if (onProgress) onProgress(chunkIdx, totalChunks);
      try {
        const events = await factory.queryFilter(
          factory.filters.PoolCreated(),
          start,
          end,
        );
        for (const ev of events) {
          const createdPool = ev.args[4] || ev.args.pool;
          if (createdPool && createdPool.toLowerCase() === poolLower)
            return ev.blockNumber;
        }
      } catch (_) {
        /* skip failed chunks */
      }
      chunkIdx++;
    }
  } catch (_) {
    /* factory query failed — fall back to full scan */
  }
  return null;
}

/**
 * Deduplicate raw events by txHash + logIndex.
 * @param {object[]} rawEvents
 * @returns {object[]}
 */
function deduplicateRawEvents(rawEvents) {
  const seen = new Set();
  return rawEvents.filter((e) => {
    const key = `${e.transactionHash}-${e.index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Convert raw ethers events into sorted transfer descriptors.
 * @param {object[]} unique        - Deduplicated event objects.
 * @param {string}   walletAddress - Wallet address (lowercase).
 * @param {Map}      tsMap         - Block number → timestamp map.
 * @returns {object[]}
 */
function buildTransferDescriptors(unique, walletAddress, tsMap) {
  const wallet = walletAddress.toLowerCase();
  return unique
    .map((e) => ({
      direction: e.args[1].toLowerCase() === wallet ? "in" : "out",
      tokenId: e.args[2].toString(),
      blockNumber: e.blockNumber,
      timestamp: tsMap.get(e.blockNumber) || 0,
      txHash: e.transactionHash,
      from: e.args[0].toLowerCase(),
      to: e.args[1].toLowerCase(),
    }))
    .filter((t) => t.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber);
}

/**
 * Look up the pool (token0/token1/fee) for each tokenId via positions().
 * @param {object} provider  ethers provider.
 * @param {object} ethersLib ethers library.
 * @param {string} positionManagerAddress  NonfungiblePositionManager address.
 * @param {string[]} tokenIds  Unique token IDs to look up.
 * @returns {Promise<Map<string, string>>}  tokenId → "token0-token1-fee" key.
 */
async function _lookupTokenPools(
  provider,
  ethersLib,
  positionManagerAddress,
  tokenIds,
) {
  const pm = new ethersLib.Contract(positionManagerAddress, PM_ABI, provider);
  const map = new Map();
  for (let i = 0; i < tokenIds.length; i += 10) {
    const batch = tokenIds.slice(i, i + 10);
    const results = await Promise.all(
      batch.map((id) => pm.positions(id).catch(() => null)),
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j]) {
        const r = results[j];
        map.set(
          batch[j],
          `${r[2].toLowerCase()}-${r[3].toLowerCase()}-${Number(r[4])}`,
        );
      }
    }
  }
  return map;
}

/**
 * Merge cached and new events, deduplicate by txHash, re-index.
 * @param {RebalanceEvent[]} cachedEvents
 * @param {RebalanceEvent[]} newEvents
 * @returns {RebalanceEvent[]}
 */
function mergeAndIndex(cachedEvents, newEvents) {
  const seenTx = new Set();
  const merged = [...cachedEvents, ...newEvents].filter((e) => {
    if (seenTx.has(e.txHash)) return false;
    seenTx.add(e.txHash);
    return true;
  });
  merged.sort((a, b) => a.timestamp - b.timestamp);
  merged.forEach((e, i) => {
    e.index = i + 1;
  });
  return merged;
}

/**
 * Scan on-chain rebalance history for a wallet.
 *
 * When a `cache` store is provided, previously scanned results are loaded and
 * only new blocks since the last scan are queried.  This reduces the ~7,800
 * RPC queries for a 5-year lookback to a handful on subsequent calls.
 *
 * @param {object} provider   - ethers.js provider.
 * @param {object} ethersLib  - ethers library (for Contract, etc.).
 * @param {object} opts
 * @param {string} opts.positionManagerAddress
 * @param {string} opts.walletAddress
 * @param {number} [opts.maxYears=5]    - Maximum lookback period in years.
 * @param {number} [opts.chunkSize=2000] - Block range per getLogs query.
 * @param {object} [opts.cache]         - CacheStore instance for disk persistence.
 * @param {string} [opts.factoryAddress] - V3 Factory address (for pool-age optimisation).
 * @param {string} [opts.poolAddress]    - Pool address (for pool-age optimisation).
 * @returns {Promise<RebalanceEvent[]>}
 */
/**
 * Resolve the starting block for a scan, applying pool-age optimisation.
 * @param {object} provider
 * @param {object} ethersLib
 * @param {number} currentBlock
 * @param {number} fromBlock
 * @param {string|null} factoryAddress
 * @param {string|null} poolAddress
 * @returns {Promise<number>}
 */
async function resolveFromBlock(
  provider,
  ethersLib,
  currentBlock,
  fromBlock,
  factoryAddress,
  poolAddress,
  onProgress,
) {
  if (!factoryAddress || !poolAddress) return fromBlock;
  const creationBlock = await findPoolCreationBlock(provider, ethersLib, {
    factoryAddress,
    poolAddress,
    fromBlock,
    toBlock: currentBlock,
    onProgress,
  });
  return creationBlock !== null && creationBlock > fromBlock
    ? creationBlock
    : fromBlock;
}

/**
 * Load cached scan results and determine where to resume scanning.
 * @param {object|null} cache
 * @param {string}      cacheKey
 * @param {number}      fromBlock
 * @returns {Promise<{cachedEvents: RebalanceEvent[], scanFrom: number}>}
 */
async function loadCache(cache, cacheKey, fromBlock) {
  if (!cache) return { cachedEvents: [], scanFrom: fromBlock };
  const cached = await cache.get(cacheKey);
  if (cached && cached.events && cached.lastBlock) {
    const evts = cached.events;
    if (cached.firstMintTimestamp)
      evts.firstMintTimestamp = cached.firstMintTimestamp;
    return { cachedEvents: evts, scanFrom: cached.lastBlock + 1 };
  }
  return { cachedEvents: [], scanFrom: fromBlock };
}

/**
 * Scan all chunks in a block range.
 * @param {object} contract
 * @param {string} walletAddress
 * @param {number} scanFrom
 * @param {number} currentBlock
 * @param {number} chunkSize
 * @returns {Promise<object[]>}
 */
async function scanChunks(
  contract,
  walletAddress,
  scanFrom,
  currentBlock,
  chunkSize,
  onProgress,
  label,
  delayMs,
) {
  const rawEvents = [];
  const totalChunks = Math.ceil((currentBlock - scanFrom + 1) / chunkSize);
  let done = 0;
  for (let start = scanFrom; start <= currentBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, currentBlock);
    rawEvents.push(...(await queryChunk(contract, walletAddress, start, end)));
    done++;
    if (done % 50 === 0 || done === totalChunks) {
      console.log(
        "[event-scanner] %s: %d/%d chunks scanned (%d events)",
        label,
        done,
        totalChunks,
        rawEvents.length,
      );
    }
    if (onProgress) onProgress(done, totalChunks);
    if (done < totalChunks) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return rawEvents;
}

/**
 * Build the cache key, appending pool info when pool filtering is active.
 * @param {string} walletAddress
 * @param {string} positionManagerAddress
 * @param {string|null} poolToken0  @param {string|null} poolToken1
 * @param {number|null} poolFee
 * @returns {string}
 */
function _buildCacheKey(
  walletAddress,
  positionManagerAddress,
  poolToken0,
  poolToken1,
  poolFee,
) {
  const base = `rebalance:${walletAddress.toLowerCase()}:${positionManagerAddress.toLowerCase()}`;
  if (poolToken0 && poolToken1 && poolFee !== null && poolFee !== undefined) {
    return `${base}:${poolToken0.toLowerCase()}-${poolToken1.toLowerCase()}-${poolFee}`;
  }
  return base;
}

/**
 * Filter transfer descriptors to only include tokenIds belonging to a target pool.
 * Prevents cross-pool consecutive mint pairing when a wallet has multiple pools.
 * @param {object} provider  @param {object} ethersLib
 * @param {string} positionManagerAddress
 * @param {object[]} transfers  Transfer descriptors.
 * @param {string} poolToken0  @param {string} poolToken1  @param {number} poolFee
 * @returns {Promise<object[]>}  Filtered transfers.
 */
async function _filterByPool(
  provider,
  ethersLib,
  positionManagerAddress,
  transfers,
  poolToken0,
  poolToken1,
  poolFee,
) {
  const tids = [...new Set(transfers.map((t) => t.tokenId))];
  const poolMap = await _lookupTokenPools(
    provider,
    ethersLib,
    positionManagerAddress,
    tids,
  );
  const target = `${poolToken0.toLowerCase()}-${poolToken1.toLowerCase()}-${poolFee}`;
  const filtered = transfers.filter((t) => poolMap.get(t.tokenId) === target);
  console.log(
    `[event-scanner] Pool filter: ${transfers.length} transfers → ${filtered.length} same-pool`,
  );
  return filtered;
}

/**
 * Scan on-chain rebalance history for a wallet.
 *
 * When a `cache` store is provided, previously scanned results are loaded and
 * only new blocks since the last scan are queried.
 *
 * @param {object} provider
 * @param {object} ethersLib
 * @param {object} opts
 * @param {string} opts.positionManagerAddress
 * @param {string} opts.walletAddress
 * @param {number} [opts.maxYears=5]
 * @param {number} [opts.chunkSize=2000]
 * @param {object} [opts.cache]
 * @param {string} [opts.factoryAddress]
 * @param {string} [opts.poolAddress]
 * @param {string} [opts.poolToken0]  Pool token0 address for pool-aware filtering.
 * @param {string} [opts.poolToken1]  Pool token1 address for pool-aware filtering.
 * @param {number} [opts.poolFee]     Pool fee tier for pool-aware filtering.
 * @returns {Promise<RebalanceEvent[]>}
 */
/**
 * Process raw events into paired rebalance records, optionally filtering by pool.
 * @param {object} provider  @param {object} ethersLib
 * @param {object[]} rawEvents  Raw ethers event objects.
 * @param {string} walletAddress  @param {string} positionManagerAddress
 * @param {RebalanceEvent[]} cachedEvents  Previously cached events.
 * @param {object} poolFilter  { poolToken0, poolToken1, poolFee } or all nulls.
 * @returns {Promise<{merged: RebalanceEvent[], firstMintTimestamp: number|null}>}
 */
async function _processRawEvents(
  provider,
  ethersLib,
  rawEvents,
  walletAddress,
  positionManagerAddress,
  cachedEvents,
  poolFilter,
) {
  const unique = deduplicateRawEvents(rawEvents);
  const tsMap = await fetchTimestamps(
    provider,
    unique.map((e) => e.blockNumber),
  );
  let transfers = buildTransferDescriptors(unique, walletAddress, tsMap);

  const { poolToken0, poolToken1, poolFee } = poolFilter;
  if (poolToken0 && poolToken1 && poolFee !== null && poolFee !== undefined) {
    transfers = await _filterByPool(
      provider,
      ethersLib,
      positionManagerAddress,
      transfers,
      poolToken0,
      poolToken1,
      poolFee,
    );
  }

  const merged = mergeAndIndex(cachedEvents, pairTransfers(transfers));
  const ZERO = "0x0000000000000000000000000000000000000000";
  const firstMint = transfers
    .filter((t) => t.direction === "in" && t.from === ZERO)
    .sort((a, b) => a.timestamp - b.timestamp)[0];
  const firstMintTimestamp = firstMint
    ? firstMint.timestamp
    : cachedEvents.firstMintTimestamp || null;
  if (firstMintTimestamp) merged.firstMintTimestamp = firstMintTimestamp;
  return { merged, firstMintTimestamp };
}

/** Build a human-readable label for scan progress logs. */
function _scanLabel(walletAddress, poolToken0, poolToken1, poolFee) {
  const wallet = walletAddress.slice(0, 8) + "…";
  if (poolToken0 && poolToken1 && poolFee) {
    const t0 = poolToken0.slice(0, 8) + "…";
    const t1 = poolToken1.slice(0, 8) + "…";
    return `Pool ${t0}/${t1} fee=${poolFee} (wallet ${wallet})`;
  }
  return `All pools (wallet ${wallet})`;
}

/** Check cache; skip pool-creation lookup if cached data exists. */
async function _resolveCache(
  provider,
  ethersLib,
  cache,
  cacheKey,
  baseFrom,
  currentBlock,
  factoryAddress,
  poolAddress,
  onProgress,
) {
  const pre = await loadCache(cache, cacheKey, baseFrom);
  if (pre.scanFrom > baseFrom) return pre;
  const from = await resolveFromBlock(
    provider,
    ethersLib,
    currentBlock,
    baseFrom,
    factoryAddress,
    poolAddress,
    onProgress,
  );
  return loadCache(cache, cacheKey, from);
}

/** True when the cache already covers all blocks — no new scan needed. */
function _cacheCovers(scanFrom, currentBlock, cached) {
  return scanFrom > currentBlock && cached.length > 0;
}

async function scanRebalanceHistory(provider, ethersLib, opts) {
  const {
    positionManagerAddress,
    walletAddress,
    maxYears = 5,
    chunkSize = _DEFAULT_CHUNK_SIZE,
    cache = null,
    factoryAddress = null,
    poolAddress = null,
    poolToken0 = null,
    poolToken1 = null,
    poolFee = null,
  } = opts;
  const chunkDelayMs = opts.chunkDelayMs ?? _CHUNK_DELAY_MS;

  const currentBlock = await provider.getBlockNumber();
  const cacheKey = _buildCacheKey(
    walletAddress,
    positionManagerAddress,
    poolToken0,
    poolToken1,
    poolFee,
  );
  const baseFrom = Math.max(
    0,
    currentBlock - Math.round(maxYears * _BLOCKS_PER_YEAR),
  );
  const { cachedEvents, scanFrom } = await _resolveCache(
    provider,
    ethersLib,
    cache,
    cacheKey,
    baseFrom,
    currentBlock,
    factoryAddress,
    poolAddress,
    opts.onPoolCreationProgress,
  );

  if (_cacheCovers(scanFrom, currentBlock, cachedEvents)) return cachedEvents;

  const contract = new ethersLib.Contract(
    positionManagerAddress,
    PM_ABI,
    provider,
  );
  const rawEvents = await scanChunks(
    contract,
    walletAddress,
    scanFrom,
    currentBlock,
    chunkSize,
    opts.onProgress,
    _scanLabel(walletAddress, poolToken0, poolToken1, poolFee),
    chunkDelayMs,
  );

  console.log(`[event-scanner] Raw events found: ${rawEvents.length}`);
  if (rawEvents.length === 0 && cachedEvents.length === 0) return [];
  if (rawEvents.length === 0) {
    const fmts = cachedEvents.firstMintTimestamp || null;
    if (cache)
      await cache.set(cacheKey, {
        events: cachedEvents,
        lastBlock: currentBlock,
        firstMintTimestamp: fmts,
      });
    return cachedEvents;
  }

  const { merged, firstMintTimestamp } = await _processRawEvents(
    provider,
    ethersLib,
    rawEvents,
    walletAddress,
    positionManagerAddress,
    cachedEvents,
    { poolToken0, poolToken1, poolFee },
  );

  if (cache)
    await cache.set(cacheKey, {
      events: merged,
      lastBlock: currentBlock,
      firstMintTimestamp,
    });
  return merged;
}

module.exports = {
  scanRebalanceHistory,
  findPoolCreationBlock,
  buildCacheKey: _buildCacheKey,
  _BLOCKS_PER_YEAR,
  _DEFAULT_CHUNK_SIZE,
  _PAIRING_WINDOW_SEC,
  _CHUNK_DELAY_MS,
};
