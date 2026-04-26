/**
 * @file src/position-history-scan-helpers.js
 * @module position-history-scan-helpers
 * @description
 * On-chain log-scan helpers extracted from `position-history.js` to keep that
 * file under the 500-line cap.  Both helpers exist to avoid replaying every
 * chain block back to genesis when looking up closed-position data:
 *
 *   - `findLastEventOnChain` — accepts a `fromBlock` lower bound (caller's
 *     responsibility to compute, typically via `resolveScanFromBlock`).
 *   - `resolveScanFromBlock` — returns `max(latest - 5y, poolCreationBlock)`
 *     for the tokenId's pool; falls back to the 5-year floor when the pool
 *     address can't be resolved.
 */

"use strict";

const ethers = require("ethers");
const config = require("./config");
const { PM_ABI } = require("./pm-abi");
const {
  getPoolCreationBlockCached,
  resolvePoolAddressForToken,
} = require("./pool-creation-block");

/** ~5 years of PulseChain blocks (10s block time). */
const FIVE_YEAR_BLOCKS = 15_800_000;

/*- Cached at module load: parsing PM logs is stateless, so a single Interface
    instance can serve every call.  Built from whichever ethers binding is in
    scope when this file is first required (tests patch Module.prototype.require
    to inject a stub before loading). */
const _IFACE = new ethers.Interface(PM_ABI);

/**
 * Search on-chain for the last occurrence of an event for a tokenId.
 * @param {string} eventName 'Collect' or 'DecreaseLiquidity'.
 * @param {string} tokenId   NFT token ID.
 * @param {object} provider  ethers.js provider.
 * @param {number} [fromBlock=0]  Lower bound for the log scan (use the pool's
 *   creation block to avoid replaying chain history back to genesis).
 * @returns {Promise<{amount0: bigint, amount1: bigint, blockNumber: number}|null>}
 */
async function findLastEventOnChain(
  eventName,
  tokenId,
  provider,
  fromBlock = 0,
) {
  try {
    const tid = BigInt(tokenId);
    const logs = await provider.getLogs({
      address: config.POSITION_MANAGER,
      fromBlock,
      toBlock: "latest",
      topics: [
        _IFACE.getEvent(eventName).topicHash,
        "0x" + tid.toString(16).padStart(64, "0"),
      ],
    });
    if (!logs.length) return null;
    const last = logs[logs.length - 1];
    const parsed = _IFACE.parseLog({
      topics: last.topics,
      data: last.data,
    });
    return {
      amount0: parsed.args.amount0,
      amount1: parsed.args.amount1,
      blockNumber: last.blockNumber,
    };
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
 * Resolve the on-chain log-scan lower bound for a tokenId's pool.
 * Returns `max(latest - 5y, poolCreationBlock)`; falls back to the 5-year
 * floor when the pool address can't be resolved.  Mirrors the bounding
 * pattern used by `_supplementMintFromChain` in position-history.js.
 *
 * @param {object} prov     ethers.js provider
 * @param {object} ethers   ethers library
 * @param {string} tokenId  NFT token ID
 * @returns {Promise<number>}  Block number to use as `fromBlock`.
 */
async function resolveScanFromBlock(prov, ethers, tokenId) {
  const latest = await prov.getBlockNumber();
  const fiveYearFloor = Math.max(0, latest - FIVE_YEAR_BLOCKS);
  const poolAddress = await resolvePoolAddressForToken({
    provider: prov,
    ethersLib: ethers,
    positionManagerAddress: config.POSITION_MANAGER,
    factoryAddress: config.FACTORY,
    tokenId,
  });
  const poolCreationBlock = poolAddress
    ? await getPoolCreationBlockCached({
        provider: prov,
        ethersLib: ethers,
        factoryAddress: config.FACTORY,
        poolAddress,
      })
    : 0;
  return Math.max(fiveYearFloor, poolCreationBlock);
}

module.exports = {
  findLastEventOnChain,
  resolveScanFromBlock,
  FIVE_YEAR_BLOCKS,
};
