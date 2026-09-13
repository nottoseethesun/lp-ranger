/**
 * @file position-details-compound.js
 * @description Compound-detection helpers for the unmanaged-position
 *   details flow. Extracted from position-details.js to keep that file
 *   under the 500-line cap. Provides:
 *   - _scanCompounds: full chain scan returning { total, current, currentGasUsd }
 *   - _detectCurrentNftValues: cheap one-NFT scan returning { compoundUsd, gasUsd }
 *   - _resolveCompounded: cache-first wrapper used by computeLifetimeDetails
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const { getPositionConfig, saveConfig } = require("./bot-config-v2");
const { detectCompoundsOnChain } = require("./compounder");
const { actualGasCostUsd } = require("./bot-pnl-updater");
const sendTx = require("./send-transaction");
const { getPoolCreationBlockCached } = require("./pool-creation-block");
const {
  mintBlocksByTokenId,
  nftScanFrom,
  scanFloorFor,
  chainScanFloor,
  retirementBlocksByTokenId,
  nftScanTo,
} = require("./nft-mint-blocks");

/**
 * Lower bound for an NFT event scan: the pool's own creation block.
 *
 * Without one, every scan here starts at genesis — and these paths
 * loop over the whole rebalance chain, so that is one full-chain scan
 * per NFT. Chunked and paced, that would hold the global request
 * queue for hours. An NFT cannot have events before its pool existed,
 * so the creation block is both correct and tight.
 * @param {string|null|undefined} poolAddress
 * @returns {Promise<number>}  Creation block, or 0 when unknown.
 */
async function _scanFloor(poolAddress) {
  if (!poolAddress) return 0;
  try {
    return await getPoolCreationBlockCached({
      provider: sendTx.getManagedReadProvider(),
      factoryAddress: config.FACTORY,
      poolAddress,
    });
  } catch {
    /*- Unknown creation block falls back to 0.  Slow but correct is
     *  better than skipping the scan. */
    return 0;
  }
}

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
 * Detect compounds across all NFTs in the rebalance chain and cache result.
 * `_detect` is injectable for tests; defaults to the production scanner.
 * Returns `{ total, current }` — total is lifetime across the chain;
 * current is the current NFT's own compounded value (used by the
 * Current panel's "Fees Compounded" row).
 */
async function _scanCompounds(
  position,
  events,
  body,
  ps,
  prices,
  diskConfig,
  posKey,
  dir,
  _detect = detectCompoundsOnChain,
) {
  try {
    const ids = new Set([String(position.tokenId)]);
    for (const e of events) {
      if (e.oldTokenId) ids.add(String(e.oldTokenId));
      if (e.newTokenId) ids.add(String(e.newTokenId));
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
    };
    /*- Two floors.  Each NFT is scanned from its OWN mint block — it
     *  cannot emit events before it exists, and scanning those blocks
     *  anyway is what made a cold-cache lifetime scan take most of an
     *  hour once every request went through the 250 ms queue.  The
     *  chain's oldest NFT has no mint block in the events, so it falls
     *  back to `chainScanFloor`: the pool's creation block, lifted to
     *  the chain's own first mint when the scanner resolved one. */
    const creationBlock = await _scanFloor(ps.poolAddress);
    const poolFloor = chainScanFloor(events, creationBlock);
    const mintBlocks = mintBlocksByTokenId(events);
    /*- A retired NFT stops emitting when its replacement is minted, so
     *  scanning it to head re-reads everything that happened since for
     *  nothing.  The current NFT is absent from this map and keeps
     *  scanning to head. */
    const retirementBlocks = retirementBlocksByTokenId(events);
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
      const r = await _detect(tid, {
        ...opts,
        fromBlock: nftScanFrom(mintBlocks, tid, poolFloor),
        toBlock: nftScanTo(retirementBlocks, tid),
      });
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
      const creationBlock = await _scanFloor(ps.poolAddress);
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

/*- Resolve compounded USD from disk cache or chain scan.  Returns
 *  `{ total, current, currentGasUsd }`: total is the lifetime compounded
 *  across the rebalance chain (Lifetime panel); current is the current
 *  NFT's standalone-compound USD; currentGasUsd is the current NFT's
 *  total gas (mint + standalone compounds). The Current panel reads
 *  the latter two — they would otherwise render as dash on unmanaged
 *  positions even when the values are material. */
async function _resolveCompounded(
  position,
  events,
  body,
  ps,
  prices,
  diskConfig,
  posKey,
) {
  const posConfig = diskConfig.positions[posKey] || {};
  if (posConfig.totalCompoundedUsd) {
    /*- Cache hit on the lifetime total — still need a one-NFT scan for
     *  the current values, which are not cached on disk.  One NFT
     *  rather than the whole chain, and bounded to that NFT's own life
     *  by the events passed through. */
    const cv = await _detectCurrentNftValues(
      position,
      body,
      ps,
      prices,
      events,
    );
    return {
      total: posConfig.totalCompoundedUsd,
      current: cv.compoundUsd,
      currentGasUsd: cv.gasUsd,
    };
  }
  if (events.length === 0) return { total: 0, current: 0, currentGasUsd: 0 };
  return _scanCompounds(position, events, body, ps, prices, diskConfig, posKey);
}

module.exports = {
  _scanCompounds,
  _detectCurrentNftValues,
  _resolveCompounded,
};
