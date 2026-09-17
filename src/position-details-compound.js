/**
 * @file position-details-compound.js
 * @description Compound-detection helpers for the unmanaged-position
 *   details flow. Extracted from position-details.js to keep that file
 *   under the 500-line cap. Provides:
 *   - _scanCompounds: whole-chain classification over the request's
 *     shared chain read, returning { total, current, currentGasUsd }
 *   - _detectCurrentNftValues: cheap one-NFT scan returning { compoundUsd, gasUsd }
 *   - _resolveCompounded: cache-first wrapper used by computeLifetimeDetails
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const { getPositionConfig, saveConfig } = require("./bot-config-v2");
const { detectCompoundsOnChain, classifyCompounds } = require("./compounder");
const { actualGasCostUsd } = require("./bot-pnl-updater");
const { eventsFor } = require("./nft-events-batch");
const { collectTokenIds } = require("./bot-recorder-scan-helpers");
const { poolCreationFloor } = require("./position-details-chain-read");
const {
  mintBlocksByTokenId,
  scanFloorFor,
  chainScanFloor,
} = require("./nft-mint-blocks");

/*- Convert a chain-scan result for a single NFT into Current-panel
 *  values: standalone-compound USD (sum of per-event usdValue) and
 *  total NFT gas USD (mint TX + standalone compound TXs, valued at
 *  current native-token price). Both metrics match what the managed
 *  liveEpoch surfaces while the bot is running. */
async function _currentValuesFromScan(r) {
  const compoundUsd = (r.compounds || []).reduce(
    (s, c) => s + (c.usdValue || 0),
    0,
  );
  const gasUsd = r.totalNftGasWei
    ? await actualGasCostUsd(BigInt(r.totalNftGasWei))
    : 0;
  return { compoundUsd, gasUsd };
}

/**
 * Classify compounds across all NFTs in the rebalance chain and cache result.
 * Returns `{ total, current, currentGasUsd }` — total is lifetime across
 * the chain; current is the current NFT's own compounded value (used by the
 * Current panel's "Fees Compounded" row).
 *
 * The events come from the request's shared chain read, which the lifetime
 * HODL scan reads from too — see `position-details-chain-read.js`.
 *
 * @param {object} position
 * @param {object[]} events  Rebalance events.
 * @param {object} body  Request body with `walletAddress`.
 * @param {object} ps  Pool state (decimals).
 * @param {{price0: number, price1: number}} prices
 * @param {object} diskConfig
 * @param {string} posKey
 * @param {() => Promise<Map<string, object>>} readChainEvents  The
 *   request's chain reader, from `chainEventsReader`.
 * @param {string} [dir]  Config directory (tests).
 * @param {Function} [_classify]  Injectable for tests; defaults to
 *   `classifyCompounds`.
 * @returns {Promise<{total: number, current: number, currentGasUsd: number}>}
 */
async function _scanCompounds(
  position,
  events,
  body,
  ps,
  prices,
  diskConfig,
  posKey,
  readChainEvents,
  dir,
  _classify = classifyCompounds,
) {
  try {
    const ids = collectTokenIds(position, events);
    const opts = {
      positionManagerAddress: config.POSITION_MANAGER,
      token0: position.token0,
      token1: position.token1,
      token0Symbol: position.token0Symbol,
      token1Symbol: position.token1Symbol,
      fee: position.fee,
      wallet: body.walletAddress,
      price0: prices.price0,
      price1: prices.price1,
      decimals0: ps.decimals0,
      decimals1: ps.decimals1,
    };
    const batch = await readChainEvents();
    /*- total = lifetime collected fees across the rebalance chain
     *  (Lifetime panel "Fees Compounded"). current = sum of standalone
     *  compound deposit values for the current NFT only (Current panel
     *  "Fees Compounded") — matches bot-recorder-lifetime's compound-
     *  History/usdValue model so managed and unmanaged agree.
     *  currentGasUsd = mint + standalone compound gas for the current
     *  NFT, valued at current native price. */
    let total = 0;
    let current = 0;
    let currentGasUsd = 0;
    const curId = String(position.tokenId);
    for (const tid of ids) {
      /*-
       *  `eventsFor` throws for an NFT the read did not cover, rather
       *  than answering "no compounds" for it.
       */
      const nftEvents = eventsFor(batch, tid);
      const r = await _classify(nftEvents, { ...opts, tokenId: tid });
      total += r.totalCompoundedUsd;
      if (tid === curId) {
        const cv = await _currentValuesFromScan(r);
        current = cv.compoundUsd;
        currentGasUsd = cv.gasUsd;
      }
    }
    if (total > 0) {
      /*- Skip the disk write when there's no existing slot for this
       *  position — only managed positions own disk state.  Prior
       *  lazy-create produced phantom stubs for unmanaged positions
       *  whose details endpoint was invoked from the dashboard. */
      const pos = getPositionConfig(diskConfig, posKey);
      if (pos) {
        pos.totalCompoundedUsd = total;
        saveConfig(diskConfig, dir);
      }
    }
    return { total, current, currentGasUsd };
  } catch (e) {
    log.warn("[position details] compound detection failed:", e.message);
    return { total: 0, current: 0, currentGasUsd: 0 };
  }
}

/*- Detect Current-panel values for the current NFT only (one scan):
 *  standalone compound USD and total NFT gas USD.  Bounded to the
 *  current NFT's own mint block when the rebalance chain supplies it —
 *  this is the warm-cache path, so it runs on every lifetime request,
 *  and from the pool's creation block it was scanning years of blocks
 *  for an NFT that is usually days old. */
async function _detectCurrentNftValues(
  position,
  body,
  ps,
  prices,
  events,
  _detect = detectCompoundsOnChain,
) {
  try {
    /*- The pool-creation lookup is only reached when the chain does not
     *  name this NFT's mint.  Written as a branch rather than as an
     *  argument to `scanFloorFor`, because an argument is evaluated
     *  eagerly — which billed this warm path an RPC round-trip on every
     *  lifetime request for a floor it then discarded. */
    const mintBlocks = mintBlocksByTokenId(events);
    let fromBlock = scanFloorFor(mintBlocks, position.tokenId, null);
    if (fromBlock === null) {
      /*- Never-rebalanced position: this NFT IS the chain's first mint,
       *  so lift the pool floor to it rather than scanning from pool
       *  creation. */
      const creationBlock = await poolCreationFloor(ps.poolAddress);
      fromBlock = chainScanFloor(events, creationBlock);
    }
    const opts = {
      positionManagerAddress: config.POSITION_MANAGER,
      token0: position.token0,
      token1: position.token1,
      token0Symbol: position.token0Symbol,
      token1Symbol: position.token1Symbol,
      fee: position.fee,
      wallet: body.walletAddress,
      price0: prices.price0,
      price1: prices.price1,
      decimals0: ps.decimals0,
      decimals1: ps.decimals1,
      fromBlock,
    };
    const r = await _detect(String(position.tokenId), opts);
    return await _currentValuesFromScan(r);
  } catch (e) {
    log.warn(
      "[position details] current-NFT values detection failed:",
      e.message,
    );
    return { compoundUsd: 0, gasUsd: 0 };
  }
}

/**
 * The Fees Compounded total saved for the position, or null when none
 * is. A zero total counts as none: it records nothing a read would not
 * reproduce.
 *
 * @param {object} diskConfig
 * @param {string} posKey
 * @returns {number|null}
 */
function _savedCompoundTotal(diskConfig, posKey) {
  const saved = diskConfig.positions[posKey]?.totalCompoundedUsd;
  return typeof saved === "number" && saved > 0 ? saved : null;
}

/**
 * Whether this request takes Fees Compounded from the whole chain rather
 * than from disk: no total is saved for the position, and there is a chain
 * to read.
 *
 * `_resolveCompounded` takes the chain path exactly when this is true, and
 * `computeLifetimeDetails` asks it ahead of the pool scan, to decide
 * whether epoch reconstruction can share that read.
 *
 * @param {object} diskConfig
 * @param {string} posKey
 * @param {Array} events  Rebalance events.
 * @returns {boolean}
 */
function compoundsReadChain(diskConfig, posKey, events) {
  return _savedCompoundTotal(diskConfig, posKey) === null && events.length > 0;
}

/**
 * Resolve compounded USD from the saved total or a chain read.
 *
 * `total` is the lifetime compounded across the rebalance chain (Lifetime
 * panel). `current` is the current NFT's standalone-compound USD, and
 * `currentGasUsd` is the current NFT's total gas (mint + standalone
 * compounds). The Current panel reads those two; without them it would
 * show a dash on unmanaged positions even when the values are material.
 *
 * @param {object} position
 * @param {object[]} events  Rebalance events.
 * @param {object} body  Request body with `walletAddress`.
 * @param {object} ps  Pool state.
 * @param {{price0: number, price1: number}} prices
 * @param {object} diskConfig
 * @param {string} posKey
 * @param {() => Promise<Map<string, object>>} readChainEvents  The
 *   request's shared chain reader, read only on the full-chain path.
 * @returns {Promise<{total: number, current: number, currentGasUsd: number}>}
 */
async function _resolveCompounded(
  position,
  events,
  body,
  ps,
  prices,
  diskConfig,
  posKey,
  readChainEvents,
) {
  if (compoundsReadChain(diskConfig, posKey, events)) {
    return _scanCompounds(
      position,
      events,
      body,
      ps,
      prices,
      diskConfig,
      posKey,
      readChainEvents,
    );
  }
  const saved = _savedCompoundTotal(diskConfig, posKey);
  // No saved total and no rebalance events: all zero, and nothing read.
  if (saved === null) return { total: 0, current: 0, currentGasUsd: 0 };
  /*- Cache hit on the lifetime total — still need a one-NFT scan for
   *  the current values, which are not cached on disk.  One NFT
   *  rather than the whole chain, and bounded to that NFT's own life
   *  by the events passed through. */
  const cv = await _detectCurrentNftValues(position, body, ps, prices, events);
  return {
    total: saved,
    current: cv.compoundUsd,
    currentGasUsd: cv.gasUsd,
  };
}

module.exports = {
  compoundsReadChain,
  _scanCompounds,
  _detectCurrentNftValues,
  _resolveCompounded,
};
