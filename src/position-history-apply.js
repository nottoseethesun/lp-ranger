/**
 * @file src/position-history-apply.js
 * @module positionHistoryApply
 * @description
 * How a closed NFT's history takes what the app already knows about it,
 * before anything is read from the chain: the rebalance log's entries
 * for its mint and its close, and the event scanner's rebalance events.
 *
 * Pure functions on the result object `getPositionHistory` builds, split
 * from `src/position-history.js` at the 500-line cap. Each fills a field
 * only from a source that names this NFT, and none overwrites a value
 * already known.
 */

"use strict";

/** Apply mint-entry (newTokenId match) data to the result object. */
function applyMintEntry(result, mint) {
  result.mintEntry = {
    loggedAt: mint.loggedAt,
    entryValueUsd: mint.entryValueUsd,
  };
  result.mintDate = mint.loggedAt || null;
  result.entryValueUsd = mint.entryValueUsd ?? null;
  result.token0UsdPriceAtOpen = mint.token0UsdPrice ?? null;
  result.token1UsdPriceAtOpen = mint.token1UsdPrice ?? null;
}

/** Apply close-entry (oldTokenId match) data to the result object. */
function applyCloseEntry(result, close) {
  result.closeEntry = {
    loggedAt: close.loggedAt,
    exitValueUsd: close.exitValueUsd,
  };
  result.closeDate = close.loggedAt || null;
  result.exitValueUsd = close.exitValueUsd ?? null;
  result.token0UsdPriceAtClose = close.token0UsdPrice ?? null;
  result.token1UsdPriceAtClose = close.token1UsdPrice ?? null;
  result.feesEarnedUsd = close.feesEarnedUsd ?? null;
  result.gasCostWei = close.gasCostWei ?? null;
}

/**
 * Supply the mint of the one position NFT no rebalance event can name.
 *
 * A rebalance records "NFT X replaced by NFT Y at block B", so Y's mint
 * block is B. The earliest NFT in the inferred chain appears only as an
 * `oldTokenId` — it replaced nothing — so nothing names its mint, and it
 * would otherwise be read from chain: a scan of the pool's whole history
 * for one Transfer log.
 *
 * The event scanner already saw that mint. `resolveChainFirstMint`
 * records the earliest arrival that was a mint, which by construction is
 * that NFT, and hangs it on the events array this function receives.
 *
 * Two id-gated sources, in order of preference:
 *
 *   - `chainFirst*` — recorded for this purpose; the id always matches.
 *   - `firstMint*` — the oldest NFT the wallet ever held here, kept for
 *     Lifetime Days. Names the same NFT only when every arrival in the
 *     pool was a mint; a transferred-in NFT makes it a different one.
 *     Present on caches written before `chainFirst*` existed.
 *
 * Both are gated on the id because using the wrong one would date this
 * NFT from another NFT's mint. No match falls through to the chain read.
 *
 * @param {object} result   Result object to supplement.
 * @param {string} tokenId  Position NFT token ID.
 * @param {Array & {chainFirstTokenId?: string, chainFirstMintBlock?: number,
 *   chainFirstMintTimestamp?: number, firstMintTokenId?: string,
 *   firstMintTimestamp?: number, firstMintBlockNumber?: number}} events
 */
function _applyFirstMint(result, tokenId, events) {
  /*-
   *  Preferred: the field that names this NFT directly.  It is recorded
   *  for exactly this purpose, so the id always matches and no fallback
   *  is reached.
   */
  if (String(events.chainFirstTokenId || "") === String(tokenId)) {
    _stampMint(
      result,
      events.chainFirstMintTimestamp,
      events.chainFirstMintBlock,
    );
    return;
  }
  /*-
   *  A cache written before that field existed carries only the
   *  oldest-held NFT's mint, which names this NFT whenever every arrival
   *  in the pool was a mint.  Same id check, for the same reason.
   */
  if (String(events.firstMintTokenId || "") !== String(tokenId)) return;
  _stampMint(result, events.firstMintTimestamp, events.firstMintBlockNumber);
}

/** Record a mint date and block without overwriting a known value. */
function _stampMint(result, timestamp, blockNumber) {
  if (!result.mintDate && timestamp)
    result.mintDate = new Date(timestamp * 1000).toISOString();
  if (!result.mintBlockNumber && blockNumber)
    result.mintBlockNumber = blockNumber;
}

/**
 * Fill in missing data from rebalance events (on-chain event scanner).
 * @param {object}   result  Result object to supplement.
 * @param {string}   tokenId NFT token ID.
 * @param {object[]} events  Array of RebalanceEvent from the event scanner.
 */
function supplementFromEvents(result, tokenId, events) {
  if (!events) return;
  const mintEv = events.find((e) => String(e.newTokenId) === String(tokenId));
  if (mintEv) {
    if (!result.mintDate && mintEv.timestamp)
      result.mintDate = new Date(mintEv.timestamp * 1000).toISOString();
    if (!result.mintTxHash) result.mintTxHash = mintEv.txHash || null;
    if (mintEv.blockNumber) result.mintBlockNumber = mintEv.blockNumber;
  } else {
    _applyFirstMint(result, tokenId, events);
  }
  const closeEv = events.find((e) => String(e.oldTokenId) === String(tokenId));
  if (closeEv) {
    if (!result.closeDate && closeEv.timestamp)
      result.closeDate = new Date(closeEv.timestamp * 1000).toISOString();
    if (!result.closeTxHash) result.closeTxHash = closeEv.txHash || null;
    if (closeEv.blockNumber) result.closeBlockNumber = closeEv.blockNumber;
  }
}

module.exports = { applyMintEntry, applyCloseEntry, supplementFromEvents };
