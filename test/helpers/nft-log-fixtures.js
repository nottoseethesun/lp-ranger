"use strict";

/**
 * @file test/helpers/nft-log-fixtures.js
 * @description Position-manager logs and a node that serves them, for
 *   tests of the per-NFT and whole-chain event reads.
 *
 *   The node filters the way a real one does — by address, block range,
 *   topic0, and topic1 matched against a single value or OR-matched
 *   against an array — so a test can put another NFT's logs in the same
 *   range and see them stay out.  The real position-manager ABI is used
 *   throughout; a hand-written topic hash would pass while matching
 *   nothing on chain.
 */

const { ethers } = require("ethers");
const config = require("../../src/config");
const { PM_ABI } = require("../../src/pm-abi");
const { topicForTokenId } = require("../../src/nft-events-batch");

const IFACE = new ethers.Interface(PM_ABI);

/** The address the app reads position-manager logs from. */
const PM = config.POSITION_MANAGER;

/**
 * A log as an RPC returns it, for `name` / `tokenId` at `blockNumber`.
 * Its body is empty, so only a stub decoder can read it.
 */
function logFor(name, tokenId, blockNumber) {
  return {
    address: PM,
    topics: [IFACE.getEvent(name).topicHash, topicForTokenId(tokenId)],
    data: "0x",
    blockNumber,
    transactionHash: "0xabc",
  };
}

/**
 * A log the real decoder can read.
 *
 * @param {string} name     Event name.
 * @param {string} tokenId  Indexed token id.
 * @param {Array} args      The event's remaining arguments, in ABI order.
 * @param {number} blockNumber
 * @param {number} [index=0]  Position within the block.
 */
function encodedLog(name, tokenId, args, blockNumber, index = 0) {
  const { topics, data } = IFACE.encodeEventLog(name, [
    BigInt(tokenId),
    ...args,
  ]);
  return {
    address: PM,
    topics,
    data,
    blockNumber,
    index,
    transactionHash:
      "0x" + (blockNumber * 1000 + index).toString(16).padStart(64, "0"),
  };
}

/**
 * Node that serves a fixed log set, recording every call.
 *
 * @param {object[]} logs
 * @param {number} [head=1000]  What `getBlockNumber` answers.
 */
function makeProvider(logs, head = 1000) {
  const calls = [];
  return {
    calls,
    async getBlockNumber() {
      calls.push({ method: "getBlockNumber" });
      return head;
    },
    async getLogs({ address, fromBlock, toBlock, topics }) {
      calls.push({ method: "getLogs", fromBlock, toBlock, topics });
      const [t0, t1] = topics;
      const wanted = Array.isArray(t1) ? new Set(t1) : new Set([t1]);
      return logs.filter(
        (l) =>
          l.address === address &&
          l.topics[0] === t0 &&
          wanted.has(l.topics[1]) &&
          l.blockNumber >= fromBlock &&
          l.blockNumber <= toBlock,
      );
    },
  };
}

module.exports = { IFACE, PM, logFor, encodedLog, makeProvider };
