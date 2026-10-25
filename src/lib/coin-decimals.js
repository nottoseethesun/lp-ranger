"use strict";

/**
 * @file src/lib/coin-decimals.js
 * @module coin-decimals
 * @description
 * The two coins' decimals a rebalance result or a position carries, for
 * turning raw amounts into coin amounts and dollars.
 *
 * Both are expected to carry them. A successful rebalance's result is
 * built by `_buildRebalanceResult` (src/lib/rebalancer-execute.js), which
 * copies them from the pool state, and the pool state refuses a coin
 * whose decimals cannot be read; a managed position has them resolved
 * before its first scan. Should one arrive without them, its amounts are
 * valued as 18-decimal coins, the most common kind, and the guess is
 * logged: for a 6-decimal coin, USDC for one, the figures it produces are
 * wrong by a factor of a trillion, and the log line is how an operator
 * would trace them back.
 */

const { log } = require("./log");
const { emojiId } = require("./logger");

/**
 * The decimals of both coins, 18 standing in for any not carried, with a
 * warning naming each one guessed.
 *
 * @param {object} holder  A rebalance result or a position.
 * @param {string} holderName  What `holder` is, for the log line: "the
 *   rebalance result", "the position".
 * @param {string} reader  What is valuing it, for the log line.
 * @returns {{d0: number, d1: number}}
 */
function coinDecimals(holder, holderName, reader) {
  const missing = [];
  if (holder.decimals0 === undefined || holder.decimals0 === null)
    missing.push("token0");
  if (holder.decimals1 === undefined || holder.decimals1 === null)
    missing.push("token1");
  if (missing.length > 0) {
    const tokenId = String(
      holder.newTokenId ?? holder.tokenId ?? holder.oldTokenId ?? "?",
    );
    log.warn(
      "[decimals] NFT #%s %s: %s names no decimals for %s — %s assumes 18, so its figures are wrong for a coin with other decimals",
      tokenId,
      emojiId(tokenId),
      holderName,
      missing.join(" and "),
      reader,
    );
  }
  return { d0: holder.decimals0 ?? 18, d1: holder.decimals1 ?? 18 };
}

module.exports = { coinDecimals };
