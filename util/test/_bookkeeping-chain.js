"use strict";

/**
 * @file util/test/_bookkeeping-chain.js
 * @description
 * Test-only builders for the bookkeeping tools' suites. Logs and receipts
 * are encoded from the same event declarations the tools decode, so each
 * is one a real receipt could hold. `standInChain` answers the questions
 * the wallet report asks of a chain (receipts, whole blocks, the wallet's
 * count of transactions at a block, the position manager's logs) from a
 * list of transactions, so no suite reaches the network.
 *
 * Not a `*.test.js` file, so `node --test` never runs it directly; it is
 * required by the suites that need it.
 */

const { ethers } = require("ethers");
const { EVENTS } = require("../bookkeeping/coins-in-transaction");

/**
 * A 32-byte topic holding an address or a number.
 * @param {string|bigint} value
 * @returns {string}
 */
function topic(value) {
  const hex = typeof value === "bigint" ? ethers.toBeHex(value) : value;
  return ethers.zeroPadValue(hex, 32);
}

/**
 * A log of one of the events the tools read, as a receipt holds it.
 * @param {string} address  The contract that emitted it.
 * @param {string} name     The event's name in `EVENTS`.
 * @param {Array} values    The event's values, in order.
 * @returns {{address: string, topics: string[], data: string}}
 */
function eventLog(address, name, values) {
  const { topics, data } = EVENTS.encodeEventLog(name, values);
  return { address, topics, data };
}

/**
 * An NFT event with four topics and no data: the position manager's
 * `Transfer`, or its `Approval` when `name` says so.
 * @param {string} positionManager
 * @param {string} from
 * @param {string} to
 * @param {bigint} tokenId
 * @param {string} [name]
 * @returns {{address: string, topics: string[], data: string}}
 */
function nftLog(positionManager, from, to, tokenId, name = "Transfer") {
  return {
    address: positionManager,
    topics: [
      EVENTS.getEvent(name).topicHash,
      topic(from),
      topic(to),
      topic(tokenId),
    ],
    data: "0x",
  };
}

/**
 * A receipt as ethers returns one: succeeded, at block 1234, having paid
 * 1,000 of the chain's own coin in gas, unless `fields` says otherwise.
 * @param {object[]} logs
 * @param {object} fields  At least `hash`, `from` and `to`.
 * @returns {object}
 */
function receiptOf(logs, fields) {
  return {
    status: 1,
    blockNumber: 1234,
    gasUsed: 200000n,
    gasPrice: 5000000000000000n,
    logs,
    ...fields,
  };
}

/**
 * Whether a log matches a filter's topics: each place either unset, one
 * topic, or a list of topics any of which will do.
 * @param {string[]} topics  The log's topics.
 * @param {Array<string|string[]|null>} wanted  The filter's.
 * @returns {boolean}
 */
function topicsMatch(topics, wanted) {
  return wanted.every((want, i) => {
    if (want === null || want === undefined) return true;
    return Array.isArray(want) ? want.includes(topics[i]) : want === topics[i];
  });
}

/**
 * A stand-in chain holding `txs`. A block's time is `blockTime` times its
 * number, in seconds; the wallet's count at a block is how many of its
 * transactions came at or before it, on top of 40 sent long before.
 *
 * @param {{wallet: string, blockTime: number, txs: Array<{hash: string,
 *   blockNumber: number, from: string, nonce: number, value?: bigint,
 *   receipt: object}>}} chain
 * @returns {object}  A provider, with `asked` counting what was asked.
 */
function standInChain({ wallet, blockTime, txs }) {
  const asked = { receipts: 0, blocks: 0, counts: 0, logs: 0 };
  const logs = txs.flatMap((t) =>
    t.receipt.logs.map((l) => ({
      ...l,
      blockNumber: t.blockNumber,
      transactionHash: t.hash,
    })),
  );
  const mine = txs.filter((t) => t.from.toLowerCase() === wallet.toLowerCase());
  return {
    asked,
    async getTransactionReceipt(hash) {
      asked.receipts += 1;
      const tx = txs.find((t) => t.hash === hash);
      if (tx === undefined) return null;
      return {
        ...tx.receipt,
        hash,
        from: tx.from,
        blockNumber: tx.blockNumber,
      };
    },
    async getBlock(number) {
      asked.blocks += 1;
      return {
        timestamp: number * blockTime,
        prefetchedTransactions: txs
          .filter((t) => t.blockNumber === number)
          .map((t) => ({ ...t, value: t.value ?? 0n })),
      };
    },
    async getTransactionCount(address, block) {
      asked.counts += 1;
      return 40 + mine.filter((t) => t.blockNumber <= block).length;
    },
    async getLogs(filter) {
      asked.logs += 1;
      return logs.filter(
        (l) =>
          l.address.toLowerCase() === filter.address.toLowerCase() &&
          l.blockNumber >= filter.fromBlock &&
          l.blockNumber <= filter.toBlock &&
          topicsMatch(l.topics, filter.topics),
      );
    },
  };
}

module.exports = { topic, eventLog, nftLog, receiptOf, standInChain };
