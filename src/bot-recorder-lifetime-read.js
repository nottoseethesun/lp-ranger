/**
 * @file src/bot-recorder-lifetime-read.js
 * @module bot-recorder-lifetime-read
 * @description
 * The lifetime scan's chain read, prepared so epoch reconstruction can take
 * its events from the same read.
 *
 * One scan pass (`_scanAndReconstruct` in `src/bot-recorder.js`) rebuilds
 * epochs and then runs the lifetime scan. On a cold start both need the
 * chain's history from each NFT's mint: epoch reconstruction reads Collect
 * and DecreaseLiquidity for the closed NFTs, and the lifetime scan reads all
 * three event types for every NFT. The first read is a subset of the
 * second, so when the lifetime scan is going to read the chain anyway, the
 * pass prepares that read before reconstruction and reconstruction takes
 * its histories from it.
 *
 * A prepared read belongs to the chain it was prepared for. Reconstruction
 * can take long enough for the chain to change under it: a manual rebalance
 * mints a new NFT and moves the live one. The lifetime scan therefore uses a
 * prepared read only while it still describes the chain the scan sees
 * (`chainReadFor`), and otherwise prepares its own.
 *
 * The lifetime scan's own rules — where a read starts, and which resume
 * buffer it draws on — stay in `src/bot-recorder-lifetime.js` and arrive
 * here as `start`, so neither module depends on the other both ways.
 */

"use strict";

const { log } = require("./log");
const { shareRead } = require("./nft-events-batch");
const {
  collectTokenIds,
  fetchAllNftEvents,
} = require("./bot-recorder-scan-helpers");
const { mintBlocksByTokenId, chainScanFloor } = require("./nft-mint-blocks");

/**
 * Everything that decides what a chain read covers, as one comparable
 * value: the live NFT, every NFT in the chain with its mint block, and the
 * chain's first mint.
 *
 * The pool's creation block is left out. It is resolved when the read
 * runs, and it is the same for every read of one pool.
 *
 * @param {object} position  Live position; `tokenId` is the live NFT.
 * @param {Array & {firstMintBlockNumber?: number}} rebalanceEvents
 * @returns {string}
 */
function chainSignature(position, rebalanceEvents) {
  const mints = mintBlocksByTokenId(rebalanceEvents);
  const ids = [...collectTokenIds(position, rebalanceEvents)]
    .map(String)
    .sort();
  const firstMint = rebalanceEvents?.firstMintBlockNumber ?? null;
  const mintOfEach = ids.map((id) => [
    id,
    mints.has(id) ? mints.get(id) : null,
  ]);
  return JSON.stringify([String(position.tokenId), mintOfEach, firstMint]);
}

/**
 * Prepare a chain read without starting it.
 *
 * The read runs on the first call to `read()`, and every later call shares
 * it (`shareRead`). Each NFT is floored at its own mint block; the chain's
 * oldest, whose mint no rebalance event names, at the chain's first mint
 * (`chainScanFloor`); the start block beneath both.
 *
 * @param {object} o
 * @param {object} o.position  Live position.
 * @param {Array} o.rebalanceEvents  The chain, as the event scan found it.
 * @param {() => Promise<{fromBlock: number, resumeBuffer: Map}>} o.start
 *   Where the read starts and which resume buffer it draws on, decided
 *   when the read runs rather than when it is prepared.
 * @returns {{signature: string, ids: Set<string>,
 *   read: () => Promise<Map<string, object>>}}  `read` resolves to each
 *   NFT's events, keyed by tokenId.
 */
function prepareChainRead({ position, rebalanceEvents, start }) {
  const ids = collectTokenIds(position, rebalanceEvents);
  const mintBlocks = mintBlocksByTokenId(rebalanceEvents);
  const liveTokenId = position.tokenId;
  const read = shareRead(async () => {
    const { fromBlock, resumeBuffer } = await start();
    const scanFrom = chainScanFloor(rebalanceEvents, fromBlock);
    return fetchAllNftEvents(ids, scanFrom, mintBlocks, {
      resumeBuffer,
      liveTokenId,
    });
  });
  return {
    signature: chainSignature(position, rebalanceEvents),
    ids,
    read,
  };
}

/**
 * The read a lifetime scan should use: the one prepared earlier in its
 * pass while that still describes the scan's chain, otherwise its own.
 *
 * @param {{signature: string}|null|undefined} prepared  From the pass.
 * @param {object} position  Live position, as the scan sees it now.
 * @param {Array} rebalanceEvents  The chain, as the scan sees it now.
 * @param {() => object} prepareOwn  Prepares the scan's own read.
 * @param {{t0Sym: string, t1Sym: string, tokenIdStr: string,
 *   tokenEmoji: string}} ctx  Log context.
 * @returns {object}  A prepared read.
 */
function chainReadFor(prepared, position, rebalanceEvents, prepareOwn, ctx) {
  if (prepared === null || prepared === undefined) return prepareOwn();
  /*-
   *  Both outcomes are logged. Sharing leaves the lifetime scan with no
   *  read of its own in the log, and not sharing leaves two reads there.
   *  Either way, the line says why.
   */
  if (prepared.signature === chainSignature(position, rebalanceEvents)) {
    log.info(
      "[bot] %s/%s NFT #%s %s: The lifetime scan uses this scan pass's chain read",
      ctx.t0Sym,
      ctx.t1Sym,
      ctx.tokenIdStr,
      ctx.tokenEmoji,
    );
    return prepared;
  }
  log.info(
    "[bot] %s/%s NFT #%s %s: The chain changed during this scan pass; the lifetime scan reads it afresh",
    ctx.t0Sym,
    ctx.t1Sym,
    ctx.tokenIdStr,
    ctx.tokenEmoji,
  );
  return prepareOwn();
}

module.exports = { chainSignature, prepareChainRead, chainReadFor };
