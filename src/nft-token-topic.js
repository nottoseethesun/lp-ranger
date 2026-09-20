"use strict";

/**
 * @file src/nft-token-topic.js
 * @module nft-token-topic
 * @description
 * A position NFT's token id as a log topic word: the form a `getLogs`
 * filter needs in order to match that id.
 *
 * Every position-manager event that names an NFT carries its `tokenId`
 * as an indexed `uint256` — the first indexed parameter of
 * `IncreaseLiquidity`, `Collect` and `DecreaseLiquidity`, and the third
 * of `Transfer`. An indexed `uint256` is stored as its 32-byte
 * big-endian value, so the topic is the id in hex, left-padded to 64
 * digits.
 *
 * **Dependency-free.** It has no imports, so any module that filters
 * logs by token id can require it without forming a dependency cycle or
 * loading `ethers`.
 */

/**
 * A token id as a 32-byte topic word.
 *
 * @param {string|number|bigint} tokenId
 * @returns {string}  0x-prefixed, 64 hex digits.
 */
function topicForTokenId(tokenId) {
  return "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
}

module.exports = { topicForTokenId };
