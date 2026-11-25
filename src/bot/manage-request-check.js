/**
 * @file src/bot/manage-request-check.js
 * @module manageRequestCheck
 * @description
 * What a Manage request (`POST /api/position/manage`) must carry before
 * anything is started: a numeric tokenId, no contract but this server's
 * position manager, a loaded wallet and a key to sign with, each
 * `invalid` when missing. It is also `refused` while the app may start
 * nothing: during the start-up, since a saved position it has yet to
 * reach may be in the same pool; during a wallet import, since the wallet
 * and its key are being swapped; and once the app is stopping
 * (src/bot/app-phase.js). The key is asked for first, so in the second of
 * an import between the old key's removal and the new key's arrival, a
 * Manage is `invalid` for want of a key rather than `refused`. Refused
 * here, the request starts no bot loop and creates no slot. The reasons
 * are the bot's; the server turns each into its http status
 * (src/server/bot-result.js).
 *
 * The bot's Manage (`manage`, src/bot/position-lifecycle.js) asks it
 * first; grouping the checks into one predicate costs that operation one
 * branch rather than four, leaving room under the complexity cap for the
 * checks that actually decide something.
 */

"use strict";

const config = require("../lib/config");
const { refusalToStart } = require("./app-phase");

/**
 * Whether a request's `contract` names this server's position manager.
 *
 * The bot drives that contract only, so a request naming another would
 * get a running slot whose key describes a contract nothing reads. An
 * address is the same address in any letter case — EIP-55 capitals are
 * a checksum, not part of it — so the comparison ignores case. No
 * contract at all is this server's by default.
 *
 * @param {*} named  The request's `contract`.
 * @returns {boolean}
 */
function _isOwnContract(named) {
  if (named === undefined || named === null) return true;
  return (
    typeof named === "string" &&
    named.toLowerCase() === config.POSITION_MANAGER.toLowerCase()
  );
}

/**
 * Whether a request's `tokenId` is an NFT id: digits only, sent as a
 * string or a number.
 * @param {*} id
 * @returns {boolean}
 */
function _isTokenId(id) {
  return (
    (typeof id === "string" || typeof id === "number") &&
    /^\d+$/.test(String(id))
  );
}

/**
 * Say why a Manage request must be refused, or null when it may go on.
 *
 * @param {object} body       The request body.
 * @param {string|null} wallet  The loaded wallet's address, if any.
 * @param {string|null} pk    The key to sign with, if any.
 * @returns {{reason: "invalid"|"refused", error: string}|null}
 */
function manageRequestRefusal(body, wallet, pk) {
  if (!_isTokenId(body.tokenId))
    return {
      reason: "invalid",
      error: "Missing or invalid tokenId (must be numeric)",
    };
  if (!_isOwnContract(body.contract))
    return {
      reason: "invalid",
      error:
        `contract ${body.contract} is not this server's position manager ` +
        `(${config.POSITION_MANAGER})`,
    };
  if (wallet === null || wallet === undefined)
    return { reason: "invalid", error: "No wallet loaded" };
  if (pk === null || pk === undefined)
    return { reason: "invalid", error: "No private key available" };
  const busy = refusalToStart();
  return busy === null ? null : { reason: "refused", error: busy };
}

module.exports = { manageRequestRefusal };
