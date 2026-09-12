/**
 * @file src/position-history-scan-helpers.js
 * @module position-history-scan-helpers
 * @description
 * On-chain log-scan helpers extracted from `position-history.js` to keep that
 * file under the 500-line cap.  Both exist to avoid replaying every chain
 * block back to genesis when looking up closed-position data:
 *
 *   - `scanCollectAndDrain` — one NFT's full Collect + DecreaseLiquidity
 *     history for the same lower bound, fetched once and shared by both
 *     consumers that need it.
 *   - `resolveScanFromBlock` — returns `max(latest - 5y, poolCreationBlock)`
 *     for the tokenId's pool; falls back to the 5-year floor when the pool
 *     address can't be resolved.
 */

"use strict";

const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const { scanChunked } = require("./get-logs-chunked");
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
 * Every occurrence of one Position-Manager event for a tokenId, parsed
 * and oldest-first.
 *
 * @param {string} eventName 'Collect' or 'DecreaseLiquidity'.
 * @param {string} tokenId   NFT token ID.
 * @param {object} provider  ethers.js provider.
 * @param {number} fromBlock Lower bound for the log scan (use the pool's
 *   creation block to avoid replaying chain history back to genesis).
 * @returns {Promise<Array<object>|null>}  Null when the query itself
 *   failed, which is deliberately distinct from an empty array: empty
 *   means the event never fired, null means we do not know.
 */
async function _scanEventLogs(eventName, tokenId, provider, fromBlock) {
  try {
    const tid = BigInt(tokenId);
    /*- Chunked.  The surrounding try/catch is what preserves this
     *  function's null-vs-[] contract: a chunk failure propagates out of
     *  scanChunked, lands in the catch below, and returns null ("we do
     *  not know").  Best-effort chunking would return a short array
     *  here and be read as "the event never fired", which is the one
     *  outcome this function exists to avoid. */
    const logs = await scanChunked({
      provider,
      fromBlock,
      toBlock: "latest",
      label: `history ${eventName} #${tokenId}`,
      query: (f, t) =>
        provider.getLogs({
          address: config.POSITION_MANAGER,
          fromBlock: f,
          toBlock: t,
          topics: [
            _IFACE.getEvent(eventName).topicHash,
            "0x" + tid.toString(16).padStart(64, "0"),
          ],
        }),
    });
    const out = [];
    for (const l of logs) {
      try {
        const p = _IFACE.parseLog({ topics: l.topics, data: l.data });
        out.push({
          amount0: p.args.amount0,
          amount1: p.args.amount1,
          liquidity: p.args.liquidity,
          blockNumber: l.blockNumber,
        });
      } catch {
        /* skip unparseable */
      }
    }
    return out;
  } catch (err) {
    log.warn(
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
 * One NFT's complete Collect and DecreaseLiquidity history.
 *
 * Fetched together, and once, because both consumers in
 * position-history.js need the same logs: the exit value comes from the
 * final Collect, and the whole-life fee total from every Collect
 * measured against the drained principal.  Scanning them separately
 * meant querying Collect twice per closed NFT — see the
 * fetch-once-pass-it-down rule in
 * docs/claude/CLAUDE-BEST-PRACTICES.md.
 *
 * @param {string} tokenId   NFT token ID.
 * @param {object} provider  ethers.js provider.
 * @param {number} [fromBlock=0]  Lower bound for both log scans.
 * @returns {Promise<{collectEvents: Array, dlEvents: Array}|null>}  Null
 *   when the history could not be read — see below.
 */
async function scanCollectAndDrain(tokenId, provider, fromBlock = 0) {
  const [collectEvents, dlEvents] = await Promise.all([
    _scanEventLogs("Collect", tokenId, provider, fromBlock),
    _scanEventLogs("DecreaseLiquidity", tokenId, provider, fromBlock),
  ]);
  if (!collectEvents || !dlEvents) return null;
  /*- A closed NFT always emitted a Collect when it was drained, so zero
   *  of them means the scan did not see this NFT's history — a bad
   *  lower bound, or an RPC that returned an empty page.  Reporting
   *  "unknown" lets callers keep whatever figures they already had;
   *  reporting zero would overwrite real numbers with wrong ones. */
  if (collectEvents.length === 0) return null;
  return { collectEvents, dlEvents };
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
  scanCollectAndDrain,
  resolveScanFromBlock,
  FIVE_YEAR_BLOCKS,
};
