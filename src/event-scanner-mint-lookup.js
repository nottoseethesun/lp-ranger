"use strict";

/**
 * @file src/event-scanner-mint-lookup.js
 * @module eventScannerMintLookup
 * @description
 * True-first-mint resolution helpers extracted from `src/event-scanner.js`
 * (which sits right at its `max-lines: 500` cap).  Two exports:
 *   - `resolveFirstMintWithForeign` — earliest-ever true-mint reconciler
 *     that considers both direct mints (Transfer 0x0 → wallet) AND
 *     foreign-minted NFTs that were transferred in from another wallet.
 *   - `findOriginalMintOnChain` — the underlying per-tokenId lookup for
 *     the foreign-mint case.
 *
 * See the docstrings on each function for the design rationale.  The
 * enhancement was introduced 2026-07-18 by the
 * `enhanced-lifetime-days-detection` branch to close the Lifetime Day
 * Count under-count that occurred when a pool's oldest NFT on this
 * wallet had actually been minted on an earlier wallet.
 */

const { log } = require("./log");
const { PM_ABI } = require("./pm-abi");
const { getPoolCreationBlockCached } = require("./pool-creation-block");

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Pick the earliest-ever true-mint timestamp for this pool on this wallet,
 * considering both direct mints AND foreign-minted NFTs that were
 * transferred in from another wallet.  When the OLDEST incoming transfer
 * in this scan window was foreign, one extra on-chain lookup finds that
 * NFT's true mint block — otherwise `firstMintTimestamp` would reflect
 * the arrival date rather than the true mint date, and Lifetime Day
 * Count would under-count by the "days lived on another wallet before
 * landing here" span.
 *
 * "Oldest" is defined as earliest arrival on THIS wallet.  Per the
 * design agreement, the mint-vs-arrival lookup runs only for that single
 * NFT; other foreign-minted NFTs in the pool aren't spidered.  If the
 * user wants finer credit, the "Edit Total Lifetime Days" input on the
 * dashboard is the escape hatch.
 *
 * Without this reconciliation, incremental scans that see any new mint
 * would overwrite the cached value with a later one and "first mint"
 * would creep toward the chain tip.  The block number travels with
 * whichever timestamp wins so initial-residual lookups have block-level
 * granularity.
 *
 * @param {object} provider  ethers provider.
 * @param {object} ethersLib ethers namespace (v6 shape).
 * @param {string} positionManagerAddress  NonfungiblePositionManager address.
 * @param {object} cachedEvents  Prior cache; may carry `firstMintTimestamp`.
 * @param {object[]} transfers  Filtered transfers for this scan window.
 * @param {object} poolCtx  `{ factoryAddress, poolAddress }` for the true-
 *   mint lookup's `fromBlock` bound.  Both may be null; the helper still
 *   works (falls back to arrival timestamp when the bound is unknown).
 * @returns {Promise<{firstMintTimestamp: number|null, firstMintBlockNumber: number|null}>}
 */
async function resolveFirstMintWithForeign(
  provider,
  ethersLib,
  positionManagerAddress,
  cachedEvents,
  transfers,
  poolCtx,
) {
  const cachedFirstTs = cachedEvents.firstMintTimestamp || null;
  const cachedFirstBlock = cachedEvents.firstMintBlockNumber || null;

  const incoming = transfers
    .filter((t) => t.direction === "in")
    .sort((a, b) => a.timestamp - b.timestamp);
  const oldest = incoming[0];
  if (!oldest) {
    return {
      firstMintTimestamp: cachedFirstTs,
      firstMintBlockNumber: cachedFirstBlock,
    };
  }

  let candidateTs, candidateBlock;
  if (oldest.from === ZERO) {
    candidateTs = oldest.timestamp;
    candidateBlock = oldest.blockNumber;
  } else {
    const mintInfo = await findOriginalMintOnChain(
      provider,
      ethersLib,
      positionManagerAddress,
      oldest.tokenId,
      poolCtx,
    );
    if (mintInfo) {
      log.info(
        "[event-scanner] foreign-minted oldest NFT: tokenId=%s arrivalTs=%d trueMintTs=%d (+%d days credit)",
        oldest.tokenId,
        oldest.timestamp,
        mintInfo.timestamp,
        Math.round((oldest.timestamp - mintInfo.timestamp) / 86400),
      );
      candidateTs = mintInfo.timestamp;
      candidateBlock = mintInfo.blockNumber;
    } else {
      log.warn(
        "[event-scanner] foreign-mint lookup failed for tokenId=%s; falling back to arrival",
        oldest.tokenId,
      );
      candidateTs = oldest.timestamp;
      candidateBlock = oldest.blockNumber;
    }
  }

  if (candidateTs && (!cachedFirstTs || candidateTs < cachedFirstTs)) {
    return {
      firstMintTimestamp: candidateTs,
      firstMintBlockNumber: candidateBlock,
    };
  }
  if (cachedFirstTs) {
    return {
      firstMintTimestamp: cachedFirstTs,
      firstMintBlockNumber: cachedFirstBlock,
    };
  }
  return { firstMintTimestamp: null, firstMintBlockNumber: null };
}

/**
 * Look up the ERC-721 mint event for `tokenId` on the position manager
 * contract.  Filters for a Transfer whose `from` field is the zero
 * address — the ERC-721 convention for a mint — regardless of which
 * wallet received the NFT.  Returns the block number and Unix timestamp
 * of that mint, or null when no matching event is found.
 *
 * Bounds `fromBlock` at the pool creation block (via
 * `getPoolCreationBlockCached`) so we're not doing a genesis-to-tip scan
 * per `feedback_no_genesis_chain_scans`.  Falls back to `fromBlock=0`
 * when the pool creation block is unavailable — the Transfer event has
 * `tokenId` as an indexed topic, so a single-tokenId query is fast even
 * without a lower bound.
 *
 * @param {object} provider  ethers provider.
 * @param {object} ethersLib ethers namespace (v6 shape).
 * @param {string} positionManagerAddress
 * @param {string} tokenId
 * @param {object} poolCtx  `{ factoryAddress, poolAddress }` — optional.
 * @returns {Promise<{timestamp: number, blockNumber: number}|null>}
 */
async function findOriginalMintOnChain(
  provider,
  ethersLib,
  positionManagerAddress,
  tokenId,
  poolCtx,
) {
  const contract = new ethersLib.Contract(
    positionManagerAddress,
    PM_ABI,
    provider,
  );
  let fromBlock = 0;
  if (poolCtx?.factoryAddress && poolCtx?.poolAddress) {
    try {
      const creation = await getPoolCreationBlockCached({
        provider,
        ethersLib,
        factoryAddress: poolCtx.factoryAddress,
        poolAddress: poolCtx.poolAddress,
      });
      if (Number.isFinite(creation) && creation > 0) fromBlock = creation;
    } catch {
      /*- Non-fatal — fall through to fromBlock=0 */
    }
  }
  let events;
  try {
    const filter = contract.filters.Transfer(ZERO, null, tokenId);
    events = await contract.queryFilter(filter, fromBlock, "latest");
  } catch (err) {
    log.warn(
      "[event-scanner] mint-lookup queryFilter failed for tokenId=%s: %s",
      tokenId,
      err.message,
    );
    return null;
  }
  if (!events || events.length === 0) return null;
  const mintEvt = events[0];
  const block = await provider.getBlock(mintEvt.blockNumber).catch(() => null);
  if (!block) return null;
  return { timestamp: block.timestamp, blockNumber: mintEvt.blockNumber };
}

module.exports = {
  resolveFirstMintWithForeign,
  findOriginalMintOnChain,
};
