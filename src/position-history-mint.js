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
 * **When this runs.** Almost never. `_supplementFromEvents` fills both
 * the mint date and the mint TRANSACTION for every NFT a rebalance
 * created, reading each off that rebalance's own event. The chain's
 * oldest NFT has no such event — it appears only as an `oldTokenId` —
 * so it arrives here with a date and block stamped from the scanner's
 * `chainFirstMint*` fields and no transaction hash. That hash is the
 * reason this runs: `needsEntryFromChain` and the creation-gas read in
 * `position-history.js` both require it.
 *
 * **What it costs.** One block. The caller passes the block it already
 * knows, so the search does not walk a range. Without it the window
 * would run from the pool's creation to the chain head. The disk cache
 * then makes even that one request a once-ever cost per NFT.
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

/**
 * Cache key for one NFT's mint.
 *
 * Scoped by the NFT contract, because a token id identifies an NFT only
 * WITHIN its contract. Two position managers both number their NFTs from
 * one, so a key of the id alone hands the first provider's mint back for
 * the second provider's NFT — a wrong mint date, a wrong opening value,
 * and a wrong creation gas, all silently.
 *
 * @param {string} pmAddress  NFT contract (NonfungiblePositionManager).
 * @param {string|number} tokenId
 * @returns {string}
 */
function _mintKey(pmAddress, tokenId) {
  return `${String(pmAddress).toLowerCase()}-${String(tokenId)}`;
}

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
async function _mintScanWindow(prov, tokenId, knownBlock, pmAddress) {
  /*- When the block is already known, it IS the window. The chain's
   *  oldest NFT reaches here with `mintBlockNumber` already stamped from
   *  the scanner's `chainFirstMintBlock`, and only its transaction hash
   *  is missing — so the search is one block, not a chunked walk from
   *  the pool's creation to the chain head. That walk is thousands of
   *  requests; this is one. */
  if (Number.isInteger(knownBlock) && knownBlock > 0)
    return { from: knownBlock, to: knownBlock };
  /* Search recent blocks only — NFTs are minted within
     the last ~5 years max (~15.8M blocks on PulseChain). */
  const latest = await prov.getBlockNumber();
  const fiveYearFloor = Math.max(0, latest - FIVE_YEAR_BLOCKS);
  /*- Tighten the lower bound to the pool's creation block when we can
      determine it; the pool can't have minted NFTs before it existed. */
  const poolAddress = await resolvePoolAddressForToken({
    provider: prov,
    ethersLib: ethers,
    positionManagerAddress: pmAddress || config.POSITION_MANAGER,
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
 * @param {object} [opts]
 * @param {string} [opts.positionManagerAddress]  The NFT contract to read.
 *   Defaults to the configured one. Taken as a parameter because a token
 *   id names an NFT only within its own contract, and this app addresses
 *   positions by `blockchain-wallet-contract-tokenId`.
 */
async function supplementMintFromChain(result, tokenId, opts = {}) {
  const pmAddress =
    typeof opts.positionManagerAddress === "string" &&
    opts.positionManagerAddress !== ""
      ? opts.positionManagerAddress
      : config.POSITION_MANAGER;
  _loadMintCache();
  const cached = _mintCache.get(_mintKey(pmAddress, tokenId));
  if (cached) {
    result.mintDate = result.mintDate || cached.mintDate;
    result.mintTxHash = result.mintTxHash || cached.txHash;
    if (cached.blockNumber && !result.mintBlockNumber)
      result.mintBlockNumber = cached.blockNumber;
    return;
  }
  try {
    const prov = sendTx.getManagedReadProvider();
    const { from, to } = await _mintScanWindow(
      prov,
      tokenId,
      result.mintBlockNumber,
      pmAddress,
    );
    const logs = await scanChunked({
      provider: prov,
      fromBlock: from,
      toBlock: to,
      label: `history mint #${tokenId}`,
      query: (f, t) =>
        prov.getLogs({
          address: pmAddress,
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
    _mintCache.set(_mintKey(pmAddress, tokenId), {
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
