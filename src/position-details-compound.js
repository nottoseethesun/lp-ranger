/**
 * @file position-details-compound.js
 * @description Compound figures for the unmanaged-position details flow.
 *   Provides:
 *   - `_detectCurrentNftValues`: a one-NFT scan returning
 *     `{ compoundUsd, gasUsd }` for the Current panel.
 *   - `savedNftCompoundedUsd`: the same figure from the coins already on
 *     disk, with no scan at all.
 *
 *   Nothing here walks the rebalance chain. An unmanaged position shows
 *   no Lifetime panel, so the chain-wide classification that produced its
 *   lifetime compounded total had no reader — see the file header of
 *   `position-details.js`.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const { getPositionConfig } = require("./bot-config-v2");
const { detectCompoundsOnChain } = require("./compounder");
const { actualGasCostUsd } = require("./bot-pnl-updater");
const { poolCreationFloor } = require("./pool-creation-block");
const { nftCoinsToUsd } = require("./coin-value");
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
 * What the named NFT has compounded, from the coins already on disk.
 *
 * The cheap answer: no chain read, no scan. Both request phases use it
 * to take fee earnings out of the LP value before comparing against
 * HODL, so the IL/G an unmanaged position reports matches the managed
 * one.
 *
 * A slot with no saved coins answers zero, and stays zero for as long as
 * the position is unmanaged — only the bot's lifetime scan writes them.
 * Removing nothing is the right answer there rather than a guess: the
 * figure is the LP value as it stands, and it corrects itself the first
 * time the position is managed.
 *
 * @param {object} diskConfig  Loaded bot config.
 * @param {string} posKey      Composite key for the position.
 * @param {string|number} tokenId  The NFT to value.
 * @param {number} price0      Token0 USD price.
 * @param {number} price1      Token1 USD price.
 * @returns {number}  USD value of that NFT's compounded coins.
 */
function savedNftCompoundedUsd(diskConfig, posKey, tokenId, price0, price1) {
  const pos = getPositionConfig(diskConfig, posKey);
  return nftCoinsToUsd(
    pos?.nftCompoundedAmountsByTokenId,
    tokenId,
    price0,
    price1,
  );
}

module.exports = {
  _detectCurrentNftValues,
  savedNftCompoundedUsd,
};
