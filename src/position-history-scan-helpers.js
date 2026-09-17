/**
 * @file src/position-history-scan-helpers.js
 * @module position-history-scan-helpers
 * @description
 * On-chain log-scan helpers extracted from `position-history.js` to keep that
 * file under the 500-line cap.  They read the history a closed NFT's exit
 * value and lifetime fees come from, without replaying every chain block
 * back to genesis:
 *
 *   - `scanChainCollectAndDrain` — every closed NFT's Collect +
 *     DecreaseLiquidity history for a whole rebalance chain, in one pass.
 *     What epoch reconstruction reads.
 *   - `scanCollectAndDrain` — the same history for one NFT, for a caller
 *     looking at a single closed position.
 *   - `resolveScanFromBlock` — returns `max(latest - 5y, poolCreationBlock)`
 *     for the tokenId's pool; falls back to the 5-year floor when the pool
 *     address can't be resolved.
 *
 * Both reads go through `nft-events-batch.js` — the single-NFT one as a
 * chain of one — so they cannot disagree about how a log is decoded,
 * which NFT it belongs to, or what order it comes in.
 */

"use strict";

const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const sendTx = require("./send-transaction");
const {
  fetchChainNftEvents,
  scanChainNftEvents,
  eventsFor,
} = require("./nft-events-batch");
const { IFACE, parseLogs } = require("./nft-event-parse");
const { mintBlocksByTokenId, chainScanFloor } = require("./nft-mint-blocks");
const {
  getPoolCreationBlockCached,
  resolvePoolAddressForToken,
} = require("./pool-creation-block");

/** ~5 years of PulseChain blocks (10s block time). */
const FIVE_YEAR_BLOCKS = 15_800_000;

/*-
 *  The two histories a closed NFT's figures come from: the exit value
 *  from its final Collect, and the lifetime fees from every Collect
 *  measured against the principal each DecreaseLiquidity released.
 *  `IncreaseLiquidity` is left out because nothing here reads it, and
 *  each event type is a full pass over the range.
 */
const DRAIN_EVENTS = ["Collect", "DecreaseLiquidity"];

/**
 * One NFT's history in the shape its consumers take, or null when it
 * cannot be trusted.
 *
 * A closed NFT always emitted a Collect when it was drained, so zero of
 * them means the scan did not see this NFT's history — a bad lower
 * bound, or an RPC that returned an empty page.  Reporting "unknown"
 * lets callers keep whatever figures they already had; reporting zero
 * would overwrite real numbers with wrong ones.
 *
 * @param {{collectEvents: object[], dlEvents: object[]}} entry  One NFT's
 *   entry from a batch read.
 * @returns {{collectEvents: object[], dlEvents: object[]}|null}
 */
function _usableHistory(entry) {
  if (entry.collectEvents.length === 0) return null;
  return { collectEvents: entry.collectEvents, dlEvents: entry.dlEvents };
}

/**
 * The Collect/DecreaseLiquidity histories of some NFTs, taken out of a
 * whole-chain read, in the shape `scanChainCollectAndDrain` returns.
 *
 * Also how epoch reconstruction uses a read another consumer made for the
 * same chain — the lifetime scan's, which fetches all three event types
 * for every NFT. That read floors each NFT at its mint, the same as or
 * lower than epoch reconstruction's own read would, so every history it
 * holds is at least as complete.
 *
 * An id the read does not cover is left out, so the caller's `eventsFor`
 * fails for that NFT alone instead of answering "no history".
 *
 * @param {Map<string, {collectEvents: Array, dlEvents: Array}>} batch
 * @param {Iterable<string|number>} ids
 * @returns {Map<string, {collectEvents: Array, dlEvents: Array}|null>}
 */
function collectAndDrainOf(batch, ids) {
  const out = new Map();
  for (const tokenId of ids) {
    const id = String(tokenId);
    const entry = batch.get(id);
    if (entry !== undefined) out.set(id, _usableHistory(entry));
  }
  return out;
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
 * Takes the NFT's own window rather than the pool's: the caller passes
 * the NFT's mint block as `fromBlock`, and the read runs to the chain
 * head.  A caller with a whole chain to read uses
 * `scanChainCollectAndDrain` instead, which reads the chain's windows
 * once rather than once per NFT.
 *
 * @param {string} tokenId   NFT token ID.
 * @param {object} provider  ethers.js provider.
 * @param {number} [fromBlock=0]  Lower bound for both event types.
 * @returns {Promise<{collectEvents: Array, dlEvents: Array}|null>}  Null
 *   when the history could not be read, or cannot be trusted (see
 *   `_usableHistory`).  Never throws.
 */
async function scanCollectAndDrain(tokenId, provider, fromBlock = 0) {
  try {
    const batch = await fetchChainNftEvents({
      tokenIds: [tokenId],
      mintBlocks: new Map(),
      sharedFloor: fromBlock,
      eventNames: DRAIN_EVENTS,
      provider,
      iface: IFACE,
      address: config.POSITION_MANAGER,
      parseLogs,
    });
    const entry = eventsFor(batch, tokenId);
    return _usableHistory(entry);
  } catch (err) {
    /*-
     *  A chunk failure propagates out of the batch read and lands here,
     *  which is what keeps this function's contract: null means "we do
     *  not know".  Best-effort chunking would hand back a short history
     *  instead, and it would be read as "the event never fired".
     */
    log.warn(
      "[history] On-chain Collect/DecreaseLiquidity lookup failed for #%s: %s",
      tokenId,
      err.message,
    );
    return null;
  }
}

/**
 * Every closed NFT's Collect and DecreaseLiquidity history for a whole
 * rebalance chain, read in one pass.
 *
 * Epoch reconstruction needs both histories for every closed NFT in the
 * chain.  Read one NFT at a time, each from its own mint block to the
 * chain head, the windows overlap almost entirely: the oldest NFT covers
 * the chain's whole life, and every younger one re-reads what its elders
 * already read.  This reads their union once; `nft-events-batch.js`
 * explains why that returns the same logs.
 *
 * Floors come from the rebalance events already in hand, the same way
 * the lifetime scan derives them: each NFT's own mint block, and for the
 * chain's oldest NFT — whose mint no event names — the chain's first
 * mint (`chainScanFloor`).  The pool floor beneath both is resolved once
 * rather than once per NFT, since every NFT in a rebalance chain is in
 * the same pool.
 *
 * @param {string[]} tokenIds  Closed NFTs to read.
 * @param {Array & {firstMintBlockNumber?: number}} events  Rebalance
 *   events for the chain.
 * @returns {Promise<Map<string, {collectEvents: Array, dlEvents: Array}|null>>}
 *   One entry per id, null where the history cannot be trusted (see
 *   `_usableHistory`).  Read it with `eventsFor`, which throws for an id
 *   the read was not prepared with.
 * @throws When the read itself fails.  Unlike `scanCollectAndDrain`,
 *   this leaves the failure to the caller, which decides what an
 *   unreadable chain means for the NFTs it was about to build.
 */
async function scanChainCollectAndDrain(tokenIds, events) {
  if (tokenIds.length === 0) return new Map();
  const prov = sendTx.getManagedReadProvider();
  const poolFloor = await resolveScanFromBlock(prov, ethers, tokenIds[0]);
  const mintBlocks = mintBlocksByTokenId(events);
  const sharedFloor = chainScanFloor(events, poolFloor);
  const batch = await scanChainNftEvents(tokenIds, {
    mintBlocks,
    sharedFloor,
    eventNames: DRAIN_EVENTS,
  });
  return collectAndDrainOf(batch, batch.keys());
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
        factoryAddress: config.FACTORY,
        poolAddress,
      })
    : 0;
  return Math.max(fiveYearFloor, poolCreationBlock);
}

module.exports = {
  scanCollectAndDrain,
  scanChainCollectAndDrain,
  collectAndDrainOf,
  resolveScanFromBlock,
  FIVE_YEAR_BLOCKS,
};
