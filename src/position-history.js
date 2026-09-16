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

const { log } = require("./log");
const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const config = require("./config");
const sendTx = require("./send-transaction");
const { PM_ABI } = require("./pm-abi");
const { fetchHistoricalPriceGecko } = require("./price-fetcher");
const {
  scanCollectAndDrain,
  resolveScanFromBlock,
} = require("./position-history-scan-helpers");
const { nftScanFromBlock } = require("./nft-mint-blocks");
const { supplementMintFromChain } = require("./position-history-mint");
const { lifetimeFeeAmounts } = require("./compounder");

/*- Cached at module load: parsing PM logs is stateless, so a single Interface
    instance can serve every call.  Built from whichever ethers binding is in
    scope when this file is first required (tests patch Module.prototype.require
    to inject a stub before loading). */
const _IFACE = new ethers.Interface(PM_ABI);

/** In-memory cache for ERC-20 decimals keyed by lowercase address. */
const _decimalsCache = new Map();

/** Read and parse the rebalance log from disk. */
function _readRebalanceLog() {
  try {
    const raw = fs.readFileSync(
      path.join(
        process.cwd(),
        config.LOG_FILE || "app-data/rebalance_log.json",
      ),
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
 * Supply the mint of the one position NFT no rebalance event can name.
 *
 * A rebalance records "NFT X replaced by NFT Y at block B", so Y's mint
 * block is B. The earliest NFT in the inferred chain appears only as an
 * `oldTokenId` — it replaced nothing — so nothing names its mint, and it
 * would otherwise be read from chain: a scan of the pool's whole history
 * for one Transfer log.
 *
 * The event scanner already saw that mint. `resolveChainFirstMint`
 * records the earliest arrival that was a mint, which by construction is
 * that NFT, and hangs it on the events array this function receives.
 *
 * Two id-gated sources, in order of preference:
 *
 *   - `chainFirst*` — recorded for this purpose; the id always matches.
 *   - `firstMint*` — the oldest NFT the wallet ever held here, kept for
 *     Lifetime Days. Names the same NFT only when every arrival in the
 *     pool was a mint; a transferred-in NFT makes it a different one.
 *     Present on caches written before `chainFirst*` existed.
 *
 * Both are gated on the id because using the wrong one would date this
 * NFT from another NFT's mint. No match falls through to the chain read.
 *
 * @param {object} result   Result object to supplement.
 * @param {string} tokenId  Position NFT token ID.
 * @param {Array & {chainFirstTokenId?: string, chainFirstMintBlock?: number,
 *   chainFirstMintTimestamp?: number, firstMintTokenId?: string,
 *   firstMintTimestamp?: number, firstMintBlockNumber?: number}} events
 */
function _applyFirstMint(result, tokenId, events) {
  /*- Preferred: the field that names this NFT directly.  It is recorded
   *  for exactly this purpose, so the id always matches and no fallback
   *  is reached. */
  if (String(events.chainFirstTokenId || "") === String(tokenId)) {
    _stampMint(
      result,
      events.chainFirstMintTimestamp,
      events.chainFirstMintBlock,
    );
    return;
  }
  /*- A cache written before that field existed carries only the
   *  oldest-held NFT's mint, which names this NFT whenever every arrival
   *  in the pool was a mint.  Same id check, for the same reason. */
  if (String(events.firstMintTokenId || "") !== String(tokenId)) return;
  _stampMint(result, events.firstMintTimestamp, events.firstMintBlockNumber);
}

/** Record a mint date and block without overwriting a known value. */
function _stampMint(result, timestamp, blockNumber) {
  if (!result.mintDate && timestamp)
    result.mintDate = new Date(timestamp * 1000).toISOString();
  if (!result.mintBlockNumber && blockNumber)
    result.mintBlockNumber = blockNumber;
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
  } else {
    _applyFirstMint(result, tokenId, events);
  }
  const closeEv = events.find((e) => String(e.oldTokenId) === String(tokenId));
  if (closeEv) {
    if (!result.closeDate && closeEv.timestamp)
      result.closeDate = new Date(closeEv.timestamp * 1000).toISOString();
    if (!result.closeTxHash) result.closeTxHash = closeEv.txHash || null;
    if (closeEv.blockNumber) result.closeBlockNumber = closeEv.blockNumber;
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
    const pm = new ethers.Contract(config.POSITION_MANAGER, PM_ABI, provider);
    const pos = await pm.positions(tokenId);
    return { token0: pos.token0, token1: pos.token1 };
  } catch (err) {
    log.warn(
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
        const parsed = _IFACE.parseLog({
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
    log.warn(
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
    log.info(
      "[history] Entry value from chain for #%s: $%s",
      tokenId,
      result.entryValueUsd.toFixed(2),
    );
  }
  return amounts.gasWei || 0n;
}

/**
 * Whether the mint receipt still has to be read.
 *
 * `_supplementEntryFromChain` is the only source of `entryAmount0/1` —
 * the deposited token amounts that IL is measured against — and it also
 * happens to compute `entryValueUsd`.  This asks for BOTH, separately.
 *
 * Asking only `!result.entryValueUsd` would let one need stand in for
 * the other, and the two are not equivalent: when the bot rebalances a
 * position itself it writes the USD value to `rebalance_log.json` and
 * `_applyMintEntry` reads it back, so `entryValueUsd` is already
 * present while the amounts are not.  The receipt fetch would be
 * skipped, `_assembleEpoch` would store `hodlAmount0/1: 0`, and
 * per-epoch IL would come out as the whole position value rather than
 * a loss — on bot-handled positions only.
 *
 * @param {object} result  History result being assembled.
 * @returns {boolean}
 */
function needsEntryFromChain(result) {
  const missingAmounts =
    result.entryAmount0 === null || result.entryAmount0 === undefined;
  return Boolean(
    (!result.entryValueUsd || missingAmounts) &&
    result.mintTxHash &&
    result.token0UsdPriceAtOpen,
  );
}

/**
 * This NFT's Collect and DecreaseLiquidity history — the one read that
 * both its exit value and its lifetime fees are derived from.
 *
 * Taken as given when the caller already read it along with the rest of
 * its rebalance chain (epoch reconstruction — see
 * `scanChainCollectAndDrain`).  That includes a given null, which says
 * the chain read could not be trusted: reading again here would repeat,
 * one NFT at a time, the very walk the chain read exists to avoid.
 *
 * Read here only when nothing was supplied, which is a single closed
 * position looked at on its own.  That read is floored at the NFT's own
 * mint, since it cannot emit before it exists, and runs to the chain
 * head with no upper bound.  One would have to come from the app's
 * inferred succession, which reads consecutive mints as successive
 * rebalances — sound only when every mint in the pool IS a rebalance.
 * A dust mint from a failed or partial rebalance looks identical in the
 * Transfer log, so the NFT it appears to replace can still be funded and
 * drain later; bounding there truncates the scan and loses the drain.
 *
 * @param {object} result  History result being assembled.
 * @param {string} tokenId  NFT token ID.
 * @param {object} prov  ethers.js provider.
 * @param {{collectEvents: Array, dlEvents: Array}|null} [prefetched]
 *   The history from a chain read, null when that read was unusable, or
 *   undefined when there was none.
 * @returns {Promise<{collectEvents: Array, dlEvents: Array}|null>}
 */
async function _readCollectAndDrain(result, tokenId, prov, prefetched) {
  if (prefetched !== undefined) return prefetched;
  const poolFloor = await resolveScanFromBlock(prov, ethers, tokenId);
  const from = nftScanFromBlock({
    mintBlock: result.mintBlockNumber,
    sharedFloor: poolFloor,
  });
  return scanCollectAndDrain(tokenId, prov, from);
}

/**
 * Extract token amounts from chain and compute USD values: the entry
 * from the mint TX receipt, the exit value and lifetime fees from the
 * NFT's Collect/DecreaseLiquidity history, and gas from the receipts.
 * Requires txHashes and token prices to already be populated in the result.
 * @param {object} result   History result to supplement in-place.
 * @param {string} tokenId  NFT token ID.
 * @param {{collectEvents: Array, dlEvents: Array}|null} [collectAndDrain]
 *   See `getPositionHistory`'s `opts.collectAndDrain`.
 */
async function _supplementAmountsFromChain(result, tokenId, collectAndDrain) {
  const needEntry = needsEntryFromChain(result);
  const needExit = !result.exitValueUsd && result.token0UsdPriceAtClose;
  /*- Fees are re-derived from the chain for every closed NFT whose close
   *  prices are known — including the ones the rebalance log already
   *  supplied a figure for, because that figure is the understated one.
   *  See _supplementFeesFromChain. */
  const needFees = !!(
    result.token0UsdPriceAtClose && result.token1UsdPriceAtClose
  );
  if (!needEntry && !needExit && !needFees) return;

  const prov = sendTx.getManagedReadProvider();
  const tokens = await _getPositionTokens(tokenId, prov);
  if (!tokens) return;
  const [dec0, dec1] = await Promise.all([
    _getDecimals(tokens.token0, prov),
    _getDecimals(tokens.token1, prov),
  ]);

  const mintGasWei = needEntry
    ? await _supplementEntryFromChain(result, tokenId, dec0, dec1, prov)
    : 0n;
  if (needExit || needFees) {
    /*- One read serves both consumers below — see scanCollectAndDrain. */
    const scan = await _readCollectAndDrain(
      result,
      tokenId,
      prov,
      collectAndDrain,
    );
    if (scan) {
      const ctx = { tokenId, dec0, dec1, scan };
      if (needExit) _supplementExitFromChain(result, ctx);
      if (needFees) _supplementFeesFromChain(result, ctx);
    }
  }
  if (!result.gasCostWei)
    await _supplementGasFromChain(result, mintGasWei, prov);
}

/** Exit value from the NFT's final Collect, valued at close prices. */
function _supplementExitFromChain(result, ctx) {
  const { tokenId, dec0, dec1, scan } = ctx;
  const collected = scan.collectEvents[scan.collectEvents.length - 1];
  if (!collected) return;
  if (!result.closeBlockNumber && collected.blockNumber)
    result.closeBlockNumber = collected.blockNumber;
  result.exitValueUsd = _computeUsdValue(
    collected.amount0,
    collected.amount1,
    dec0,
    dec1,
    result.token0UsdPriceAtClose,
    result.token1UsdPriceAtClose,
  );
  log.info(
    "[history] Exit value from chain for #" +
      tokenId +
      ": $" +
      result.exitValueUsd.toFixed(2),
  );
}

/**
 * Fees this NFT earned across its whole life, valued at its close prices.
 *
 * Must be measured across every Collect, not as
 * `Collect(last) − DecreaseLiquidity(last)`.  That last-drain pair sees
 * only the fees still unclaimed when the NFT was drained; anything
 * compounded before then was already swept out and folded back into
 * liquidity, so it leaves again inside the drain's DecreaseLiquidity
 * and is subtracted straight back out.  With auto-compound on that is
 * most of what a position earns — a measured case summed to $149 of a
 * lifetime $1,084.
 *
 * An understated figure would reach the Per-Day P&L table twice: once
 * in the Fees column, and again in Price P&L, which is
 * `exit − entry − fees` and would credit the missing fees to price
 * movement.  Net P&L is unaffected either way, so the error moves money
 * between two columns without changing the total.
 *
 * A logged value is left alone when the scan cannot see the NFT's
 * history, so a failed query reads as "nothing better to offer" rather
 * than overwriting a real number with zero.
 */
function _supplementFeesFromChain(result, ctx) {
  const { tokenId, dec0, dec1, scan } = ctx;
  const fees = lifetimeFeeAmounts(scan.collectEvents, scan.dlEvents);
  result.feesEarnedUsd = _computeUsdValue(
    fees.fees0,
    fees.fees1,
    dec0,
    dec1,
    result.token0UsdPriceAtClose,
    result.token1UsdPriceAtClose,
  );
  log.info(
    "[history] Lifetime fees from chain for #" +
      tokenId +
      ": $" +
      result.feesEarnedUsd.toFixed(2),
  );
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
  const prov = sendTx.getManagedReadProvider();
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
 * @param {{collectEvents: Array, dlEvents: Array}|null} [opts.collectAndDrain]
 *   This NFT's Collect/DecreaseLiquidity history, when the caller read
 *   it with the rest of its chain; null when that read was unusable.
 *   Omit it to have the history read here, for this NFT alone.
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
    await supplementMintFromChain(result, tokenId);
    log.info(
      "[history] supplementMintFromChain #%s: %dms",
      tokenId,
      Date.now() - _t1,
    );
  }
  const _t2 = Date.now();
  await _supplementHistoricalPrices(result, opts.activePosition);
  log.info(
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
  await _supplementAmountsFromChain(result, tokenId, opts.collectAndDrain);
  log.info(
    "[history] _supplementAmountsFromChain #%s: %dms",
    tokenId,
    Date.now() - _t3,
  );
  return result;
}

module.exports = { getPositionHistory, needsEntryFromChain };
