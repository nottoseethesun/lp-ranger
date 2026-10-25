"use strict";

/**
 * @file src/lib/position-answer-tag.js
 * @module position-answer-tag
 * @description
 * The fields that name the position an answer is about.
 *
 * A dashboard tab asks about the position on its screen, and the
 * operator can move to another before the answer arrives: a Stop
 * Managing waits for the position's check under way, which can be a
 * rebalance, and a re-open answers only once its first rebalance is
 * done. So every answer about a position names it, by its full key
 * (`blockchain-wallet-contract-tokenId`), and the dashboard keeps an
 * answer that names another position off the screen
 * (`src/client/web/dashboard-answer-position.js`).
 *
 * `positionKey` is the key the request named, or the one the server
 * built from what it named. A rebalance can mint the position a new NFT
 * while the request is under way, and the server then acts on the new
 * key: `livePositionKey` carries it, so a dashboard that has followed the
 * position to its new NFT still knows the answer is for the position on
 * its screen.
 */

/**
 * The tag for an answer about one position.
 * @param {*} requestKey      The key the request named.
 * @param {string} [liveKey]  The key the server acted on.
 * @returns {{positionKey?: string, livePositionKey?: string}}  Empty when
 *   the request named no key; `livePositionKey` only when a rebalance
 *   moved the key.
 */
function positionTag(requestKey, liveKey) {
  if (typeof requestKey !== "string" || requestKey === "") return {};
  const tag = { positionKey: requestKey };
  if (typeof liveKey === "string" && liveKey !== requestKey)
    tag.livePositionKey = liveKey;
  return tag;
}

module.exports = { positionTag };
