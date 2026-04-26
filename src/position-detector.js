/**
 * @file position-detector.js
 * @module positionDetector
 * @description
 * Auto-detects and enumerates LP positions for the 9mm v3 position manager.
 *
 * Detection strategy
 * ──────────────────
 * 1. **NFT enumeration** — call `balanceOf(wallet)` on the
 *    NonfungiblePositionManager to discover how many NFTs the wallet holds,
 *    then call `tokenOfOwnerByIndex(wallet, i)` for each index to get token
 *    IDs.  Each ID is queried via `positions(tokenId)` to retrieve range data.
 *    Supports up to MAX_NFT_SCAN positions per wallet.
 *
 * 2. **Single NFT probe** — if a specific `tokenId` is supplied, skip
 *    enumeration and probe that ID directly.
 *
 * 3. **ERC-20 fallback** — if no NFT positions are found, call
 *    `balanceOf(wallet)` on the candidate contract address.  If non-zero,
 *    the position is ERC-20.
 *
 * 4. If all probes return nothing, `{ type: 'unknown' }` is returned.
 *
 * `ethers` is required at top-of-file; tests can inject a stub via
 * `global.ethers` (see `_resolveEthers`).
 *
 * @example
 * const positions = await enumerateNftPositions(provider, {
 *   walletAddress:          '0xABC…',
 *   positionManagerAddress: '0xDEF…',
 * });
 * // NftPosition[] — may contain 0–300 entries
 */

"use strict";

/** Maximum NFT positions to scan per wallet (matches position-store MAX). */
const MAX_NFT_SCAN = 300;

/**
 * @typedef {'nft'|'erc20'|'unknown'} PositionType
 */

/**
 * @typedef {Object} DetectionInput
 * @property {string}  walletAddress            The connected wallet address.
 * @property {string}  [positionManagerAddress] NonfungiblePositionManager address.
 * @property {string}  [candidateAddress]       ERC-20 position token contract to probe.
 * @property {string}  [tokenId]                Specific NFT token ID (skips enumeration).
 */

/**
 * @typedef {Object} NftPosition
 * @property {string} tokenId
 * @property {string} token0
 * @property {string} token1
 * @property {number} fee
 * @property {number} tickLower
 * @property {number} tickUpper
 * @property {bigint} liquidity
 */

/**
 * @typedef {Object} Erc20Position
 * @property {string}  contractAddress  Position token contract.
 * @property {bigint}  balance          Wallet's token balance (raw).
 * @property {string}  [token0]         Pool token0 (if discoverable).
 * @property {string}  [token1]         Pool token1 (if discoverable).
 * @property {number}  [tickLower]      Position tick lower (if discoverable).
 * @property {number}  [tickUpper]      Position tick upper (if discoverable).
 */

/**
 * @typedef {Object} DetectionResult
 * @property {PositionType}         type
 * @property {NftPosition[]|null}   nftPositions   All NFTs found (type === 'nft').
 * @property {Erc20Position[]|null} erc20Positions All ERC-20 positions found.
 * @property {string|null}          error          Human-readable error if unknown.
 */

// ── ABI fragments ─────────────────────────────────────────────────────────────

const ethers = require("ethers");
const { PM_ABI: NFT_ENUM_ABI } = require("./pm-abi");

const ERC20_PROBE_ABI = [
  "function balanceOf(address owner) external view returns (uint256)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function tickLower() external view returns (int24)",
  "function tickUpper() external view returns (int24)",
];

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the active `ethers` library — defers to `global.ethers` when set
 * (test stub-injection seam), otherwise the module-level top-of-file require.
 * @returns {object}
 */
function _resolveEthers() {
  return global.ethers || ethers;
}

/**
 * Shape a raw `positions()` return value into an NftPosition.
 * @param {string} tokenId
 * @param {object} p  Raw contract return.
 * @returns {NftPosition|null}  null when token0 is zero address (truly burned).
 */
function _shapeNftPosition(tokenId, p) {
  // A position with token0 === 0x0 has been fully burned (NFT cleared).
  // A position with liquidity === 0n but valid tokens is just drained
  // (e.g. after a partial rebalance failure) and should still be returned.
  if (!p.token0 || p.token0 === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return {
    tokenId: String(tokenId),
    token0: p.token0,
    token1: p.token1,
    fee: Number(p.fee),
    tickLower: Number(p.tickLower),
    tickUpper: Number(p.tickUpper),
    liquidity: p.liquidity,
  };
}

/**
 * Probe a single NFT token ID via the position manager.
 * @param {object}  contract   ethers Contract instance.
 * @param {string}  tokenId
 * @returns {Promise<NftPosition|null>}
 */
async function _probeSingleNft(contract, tokenId) {
  try {
    const p = await contract.positions(BigInt(tokenId));
    return _shapeNftPosition(tokenId, p);
  } catch (_) {
    return null;
  }
}

/**
 * Enumerate all NFT positions for `walletAddress` up to MAX_NFT_SCAN.
 * Uses the ERC-721 Enumerable extension (`tokenOfOwnerByIndex`).
 * @param {object}  contract       ethers Contract instance.
 * @param {string}  walletAddress
 * @param {object}  [opts]
 * @param {function} [opts.onProgress]  Called after each batch: (done, total).
 * @returns {Promise<NftPosition[]>}
 */
async function _enumerateOwnerNfts(contract, walletAddress, opts) {
  let rawBalance;
  try {
    rawBalance = await contract.balanceOf(walletAddress);
  } catch (_) {
    return [];
  }

  // eslint-disable-next-line 9mm/no-number-from-bigint -- Safe: zero-check only
  const balance = Number(rawBalance);
  if (balance === 0) return [];

  const scanCount = Math.min(balance, MAX_NFT_SCAN);
  const results = [];

  // Fetch token IDs in parallel batches of 10 to avoid RPC rate limits
  const BATCH = 10;
  for (let start = 0; start < scanCount; start += BATCH) {
    const end = Math.min(start + BATCH, scanCount);
    const idBatch = await Promise.all(
      Array.from({ length: end - start }, (_, i) =>
        contract
          .tokenOfOwnerByIndex(walletAddress, start + i)
          .catch(() => null),
      ),
    );

    const posBatch = await Promise.all(
      idBatch.map((id) =>
        id !== null ? _probeSingleNft(contract, id) : Promise.resolve(null),
      ),
    );

    for (const pos of posBatch) {
      if (pos !== null) results.push(pos);
    }
    if (opts && opts.onProgress)
      opts.onProgress(Math.min(start + BATCH, scanCount), scanCount);
  }

  return results;
}

/**
 * Probe an ERC-20 position token for balance and metadata.
 * @param {object}  provider
 * @param {string}  contractAddress
 * @param {string}  walletAddress
 * @param {object}  ethersLib
 * @returns {Promise<Erc20Position|null>}
 */
async function _probeErc20(
  provider,
  contractAddress,
  walletAddress,
  ethersLib,
) {
  if (!contractAddress || !walletAddress) return null;
  try {
    const contract = new ethersLib.Contract(
      contractAddress,
      ERC20_PROBE_ABI,
      provider,
    );
    const balance = await contract.balanceOf(walletAddress);
    if (balance === 0n) return null;

    const pos = { contractAddress, balance };

    const opt = async (fn) => {
      try {
        return await fn();
      } catch (_) {
        return null;
      }
    };
    pos.token0 = await opt(() => contract.token0());
    pos.token1 = await opt(() => contract.token1());
    const tl = await opt(() => contract.tickLower());
    const tu = await opt(() => contract.tickUpper());
    if (tl !== null && tl !== undefined) pos.tickLower = Number(tl);
    if (tu !== null && tu !== undefined) pos.tickUpper = Number(tu);

    return pos;
  } catch (_) {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enumerate all NFT LP positions owned by a wallet.
 * Returns an empty array (not an error) when the wallet holds no positions.
 *
 * @param {object}  provider
 * @param {{ walletAddress: string, positionManagerAddress: string }} input
 * @param {object}  [opts]
 * @param {function} [opts.onProgress]  Called after each batch: (done, total).
 * @returns {Promise<NftPosition[]>}
 */
async function enumerateNftPositions(provider, input, opts) {
  if (!input.positionManagerAddress || !input.walletAddress) return [];
  const ethersLib = _resolveEthers();
  try {
    const contract = new ethersLib.Contract(
      input.positionManagerAddress,
      NFT_ENUM_ABI,
      provider,
    );
    return await _enumerateOwnerNfts(contract, input.walletAddress, opts);
  } catch (_) {
    return [];
  }
}

/**
 * Auto-detect position type and return all positions found.
 *
 * When a `tokenId` is supplied in `input`, only that specific NFT is probed
 * (no full enumeration).  Otherwise full enumeration is attempted first,
 * then ERC-20 fallback.
 *
 * @param {object}         provider
 * @param {DetectionInput} input
 * @param {object}         [opts]
 * @param {function}       [opts.onProgress]  Forwarded to enumerateNftPositions.
 * @returns {Promise<DetectionResult>}
 */
async function detectPositionType(provider, input, opts) {
  const ethersLib = _resolveEthers();
  // 1 — Single-ID probe (explicit tokenId supplied)
  if (input.tokenId && input.positionManagerAddress) {
    const contract = new ethersLib.Contract(
      input.positionManagerAddress,
      NFT_ENUM_ABI,
      provider,
    );
    const single = await _probeSingleNft(contract, input.tokenId);
    if (single) {
      return {
        type: "nft",
        nftPositions: [single],
        erc20Positions: null,
        error: null,
      };
    }
  }

  // 2 — Full NFT enumeration
  const nftList = await enumerateNftPositions(provider, input, opts);
  if (nftList.length > 0) {
    return {
      type: "nft",
      nftPositions: nftList,
      erc20Positions: null,
      error: null,
    };
  }

  // 3 — ERC-20 fallback
  const erc20 = await _probeErc20(
    provider,
    input.candidateAddress,
    input.walletAddress,
    ethersLib,
  );
  if (erc20) {
    return {
      type: "erc20",
      nftPositions: null,
      erc20Positions: [erc20],
      error: null,
    };
  }

  return {
    type: "unknown",
    nftPositions: null,
    erc20Positions: null,
    error: "No positions found for this wallet / contract combination.",
  };
}

/**
 * Format a DetectionResult into a short human-readable summary.
 * @param {DetectionResult} result
 * @returns {string}
 */
function formatDetectionSummary(result) {
  if (result.type === "nft") {
    const n = result.nftPositions.length;
    return `NFT · ${n} position${n !== 1 ? "s" : ""} found`;
  }
  if (result.type === "erc20") {
    const n = result.erc20Positions.length;
    return `ERC-20 position token · ${n} balance${n !== 1 ? "s" : ""} in wallet`;
  }
  return `Unknown: ${result.error}`;
}

/**
 * Batch-refresh liquidity for a list of cached NFT positions.
 * Reads `positions(tokenId)` on-chain in batches of 10.
 * @param {object}  provider
 * @param {string}  positionManagerAddress
 * @param {string[]} tokenIds
 * @returns {Promise<Map<string, string>>}  tokenId → liquidity string.
 */
async function refreshLpPositionLiquidity(
  provider,
  positionManagerAddress,
  tokenIds,
) {
  const ethersLib = _resolveEthers();
  const contract = new ethersLib.Contract(
    positionManagerAddress,
    NFT_ENUM_ABI,
    provider,
  );
  const result = new Map();
  const BATCH = 10;
  for (let i = 0; i < tokenIds.length; i += BATCH) {
    const batch = tokenIds.slice(i, i + BATCH);
    const positions = await Promise.all(
      batch.map((id) => contract.positions(BigInt(id)).catch(() => null)),
    );
    for (let j = 0; j < batch.length; j++) {
      const p = positions[j];
      result.set(batch[j], p ? String(p.liquidity) : "0");
    }
  }
  return result;
}

// ── exports ──────────────────────────────────────────────────────────────────
module.exports = {
  detectPositionType,
  enumerateNftPositions,
  formatDetectionSummary,
  _probeErc20,
  _probeSingleNft,
  _enumerateOwnerNfts,
  _shapeNftPosition,
  refreshLpPositionLiquidity,
  MAX_NFT_SCAN,
};
