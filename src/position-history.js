/**
 * @file position-history.js
 * @module positionHistory
 * @description
 * Looks up historical data for closed NFT positions.  Combines data from four
 * sources: the local rebalance log, the on-chain event scanner, on-chain TX
 * receipts (IncreaseLiquidity / Collect events), and GeckoTerminal historical
 * prices.  Uses the canonical ABI from @uniswap/v3-periphery via pm-abi.js.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { PM_ABI } = require("./pm-abi");
const { fetchHistoricalPriceGecko } = require("./price-fetcher");

/** In-memory cache for ERC-20 decimals keyed by lowercase address. */
const _decimalsCache = new Map();

/** Read and parse the rebalance log from disk. */
function _readRebalanceLog() {
  try {
    const raw = fs.readFileSync(
      path.join(process.cwd(), config.LOG_FILE || "rebalance_log.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Apply mint-entry (newTokenId match) data to the result object. */
function _applyMintEntry(result, mint) {
  result.mintEntry = {
    loggedAt: mint.loggedAt,
    entryValueUsd: mint.entryValueUsd,
  };
  result.mintDate = mint.loggedAt || null;
  result.entryValueUsd = mint.entryValueUsd ?? null;
  result.token0UsdPriceAtOpen = mint.token0UsdPrice ?? null;
  result.token1UsdPriceAtOpen = mint.token1UsdPrice ?? null;
}

/** Apply close-entry (oldTokenId match) data to the result object. */
function _applyCloseEntry(result, close) {
  result.closeEntry = {
    loggedAt: close.loggedAt,
    exitValueUsd: close.exitValueUsd,
  };
  result.closeDate = close.loggedAt || null;
  result.exitValueUsd = close.exitValueUsd ?? null;
  result.token0UsdPriceAtClose = close.token0UsdPrice ?? null;
  result.token1UsdPriceAtClose = close.token1UsdPrice ?? null;
  result.feesEarnedUsd = close.feesEarnedUsd ?? null;
  result.gasCostWei = close.gasCostWei ?? null;
}

/**
 * Fill in missing data from rebalance events (on-chain event scanner).
 * @param {object}   result  Result object to supplement.
 * @param {string}   tokenId NFT token ID.
 * @param {object[]} events  Array of RebalanceEvent from the event scanner.
 */
function _supplementFromEvents(result, tokenId, events) {
  if (!events) return;
  const mintEv = events.find((e) => String(e.newTokenId) === String(tokenId));
  if (mintEv) {
    if (!result.mintDate && mintEv.timestamp)
      result.mintDate = new Date(mintEv.timestamp * 1000).toISOString();
    if (!result.mintTxHash) result.mintTxHash = mintEv.txHash || null;
    if (mintEv.blockNumber) result.mintBlockNumber = mintEv.blockNumber;
  }
  const closeEv = events.find((e) => String(e.oldTokenId) === String(tokenId));
  if (closeEv) {
    if (!result.closeDate && closeEv.timestamp)
      result.closeDate = new Date(closeEv.timestamp * 1000).toISOString();
    if (!result.closeTxHash) result.closeTxHash = closeEv.txHash || null;
    if (closeEv.blockNumber) result.closeBlockNumber = closeEv.blockNumber;
  }
}

const _MINT_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  "nft-mint-date-cache.json",
);
const _mintCache = new Map();

/** Load disk mint cache into memory on first use. */
function _loadMintCache() {
  if (_mintCache.size > 0) return;
  try {
    const raw = JSON.parse(fs.readFileSync(_MINT_CACHE_PATH, "utf8"));
    for (const [k, v] of Object.entries(raw)) _mintCache.set(k, v);
  } catch {
    /* no file or corrupt — start empty */
  }
}

/** Persist in-memory mint cache to disk. */
function _saveMintCache() {
  try {
    fs.mkdirSync(path.dirname(_MINT_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      _MINT_CACHE_PATH,
      JSON.stringify(Object.fromEntries(_mintCache), null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Look up NFT's original mint timestamp via Transfer(from=0x0) on-chain.
 * Results are cached to disk (`tmp/nft-mint-date-cache.json`)
 * and in memory to avoid repeated full-chain scans.
 * @param {object} result   Result object to supplement.
 * @param {string} tokenId  NFT token ID.
 */
async function _supplementMintFromChain(result, tokenId) {
  _loadMintCache();
  const cached = _mintCache.get(String(tokenId));
  if (cached) {
    result.mintDate = result.mintDate || cached.mintDate;
    result.mintTxHash = result.mintTxHash || cached.txHash;
    return;
  }
  try {
    const ethers = require("ethers");
    const prov = new ethers.JsonRpcProvider(config.RPC_URL);
    const iface = new ethers.Interface(PM_ABI);
    /* Search recent blocks only — NFTs are minted within
       the last ~5 years max (~15.8M blocks on PulseChain). */
    const latest = await prov.getBlockNumber();
    const from = Math.max(0, latest - 15_800_000);
    const logs = await prov.getLogs({
      address: config.POSITION_MANAGER,
      fromBlock: from,
      toBlock: "latest",
      topics: [
        iface.getEvent("Transfer").topicHash,
        "0x" + "0".repeat(64),
        null,
        "0x" + BigInt(tokenId).toString(16).padStart(64, "0"),
      ],
    });
    if (!logs.length) return;
    const block = await prov.getBlock(logs[0].blockNumber);
    if (!block) return;
    result.mintDate = new Date(block.timestamp * 1000).toISOString();
    result.mintTxHash = result.mintTxHash || logs[0].transactionHash;
    _mintCache.set(String(tokenId), {
      mintDate: result.mintDate,
      txHash: logs[0].transactionHash,
    });
    _saveMintCache();
    console.log(
      "[history] Mint date from chain for #" + tokenId + ": " + result.mintDate,
    );
  } catch (err) {
    console.warn("[history] On-chain mint lookup failed:", err.message);
  }
}

/**
 * Fetch ERC-20 decimals with caching.
 * @param {string} tokenAddr  Token contract address.
 * @param {object} provider   ethers.js provider.
 * @returns {Promise<number>} Token decimals (defaults to 18 on failure).
 */
async function _getDecimals(tokenAddr, provider) {
  const key = tokenAddr.toLowerCase();
  if (_decimalsCache.has(key)) return _decimalsCache.get(key);
  try {
    const ethers = require("ethers");
    const tok = new ethers.Contract(
      tokenAddr,
      ["function decimals() view returns (uint8)"],
      provider,
    );
    const d = Number(await tok.decimals());
    _decimalsCache.set(key, d);
    return d;
  } catch {
    _decimalsCache.set(key, 18);
    return 18;
  }
}

/**
 * Read token0/token1 addresses from the NFT's positions() slot.
 * @param {string} tokenId  NFT token ID.
 * @param {object} provider ethers.js provider.
 * @returns {Promise<{token0: string, token1: string}|null>}
 */
async function _getPositionTokens(tokenId, provider) {
  try {
    const ethers = require("ethers");
    const pm = new ethers.Contract(config.POSITION_MANAGER, PM_ABI, provider);
    const pos = await pm.positions(tokenId);
    return { token0: pos.token0, token1: pos.token1 };
  } catch (err) {
    console.warn(
      "[history] positions() lookup failed for #" + tokenId + ":",
      err.message,
    );
    return null;
  }
}

/**
 * Parse a TX receipt for IncreaseLiquidity or Collect events matching tokenId.
 * @param {string} txHash    Transaction hash.
 * @param {string} eventName 'IncreaseLiquidity' or 'Collect'.
 * @param {string} tokenId   NFT token ID to match.
 * @param {object} provider  ethers.js provider.
 * @returns {Promise<{amount0: bigint, amount1: bigint}|null>}
 */
async function _parseEventFromReceipt(txHash, eventName, tokenId, provider) {
  try {
    const ethers = require("ethers");
    const iface = new ethers.Interface(PM_ABI);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return null;
    const gasWei =
      (receipt.gasUsed ?? 0n) *
      (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
    const tid = BigInt(tokenId);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== config.POSITION_MANAGER.toLowerCase())
        continue;
      try {
        const parsed = iface.parseLog({
          topics: log.topics,
          data: log.data,
        });
        if (parsed.name !== eventName) continue;
        if (BigInt(parsed.args.tokenId) !== tid) continue;
        return {
          amount0: parsed.args.amount0,
          amount1: parsed.args.amount1,
          gasWei,
        };
      } catch {
        /* not our event */
      }
    }
    return { amount0: null, amount1: null, gasWei };
  } catch (err) {
    console.warn(
      "[history] Receipt parse failed for " + eventName + " in " + txHash + ":",
      err.message,
    );
    return null;
  }
}

/** Fetch gas cost from a TX receipt. */
async function _receiptGasWei(txHash, provider) {
  if (!txHash) return 0n;
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return 0n;
    return (
      (receipt.gasUsed ?? 0n) *
      (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n)
    );
  } catch {
    return 0n;
  }
}

/**
 * Search on-chain for the last occurrence of an event for a tokenId.
 * @param {string} eventName 'Collect' or 'DecreaseLiquidity'.
 * @param {string} tokenId   NFT token ID.
 * @param {object} provider  ethers.js provider.
 * @returns {Promise<{amount0: bigint, amount1: bigint}|null>}
 */
async function _findLastEventOnChain(eventName, tokenId, provider) {
  try {
    const ethers = require("ethers");
    const iface = new ethers.Interface(PM_ABI);
    const tid = BigInt(tokenId);
    const logs = await provider.getLogs({
      address: config.POSITION_MANAGER,
      fromBlock: 0,
      toBlock: "latest",
      topics: [
        iface.getEvent(eventName).topicHash,
        "0x" + tid.toString(16).padStart(64, "0"),
      ],
    });
    if (!logs.length) return null;
    const last = logs[logs.length - 1];
    const parsed = iface.parseLog({
      topics: last.topics,
      data: last.data,
    });
    return { amount0: parsed.args.amount0, amount1: parsed.args.amount1 };
  } catch (err) {
    console.warn(
      "[history] On-chain " +
        eventName +
        " lookup failed for #" +
        tokenId +
        ":",
      err.message,
    );
    return null;
  }
}

/**
 * Convert raw token amounts + USD prices into a dollar value.
 * @param {bigint} amount0  Raw amount0 from event.
 * @param {bigint} amount1  Raw amount1 from event.
 * @param {number} dec0     Token0 decimals.
 * @param {number} dec1     Token1 decimals.
 * @param {number} price0   Token0 USD price.
 * @param {number} price1   Token1 USD price.
 * @returns {number} Total USD value.
 */
function _computeUsdValue(amount0, amount1, dec0, dec1, price0, price1) {
  const human0 = Number(amount0) / 10 ** dec0;
  const human1 = Number(amount1) / 10 ** dec1;
  return human0 * price0 + human1 * price1;
}

/**
 * Extract token amounts from mint/close TX receipts and compute USD values.
 * Requires txHashes and token prices to already be populated in the result.
 * @param {object} result   History result to supplement in-place.
 * @param {string} tokenId  NFT token ID.
 */
/** Extract entry value + gas from the mint TX receipt. Returns mint gas (BigInt). */
async function _supplementEntryFromChain(result, tokenId, dec0, dec1, prov) {
  const amounts = await _parseEventFromReceipt(
    result.mintTxHash,
    "IncreaseLiquidity",
    tokenId,
    prov,
  );
  if (!amounts) return 0n;
  if (amounts.amount0 !== null && amounts.amount0 !== undefined) {
    result.entryAmount0 = Number(amounts.amount0) / 10 ** dec0;
    result.entryAmount1 = Number(amounts.amount1) / 10 ** dec1;
    result.entryValueUsd = _computeUsdValue(
      amounts.amount0,
      amounts.amount1,
      dec0,
      dec1,
      result.token0UsdPriceAtOpen,
      result.token1UsdPriceAtOpen,
    );
    console.log(
      "[history] Entry value from chain for #%s: $%s",
      tokenId,
      result.entryValueUsd.toFixed(2),
    );
  }
  return amounts.gasWei || 0n;
}

async function _supplementAmountsFromChain(result, tokenId) {
  const needEntry =
    !result.entryValueUsd && result.mintTxHash && result.token0UsdPriceAtOpen;
  const needExit = !result.exitValueUsd && result.token0UsdPriceAtClose;
  if (!needEntry && !needExit) return;

  const ethers = require("ethers");
  const prov = new ethers.JsonRpcProvider(config.RPC_URL);
  const tokens = await _getPositionTokens(tokenId, prov);
  if (!tokens) return;
  const [dec0, dec1] = await Promise.all([
    _getDecimals(tokens.token0, prov),
    _getDecimals(tokens.token1, prov),
  ]);

  const mintGasWei = needEntry
    ? await _supplementEntryFromChain(result, tokenId, dec0, dec1, prov)
    : 0n;
  if (needExit) {
    const collected = await _findLastEventOnChain("Collect", tokenId, prov);
    if (collected) {
      result.exitValueUsd = _computeUsdValue(
        collected.amount0,
        collected.amount1,
        dec0,
        dec1,
        result.token0UsdPriceAtClose,
        result.token1UsdPriceAtClose,
      );
      console.log(
        "[history] Exit value from chain for #" +
          tokenId +
          ": $" +
          result.exitValueUsd.toFixed(2),
      );
      if (!result.feesEarnedUsd) {
        const decreased = await _findLastEventOnChain(
          "DecreaseLiquidity",
          tokenId,
          prov,
        );
        if (decreased) {
          const fee0 = collected.amount0 - decreased.amount0;
          const fee1 = collected.amount1 - decreased.amount1;
          result.feesEarnedUsd = _computeUsdValue(
            fee0 > 0n ? fee0 : 0n,
            fee1 > 0n ? fee1 : 0n,
            dec0,
            dec1,
            result.token0UsdPriceAtClose,
            result.token1UsdPriceAtClose,
          );
          console.log(
            "[history] Fees from chain for #" +
              tokenId +
              ": $" +
              result.feesEarnedUsd.toFixed(2),
          );
        }
      }
    }
  }
  if (!result.gasCostWei)
    await _supplementGasFromChain(result, mintGasWei, prov);
}

/** Extract rebalance gas from mint + close TX receipts. */
async function _supplementGasFromChain(result, mintGasWei, prov) {
  let totalGas = mintGasWei;
  if (!totalGas && result.mintTxHash)
    totalGas += await _receiptGasWei(result.mintTxHash, prov);
  if (result.closeTxHash)
    totalGas += await _receiptGasWei(result.closeTxHash, prov);
  if (totalGas > 0n) result.gasCostWei = String(totalGas);
}

/**
 * Resolve pool address via the V3 Factory.
 * Uses activePosition if available, otherwise reads positions(tokenId) on-chain.
 * @param {object|null} activePosition  Bot's active position (token0, token1, fee).
 * @param {string}      tokenId         NFT token ID (fallback source).
 * @returns {Promise<string|null>}
 */
async function _resolvePoolAddress(activePosition, tokenId) {
  const ethers = require("ethers");
  const prov = new ethers.JsonRpcProvider(config.RPC_URL);
  let pos = activePosition;
  if (!pos || !pos.token0 || !pos.token1 || !pos.fee) {
    pos = await _getPositionTokens(tokenId, prov);
    if (!pos) return null;
    // positions() returns {token0, token1} but not fee — read full struct
    const pm = new ethers.Contract(config.POSITION_MANAGER, PM_ABI, prov);
    try {
      const full = await pm.positions(tokenId);
      pos = {
        token0: full.token0,
        token1: full.token1,
        fee: Number(full.fee),
      };
    } catch {
      return null;
    }
  }
  try {
    const factory = new ethers.Contract(
      config.FACTORY,
      ["function getPool(address,address,uint24) view returns (address)"],
      prov,
    );
    const addr = await factory.getPool(pos.token0, pos.token1, pos.fee);
    return addr && addr !== ethers.ZeroAddress ? addr : null;
  } catch {
    return null;
  }
}

/**
 * Fill missing token prices from GeckoTerminal when dates are available.
 * @param {object} result          History result to supplement in-place.
 * @param {object} activePosition  Bot's active position.
 */
async function _supplementHistoricalPrices(result, activePosition) {
  const needOpen = result.mintDate && !result.token0UsdPriceAtOpen;
  const needClose = result.closeDate && !result.token0UsdPriceAtClose;
  if (!needOpen && !needClose) return;
  const pool = await _resolvePoolAddress(activePosition, result.tokenId);
  if (!pool) return;
  const tokenOpts = activePosition
    ? {
        token0Address: activePosition.token0,
        token1Address: activePosition.token1,
      }
    : {};
  const fill = async (date, k0, k1, blockNumber) => {
    const ts = Math.floor(new Date(date).getTime() / 1000);
    const p = await fetchHistoricalPriceGecko(pool, ts, "pulsechain", {
      ...tokenOpts,
      blockNumber,
    });
    if (p.price0 > 0) result[k0] = p.price0;
    if (p.price1 > 0) result[k1] = p.price1;
  };
  if (needOpen)
    await fill(
      result.mintDate,
      "token0UsdPriceAtOpen",
      "token1UsdPriceAtOpen",
      result.mintBlockNumber,
    );
  if (needClose)
    await fill(
      result.closeDate,
      "token0UsdPriceAtClose",
      "token1UsdPriceAtClose",
      result.closeBlockNumber,
    );
}

/**
 * Look up historical data for a closed NFT position.
 * Combines rebalance log, on-chain events, chain mint lookup, GeckoTerminal
 * prices, and TX receipt parsing (IncreaseLiquidity / Collect).
 * @param {string}   tokenId         NFT token ID.
 * @param {object}   opts
 * @param {object[]} opts.rebalanceEvents  From the event scanner.
 * @param {object}   opts.activePosition   Bot's active position (for pool lookup).
 * @param {object}   [opts.fallbackPrices] Current prices {price0, price1} used when historical unavailable.
 * @returns {Promise<object>}  Historical data (null fields where unavailable).
 */
async function getPositionHistory(tokenId, opts = {}) {
  const result = {
    tokenId,
    mintEntry: null,
    closeEntry: null,
    mintDate: null,
    closeDate: null,
    entryValueUsd: null,
    exitValueUsd: null,
    token0UsdPriceAtOpen: null,
    token1UsdPriceAtOpen: null,
    token0UsdPriceAtClose: null,
    token1UsdPriceAtClose: null,
    entryAmount0: null,
    entryAmount1: null,
    feesEarnedUsd: null,
    gasCostWei: null,
    mintTxHash: null,
    closeTxHash: null,
  };
  const entries = _readRebalanceLog();
  const mint = entries.find((e) => String(e.newTokenId) === String(tokenId));
  const close = entries.find((e) => String(e.oldTokenId) === String(tokenId));
  if (mint) _applyMintEntry(result, mint);
  if (close) _applyCloseEntry(result, close);

  _supplementFromEvents(result, tokenId, opts.rebalanceEvents);
  if (!result.mintDate) {
    const _t1 = Date.now();
    await _supplementMintFromChain(result, tokenId);
    console.log(
      "[history] _supplementMintFromChain #%s: %dms",
      tokenId,
      Date.now() - _t1,
    );
  }
  const _t2 = Date.now();
  await _supplementHistoricalPrices(result, opts.activePosition);
  console.log(
    "[history] _supplementHistoricalPrices #%s: %dms",
    tokenId,
    Date.now() - _t2,
  );
  // Fill remaining null prices from current prices (better than no data)
  if (opts.fallbackPrices) {
    const fb = opts.fallbackPrices;
    if (!result.token0UsdPriceAtOpen && fb.price0 > 0)
      result.token0UsdPriceAtOpen = fb.price0;
    if (!result.token1UsdPriceAtOpen && fb.price1 > 0)
      result.token1UsdPriceAtOpen = fb.price1;
    if (!result.token0UsdPriceAtClose && fb.price0 > 0)
      result.token0UsdPriceAtClose = fb.price0;
    if (!result.token1UsdPriceAtClose && fb.price1 > 0)
      result.token1UsdPriceAtClose = fb.price1;
  }
  const _t3 = Date.now();
  await _supplementAmountsFromChain(result, tokenId);
  console.log(
    "[history] _supplementAmountsFromChain #%s: %dms",
    tokenId,
    Date.now() - _t3,
  );
  return result;
}

module.exports = { getPositionHistory };
