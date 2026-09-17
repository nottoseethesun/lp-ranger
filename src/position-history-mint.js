/**
 * @file src/position-history-mint.js
 * @module positionHistoryMint
 * @description
 * On-chain lookup of an NFT's original mint, with its own disk cache
 * (`tmp/nft-mint-date-cache.json`).
 *
 * Extracted from `position-history.js` to keep that file under the
 * 500-line cap. It earns a module of its own rather than a place in
 * `position-history-scan-helpers.js` because it owns persistent state —
 * the two files next to it are stateless.
 *
 * **When this runs.** Almost never. `_supplementFromEvents` names the
 * mint block of every NFT in a rebalance chain except the oldest, which
 * appears only as an `oldTokenId` and whose mint predates every event.
 * So this is the fallback for that one NFT, and the disk cache means it
 * is paid once per pool rather than once per start.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const ethers = require("ethers");
const { log } = require("./log");
const config = require("./config");
const sendTx = require("./send-transaction");
const { scanChunked } = require("./get-logs-chunked");
const { PM_ABI } = require("./pm-abi");
const { topicForTokenId } = require("./nft-token-topic");
const {
  getPoolCreationBlockCached,
  resolvePoolAddressForToken,
} = require("./pool-creation-block");
const { FIVE_YEAR_BLOCKS } = require("./position-history-scan-helpers");

const _IFACE = new ethers.Interface(PM_ABI);

const _MINT_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  "nft-mint-date-cache.json",
);
const _mintCache = new Map();

/** Load disk mint cache into memory on first use. */
function _loadMintCache() {
  if (_mintCache.size > 0) return;
  try {
    const raw = JSON.parse(fs.readFileSync(_MINT_CACHE_PATH, "utf8"));
    for (const [k, v] of Object.entries(raw)) _mintCache.set(k, v);
  } catch {
    /* no file or corrupt — start empty */
  }
}

/** Persist in-memory mint cache to disk. */
function _saveMintCache() {
  try {
    fs.mkdirSync(path.dirname(_MINT_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      _MINT_CACHE_PATH,
      JSON.stringify(Object.fromEntries(_mintCache), null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

/** Resolve the scan window for one NFT's mint. */
async function _mintScanWindow(prov, tokenId) {
  /* Search recent blocks only — NFTs are minted within
     the last ~5 years max (~15.8M blocks on PulseChain). */
  const latest = await prov.getBlockNumber();
  const fiveYearFloor = Math.max(0, latest - FIVE_YEAR_BLOCKS);
  /*- Tighten the lower bound to the pool's creation block when we can
      determine it; the pool can't have minted NFTs before it existed. */
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
  /*- No upper bound, for the same reason the event scans have none: the
   *  only candidate is the app's inferred succession, and that reads
   *  consecutive mints as successive rebalances — sound only when every
   *  mint in the pool IS a rebalance. */
  return {
    from: Math.max(fiveYearFloor, poolCreationBlock),
    to: "latest",
  };
}

/**
 * Look up an NFT's original mint timestamp via Transfer(from=0x0)
 * on-chain, and record it on `result`.
 *
 * @param {object} result   Result object to supplement. Read for
 *   `closeBlockNumber` (the scan's upper bound); written with
 *   `mintDate`, `mintTxHash` and `mintBlockNumber`.
 * @param {string} tokenId  NFT token ID.
 */
async function supplementMintFromChain(result, tokenId) {
  _loadMintCache();
  const cached = _mintCache.get(String(tokenId));
  if (cached) {
    result.mintDate = result.mintDate || cached.mintDate;
    result.mintTxHash = result.mintTxHash || cached.txHash;
    if (cached.blockNumber && !result.mintBlockNumber)
      result.mintBlockNumber = cached.blockNumber;
    return;
  }
  try {
    const prov = sendTx.getManagedReadProvider();
    const { from, to } = await _mintScanWindow(prov, tokenId);
    const logs = await scanChunked({
      provider: prov,
      fromBlock: from,
      toBlock: to,
      label: `history mint #${tokenId}`,
      query: (f, t) =>
        prov.getLogs({
          address: config.POSITION_MANAGER,
          fromBlock: f,
          toBlock: t,
          topics: [
            _IFACE.getEvent("Transfer").topicHash,
            "0x" + "0".repeat(64),
            null,
            topicForTokenId(tokenId),
          ],
        }),
    });
    if (!logs.length) return;
    const block = await prov.getBlock(logs[0].blockNumber);
    if (!block) return;
    result.mintDate = new Date(block.timestamp * 1000).toISOString();
    result.mintTxHash = result.mintTxHash || logs[0].transactionHash;
    result.mintBlockNumber = result.mintBlockNumber || logs[0].blockNumber;
    _mintCache.set(String(tokenId), {
      mintDate: result.mintDate,
      txHash: logs[0].transactionHash,
      blockNumber: logs[0].blockNumber,
    });
    _saveMintCache();
    log.info(
      "[history] Mint date from chain for #" +
        tokenId +
        " (block " +
        logs[0].blockNumber +
        "): " +
        result.mintDate,
    );
  } catch (err) {
    log.warn("[history] On-chain mint lookup failed:", err.message);
  }
}

module.exports = { supplementMintFromChain, _MINT_CACHE_PATH };
