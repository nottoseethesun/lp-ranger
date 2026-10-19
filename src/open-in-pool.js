"use strict";

/**
 * @file src/open-in-pool.js
 * @module open-in-pool
 * @description
 * Whether the wallet holds an open position in a pool, other than a
 * given one. A closed position's Manage re-opens it, minting a new
 * position in its pool, and LP Ranger manages one active position per
 * pool (src/pool-already-managed.js), so a re-open is refused while the
 * wallet holds an open position there.
 *
 * The candidates are the wallet scan's (src/lp-position-cache.js), the
 * positions the dashboard's position browser lists, so the server refuses
 * what the page's Manage button already refuses. The cache is as old as
 * the last scan, so the chain is asked whether each candidate the scan
 * saw open is still open and still in the wallet. Only the chain's answer
 * overturns the scan's: a read that fails leaves the candidate open, since
 * an open position nothing has ruled out keeps the pool. A position
 * opened since the last scan is not in the cache, and is unknown here as
 * it is to the page.
 */

const { PM_ABI } = require("./pm-abi");
const { log } = require("./log");
const { emojiId } = require("./logger");
const { poolKeyOf, readPoolOfPosition } = require("./pool-already-managed");
const { loadLpPositionCache } = require("./lp-position-cache");
const { isContractRevert } = require("./rpc-error-classifier");

/**
 * Whether the scan saw `p` holding liquidity.
 * @param {object} p  A scanned position.
 * @returns {boolean}
 */
function _scannedOpen(p) {
  const liq = p.liquidity;
  if (liq === null || liq === undefined) return false;
  try {
    return BigInt(liq) > 0n;
  } catch {
    return false;
  }
}

/**
 * Whether `tokenId`, which the last scan saw open, is still open and in
 * the wallet. It is, unless the chain answers otherwise: its liquidity is
 * zero, another address owns it, or the contract reverts when asked its
 * owner, as it does for a burned NFT. A read that fails answers nothing,
 * an endpoint's error answer included, which ethers labels as it labels
 * a revert (`isContractRevert`).
 * @param {object} pm  The position manager contract.
 * @param {string} tokenId
 * @param {object} o   As for `openInPool`.
 * @returns {Promise<boolean>}
 */
async function _stillOpenInWallet(pm, tokenId, o) {
  const now = await readPoolOfPosition({
    provider: o.provider,
    ethersLib: o.ethersLib,
    positionManager: o.positionManager,
    tokenId,
  });
  if (now !== null && now.liquidity === 0n) return false;
  try {
    const owner = await pm.ownerOf(BigInt(tokenId));
    return owner.toLowerCase() === o.wallet.toLowerCase();
  } catch (err) {
    if (isContractRevert(err)) return false;
    const emoji = emojiId(tokenId);
    log.warn(
      "[pool-rule] Could not read who owns NFT #%s %s: %s; the last wallet scan's answer stands, open in the wallet",
      tokenId,
      emoji,
      err.message,
    );
    return true;
  }
}

/**
 * The token id of an open position the wallet holds in `pool`, other than
 * the one being re-opened, or null.
 * @param {object} o
 * @param {string} o.wallet           The loaded wallet's address.
 * @param {object} o.pool             The pool, as `readPoolOfPosition`
 *   reads it.
 * @param {string} o.tokenId          The position being re-opened.
 * @param {Function} o.poolKeyFn      Canonical key builder, bound to
 *   chain/contract/wallet by the caller.
 * @param {object} o.provider
 * @param {object} o.ethersLib
 * @param {string} o.positionManager
 * @param {string} o.blockchain       The chain's key in chains.json.
 * @param {Function} [o.loadCache]    The scan cache's reader;
 *   `loadLpPositionCache` unless a test passes its own.
 * @returns {Promise<string|null>}
 */
async function openInPool(o) {
  const load = o.loadCache ?? loadLpPositionCache;
  const scan = load(o.wallet, {
    blockchain: o.blockchain,
    contract: o.positionManager,
  });
  if (scan === null) return null;
  const wanted = poolKeyOf(o.pool, o.poolKeyFn);
  if (wanted === null) return null;
  const pm = new o.ethersLib.Contract(o.positionManager, PM_ABI, o.provider);
  for (const p of scan.positions) {
    if (String(p.tokenId) === String(o.tokenId)) continue;
    if (poolKeyOf(p, o.poolKeyFn) !== wanted || !_scannedOpen(p)) continue;
    if (await _stillOpenInWallet(pm, String(p.tokenId), o))
      return String(p.tokenId);
  }
  return null;
}

module.exports = { openInPool };
