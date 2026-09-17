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
 * the chain, each from its own mint to the chain head.  So both take them
 * from one read.
 *
 * The reader fetches the whole chain in one batched pass
 * (`nft-events-batch.js`), at most once per request, and only when a
 * consumer asks for it: a request whose figures are all cached reads
 * nothing.  A failed read is not kept, so the next consumer tries again
 * rather than inheriting the failure.
 *
 * Epoch reconstruction in the same request can use the read too.
 * Reconstruction runs inside the pool scan, ahead of the other two.  So
 * the request keeps one reader from the first moment anything needs it
 * (`requestChainReader`).  Reconstruction takes its
 * Collect/DecreaseLiquidity histories from that reader whenever the other
 * two are going to read the chain anyway.
 */

"use strict";

const config = require("./config");
const sendTx = require("./send-transaction");
const { getPoolCreationBlockCached } = require("./pool-creation-block");
const { scanChainNftEvents, shareRead } = require("./nft-events-batch");
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
  if (poolAddress === undefined || poolAddress === null || poolAddress === "")
    return 0;
  const provider = sendTx.getManagedReadProvider();
  return getPoolCreationBlockCached({
    provider,
    factoryAddress: config.FACTORY,
    poolAddress,
  });
}

/**
 * The one read.  Each NFT is floored at its own mint block.  The chain's
 * oldest NFT, whose mint no rebalance event names, is floored at the
 * chain's first mint (`chainScanFloor`).  The pool's creation block lies
 * beneath both.
 */
async function _readChain(position, events, poolAddress) {
  const creationBlock = await poolCreationFloor(poolAddress);
  const ids = collectTokenIds(position, events);
  const mintBlocks = mintBlocksByTokenId(events);
  const sharedFloor = chainScanFloor(events, creationBlock);
  return scanChainNftEvents(ids, { mintBlocks, sharedFloor });
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
  return shareRead(() => _readChain(position, events, poolAddress));
}

/**
 * The chain reader for one request, made the first time something needs
 * it and handed to everything after.
 *
 * Epoch reconstruction runs inside the pool scan's callback, before Fees
 * Compounded and the lifetime HODL, so the reader has to exist by then and
 * be the one those two use afterwards.  The pool scan passes its callback
 * the same events array it returns to its caller; that array is what ties
 * the two, so a reader is kept for the array it was made for.
 *
 * @param {object} o
 * @param {object} o.position  Current position.
 * @param {string|null} [o.poolAddress]
 * @returns {(events: Array) => (() => Promise<Map<string, object>>)}
 */
function requestChainReader({ position, poolAddress }) {
  let madeFor = null;
  let read = null;
  return function readerFor(events) {
    if (read === null || events !== madeFor) {
      madeFor = events;
      read = chainEventsReader({ position, events, poolAddress });
    }
    return read;
  };
}

module.exports = { chainEventsReader, requestChainReader, poolCreationFloor };
