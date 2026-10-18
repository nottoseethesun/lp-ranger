/**
 * @file dashboard-answer-position.js
 * @description Whether an answer from the server is about the position
 *   on screen.
 *
 *   The operator can move to another position while a request is under
 *   way: a Stop Managing waits for the position's check under way, which
 *   can be a rebalance, and a re-open answers only once its first
 *   rebalance is done. What an answer does to the screen, from refetching
 *   the position's figures to opening a dialog, then belongs to a
 *   position no longer there. So the server names, in every answer about
 *   a position, the position it is about (`src/position-answer-tag.js`):
 *   `positionKey`, the full key the request named, and `livePositionKey`
 *   when a rebalance minted the position a new NFT meanwhile. An answer
 *   is for the screen when either is the key of the position on screen.
 *
 *   An answer that names no position is about the one the request
 *   named, so the caller passes that key too. It stands in for the
 *   server's when there is no answer at all, a request the server never
 *   received included.
 */

import { compositeKey } from "./dashboard-helpers.js";
import { posStore } from "./dashboard-positions-store.js";
import { activeChainId } from "./dashboard-chain.js";

/**
 * The full key of the position on screen, or null when there is none.
 * @returns {string|null}
 */
export function positionKeyOnScreen() {
  const a = posStore.getActive();
  if (!a) return null;
  return compositeKey(
    activeChainId(),
    a.walletAddress,
    a.contractAddress,
    a.tokenId,
  );
}

/**
 * Whether `answer` is about the position on screen.
 *
 * Keys are compared without regard to case: the addresses in them are
 * the same address however their letters are cased.
 *
 * @param {object|null|undefined} answer  The server's answer, if any.
 * @param {string|null|undefined} requestKey  The key the request named.
 * @returns {boolean}
 */
export function isAnswerForPositionOnScreen(answer, requestKey) {
  const onScreen = positionKeyOnScreen();
  if (onScreen === null) return false;
  const named = [answer?.positionKey, answer?.livePositionKey].filter(
    (k) => typeof k === "string" && k !== "",
  );
  if (named.length === 0 && typeof requestKey === "string")
    named.push(requestKey);
  const want = onScreen.toLowerCase();
  return named.some((k) => k.toLowerCase() === want);
}
