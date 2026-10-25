/**
 * @file src/lib/swap-exchange.js
 * @module swap-exchange
 * @description
 * What one swap transaction moved between the wallet and the market,
 * read from its receipt's ERC-20 `Transfer` logs: what the wallet sent of
 * the token sold, and what it was paid of the token bought, each net of
 * any of it coming back to where it came from.
 *
 * A swap LP Ranger makes is read this way once it lands, so that a
 * compound counts its fees by its own exchange rather than by the rise in
 * the wallet, which a deposit landing meanwhile would swell
 * (`balanceDiff`, src/lib/rebalancer-swap-balance.js). A compound LP Ranger
 * did not record as it made it is read the same way from the chain
 * (src/lib/compound-fees-on-chain.js).
 *
 * Dependency-free: it reads only the receipt it is handed.
 */

"use strict";

/** An ERC-20 `Transfer(address,address,uint256)` event's first topic. */
const _TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The address an indexed topic holds, lower-cased. */
function _topicAddress(topic) {
  return ("0x" + String(topic).slice(26)).toLowerCase();
}

/** A receipt log read as an ERC-20 transfer, or null when it is none. */
function _transferIn(l) {
  if (l?.topics?.[0] !== _TRANSFER_TOPIC || l.topics.length < 3) return null;
  if (typeof l.data !== "string" || l.data.length < 66) return null;
  return {
    coin: String(l.address).toLowerCase(),
    from: _topicAddress(l.topics[1]),
    to: _topicAddress(l.topics[2]),
    value: BigInt(l.data.slice(0, 66)),
  };
}

/** What one transfer moves of a coin into the wallet, out of it negative. */
function _intoWallet(t, coin, me) {
  if (t.coin !== coin) return 0n;
  return (t.to === me ? t.value : 0n) - (t.from === me ? t.value : 0n);
}

/**
 * What one swap transaction moved between the wallet and the market, read
 * from its own receipt: the token sold the wallet sent, and the token
 * bought it was paid, each net of any of it coming back to where it came
 * from. A deposit the owner made meanwhile is a transaction of its own,
 * so it is in neither.
 *
 * @param {object|null|undefined} receipt  The swap's receipt.
 * @param {string} tokenIn    Address of the token sold.
 * @param {string} tokenOut   Address of the token bought.
 * @param {string} recipient  The wallet.
 * @returns {{sent: bigint, received: bigint}|null}  Null with no receipt
 *   to read.
 */
function exchangeInTx(receipt, tokenIn, tokenOut, recipient) {
  if (!Array.isArray(receipt?.logs)) return null;
  const me = String(recipient).toLowerCase();
  const sold = String(tokenIn).toLowerCase();
  const bought = String(tokenOut).toLowerCase();
  let sent = 0n;
  let received = 0n;
  for (const l of receipt.logs) {
    const t = _transferIn(l);
    if (t === null) continue;
    sent -= _intoWallet(t, sold, me);
    received += _intoWallet(t, bought, me);
  }
  return {
    sent: sent > 0n ? sent : 0n,
    received: received > 0n ? received : 0n,
  };
}

module.exports = { exchangeInTx };
