/**
 * @file src/position-details-chain-read.js
 * @module position-details-chain-read
 * @description
 * One read of a rebalance chain's NFT event history per lifetime-details
 * request, shared by the consumers in that request.
 *
 * The unmanaged details path derives two figures from the same history:
 * Fees Compounded (`position-details-compound.js`) and the lifetime HODL
 * behind Lifetime IL/G (`position-details-lifetime-scan.js`).  Both need
 * `IncreaseLiquidity`, `Collect` and `DecreaseLiquidity` for every NFT in
 * the chain, each from its own mint to the chain head.  Each used to walk
 * the chain itself, one NFT at a time, so a request that needed both read
 * the chain twice over — and on a long chain one read alone took hours.
 *
 * The reader fetches the whole chain in one batched pass
 * (`nft-events-batch.js`), at most once per request, and only when a
 * consumer asks for it: a request whose figures are all cached reads
 * nothing.  A failed read is not kept, so the next consumer tries again
 * rather than inheriting the failure.
 *
 * The epoch rebuild earlier in the same request is not a consumer.  It
 * reads only Collect and DecreaseLiquidity, for the closed NFTs, inside
 * the pool scan and before this reader exists — and the managed bot
 * shares that code with no request to hang a reader on.
 */

"use strict";

const config = require("./config");
const sendTx = require("./send-transaction");
const { getPoolCreationBlockCached } = require("./pool-creation-block");
const { scanChainNftEvents } = require("./nft-events-batch");
const { mintBlocksByTokenId, chainScanFloor } = require("./nft-mint-blocks");
const { collectTokenIds } = require("./bot-recorder-scan-helpers");

/**
 * The block a pool was created in: the lower bound for any scan of its
 * NFTs.
 *
 * Without it a scan starts at genesis.  An NFT cannot have events before
 * its pool existed, so the creation block is both correct and tight.
 *
 * @param {string|null|undefined} poolAddress
 * @returns {Promise<number>}  Creation block, or 0 when unknown.  Never
 *   rejects on a failed lookup: `getPoolCreationBlockCached` answers 0,
 *   and a scan from further back is slower, not wrong.
 */
async function poolCreationFloor(poolAddress) {
  if (!poolAddress) return 0;
  return getPoolCreationBlockCached({
    provider: sendTx.getManagedReadProvider(),
    factoryAddress: config.FACTORY,
    poolAddress,
  });
}

/*- The one read.  Each NFT is floored at its own mint block; the
 *  chain's oldest, whose mint no rebalance event names, at the chain's
 *  first mint (`chainScanFloor`); the pool's creation block lies beneath
 *  both. */
async function _readChain(position, events, poolAddress) {
  const creationBlock = await poolCreationFloor(poolAddress);
  return scanChainNftEvents(collectTokenIds(position, events), {
    mintBlocks: mintBlocksByTokenId(events),
    sharedFloor: chainScanFloor(events, creationBlock),
  });
}

/**
 * A chain reader for one lifetime-details request.
 *
 * Covers every NFT `collectTokenIds` names for this position and chain —
 * the same set each consumer derives from the same inputs.  A consumer
 * looks its NFTs up with `eventsFor`, which throws for one the read did
 * not cover rather than answering "no history".
 *
 * @param {object} o
 * @param {object} o.position  Current position; its `tokenId` is the
 *   chain's live NFT.
 * @param {Array & {firstMintBlockNumber?: number}} o.events  Rebalance
 *   events for the chain.
 * @param {string|null} [o.poolAddress]
 * @returns {() => Promise<Map<string, object>>}  Resolves to one entry
 *   per NFT; the first call reads, later calls share that read.
 */
function chainEventsReader({ position, events, poolAddress }) {
  let pending = null;
  return function readChainEvents() {
    if (pending === null) {
      pending = _readChain(position, events, poolAddress).catch((err) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };
}

module.exports = { chainEventsReader, poolCreationFloor };
