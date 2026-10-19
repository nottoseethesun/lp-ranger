/**
 * @file src/manage-request-check.js
 * @module manageRequestCheck
 * @description
 * What a Manage request (`POST /api/position/manage`) must carry before
 * anything is started: a numeric tokenId, no contract but this server's
 * position manager, a loaded wallet and a key to sign with. It is also
 * refused, with 409, while the app may start nothing: during the
 * start-up, since a saved position it has yet to reach may be in the
 * same pool, and once the app is stopping (src/app-phase.js). Refused
 * here, the request starts no bot loop and creates no slot.
 *
 * Split out of `src/server-positions.js`, whose `handleManage` asks it
 * first; grouping the checks into one predicate costs that handler one
 * branch rather than four, leaving room under the complexity cap for the
 * checks that actually decide something.
 */

"use strict";

const config = require("./config");
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
 * @returns {{status: number, error: string}|null}
 */
function manageRequestRefusal(body, wallet, pk) {
  if (!_isTokenId(body.tokenId))
    return {
      status: 400,
      error: "Missing or invalid tokenId (must be numeric)",
    };
  if (!_isOwnContract(body.contract))
    return {
      status: 400,
      error:
        `contract ${body.contract} is not this server's position manager ` +
        `(${config.POSITION_MANAGER})`,
    };
  if (wallet === null || wallet === undefined)
    return { status: 400, error: "No wallet loaded" };
  if (pk === null || pk === undefined)
    return { status: 400, error: "No private key available" };
  const busy = refusalToStart();
  return busy === null ? null : { status: 409, error: busy };
}

module.exports = { manageRequestRefusal };
