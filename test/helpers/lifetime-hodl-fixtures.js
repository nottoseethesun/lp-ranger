/**
 * @file test/helpers/lifetime-hodl-fixtures.js
 * @description Shared fixtures for the `src/lifetime-hodl.js` test files:
 * the three NFT event shapes, a chain of two NFTs, and the provider and
 * ethers stubs the fresh-deposit scan reads through. Each file used to
 * carry its own copy, which drifted the moment one grew a case the
 * others did not have — the wrap tests needed an `id()` that tells the
 * `Deposit` event from `Transfer`, and only their copy had it.
 */

"use strict";

/** `Transfer(address,address,uint256)`. */
const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** `Deposit(address,uint256)` — the wrapped-native wrap event. */
const DEPOSIT_TOPIC0 =
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

/**
 * An `IncreaseLiquidity` event.
 *
 * @param {bigint|number|string} a0  Token0 amount, raw units.
 * @param {bigint|number|string} a1  Token1 amount, raw units.
 * @param {number} [block]  Block number.
 * @returns {object}
 */
function ilEvent(a0, a1, block = 100) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}

/**
 * A `Collect` event.
 *
 * @param {bigint|number|string} a0  Token0 amount, raw units.
 * @param {bigint|number|string} a1  Token1 amount, raw units.
 * @param {number} [block]  Block number.
 * @returns {object}
 */
function colEvent(a0, a1, block = 200) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}

/**
 * A `DecreaseLiquidity` event.
 *
 * @param {bigint|number|string} liq  Liquidity released.
 * @param {number} [block]  Block number.
 * @param {bigint|number|string} [a0]  Token0 principal released.
 * @param {bigint|number|string} [a1]  Token1 principal released.
 * @returns {object}
 */
function dlEvent(liq, block = 150, a0 = 0, a1 = 0) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    liquidity: BigInt(liq),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}

/** A log matches a filter's topics when every named slot agrees. */
function _topicsMatch(lt, ft) {
  if (!ft) return true;
  return ft.every((f, i) => f === null || lt[i] === f);
}

/**
 * A provider that serves canned logs, transactions and balances.
 *
 * @param {object} [opts]
 * @param {object[]} [opts.logs]  Logs, filtered by address, block range
 *   and topics exactly as a node would.
 * @param {object} [opts.txs]  Transactions by hash.
 * @param {object} [opts.balances]  `balanceOf` answers, by token address
 *   then block tag.
 * @returns {object}
 */
function mockProvider(opts = {}) {
  const balances = opts.balances || {};
  const logs = opts.logs || [];
  const txs = opts.txs || {};
  return {
    getLogs(filter) {
      return Promise.resolve(
        logs.filter(
          (l) =>
            l.address === filter.address &&
            l.blockNumber >= filter.fromBlock &&
            l.blockNumber <= filter.toBlock &&
            _topicsMatch(l.topics, filter.topics),
        ),
      );
    },
    getTransaction(hash) {
      return Promise.resolve(txs[hash] || null);
    },
    _balances: balances,
  };
}

/**
 * The slice of ethers the fresh-deposit scan uses.
 *
 * @returns {object}  `Contract`, `zeroPadValue` and `id`.
 */
function mockEthers() {
  return {
    Contract: class {
      constructor(addr, _abi, prov) {
        this._addr = addr;
        this._prov = prov;
      }
      async balanceOf(_w, opts = {}) {
        const b = opts.blockTag || "latest";
        return (this._prov._balances[this._addr] || {})[b] ?? 0n;
      }
    },
    zeroPadValue(addr, _len) {
      return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
    },
    id(sig) {
      return sig === "Deposit(address,uint256)"
        ? DEPOSIT_TOPIC0
        : TRANSFER_TOPIC0;
    },
  };
}

/**
 * A two-NFT chain: #50 drains into #100.
 *
 * @param {bigint|number|string} drain0  Token0 collected on the drain.
 * @param {bigint|number|string} drain1  Token1 collected on the drain.
 * @param {bigint|number|string} mint0   Token0 the new NFT was minted with.
 * @param {bigint|number|string} mint1   Token1 the new NFT was minted with.
 * @returns {{events: Map<string, object>, rebalanceEvents: object[]}}
 */
function twoNftFixture(drain0, drain1, mint0, mint1) {
  const events = new Map();
  events.set("50", {
    ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
    collectEvents: [colEvent(drain0, drain1, 200)],
    dlEvents: [dlEvent(1000, 150)],
  });
  events.set("100", {
    ilEvents: [ilEvent(mint0, mint1, 210)],
    collectEvents: [],
    dlEvents: [],
  });
  const rebalanceEvents = [{ oldTokenId: "50", newTokenId: "100" }];
  return { events, rebalanceEvents };
}

module.exports = {
  TRANSFER_TOPIC0,
  DEPOSIT_TOPIC0,
  ilEvent,
  colEvent,
  dlEvent,
  mockProvider,
  mockEthers,
  twoNftFixture,
};
