/**
 * @file test/compound-fees-put-back.test.js
 * @description A compound names the fees its deposit put back apart from
 *   the coins the wallet already held (src/lib/compounder.js,
 *   src/lib/compounded-coins.js). Run through the real compound, with the
 *   chain and the swap stood in for: the wallet's two coins are read
 *   before the collect, after it, and after the swap, and the deposit
 *   takes the amounts its event reports.
 *
 *   The case the user reported: the wallet holds a deposit of 100 A +
 *   100 B when a compound collects 10 + 10 of fees; its ratio swap runs,
 *   so its deposit is offered the wallet's whole balance and takes all
 *   110 + 110. Only 10 + 10 are fees.
 *
 *   And a deposit the owner sends while the compound runs: it reaches
 *   the wallet between the readings, so only the compound's own
 *   transactions tell it from fees: what the collect reports collecting,
 *   and what the swap sent and received.
 */

"use strict";

const {
  describe,
  it,
  before,
  after,
  beforeEach,
  afterEach,
} = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const {
  initSendTx,
  resetSendTx,
  withPopulate,
  POPULATED,
} = require("./helpers/send-tx-mock");

/** One coin of A (18 decimals) and of B (6 decimals). */
const A = 10n ** 18n;
const B = 10n ** 6n;

/** Whether the stand-in swap says it ran. */
let swapRan = true;

/** What the stand-in swap adds to its result when it ran. */
let swapExtra = {};

/** The amounts each deposit request offered the position. */
const offered = [];

/** The first topic the stand-in interface reads as the collect's event. */
const COLLECT_TOPIC = "0x" + "c".repeat(64);

/** A receipt that confirmed, with the logs given. */
const receipt = (hash, logs = []) => ({
  hash,
  gasUsed: 100000n,
  gasPrice: 1000n,
  effectiveGasPrice: 1000n,
  blockNumber: 1,
  logs,
});

/**
 * Run a compound against a wallet whose two coins read, in turn, as each
 * list gives them, and whose deposit takes `deposited`. With `reported`,
 * the collect's receipt holds the position manager's event naming those
 * amounts collected for this NFT.
 */
async function compound(executeCompound, readings, deposited, reported) {
  const queues = { "0xA": [...readings.a], "0xB": [...readings.b] };
  const collectLogs =
    reported === undefined
      ? []
      : [{ address: "0xPM", topics: [COLLECT_TOPIC], data: "0x" }];
  const collectTx = {
    hash: "0xc",
    nonce: 1,
    type: 2,
    wait: async () => receipt("0xc", collectLogs),
  };
  /*-
   *  `_parseIncreaseLiquidity` reads a log with two topics and at least
   *  130 hex characters of data; the stand-in interface supplies its
   *  amounts.
   */
  const log = {
    topics: ["0x" + "1".repeat(64), "0x" + "2".repeat(64)],
    data: "0x" + "0".repeat(130),
  };
  const depositTx = {
    hash: "0xd",
    nonce: 2,
    type: 2,
    wait: async () => receipt("0xd", [log]),
  };
  const increaseLiquidity = async () => depositTx;
  increaseLiquidity.populateTransaction = async (params) => {
    offered.push({ a: params.amount0Desired, b: params.amount1Desired });
    return POPULATED;
  };
  const ethersLib = {
    Contract: function (addr) {
      return {
        interface: {
          parseLog: (entry) =>
            entry.topics[0] === COLLECT_TOPIC
              ? {
                  name: "Collect",
                  args: {
                    tokenId: 7n,
                    amount0: reported.a,
                    amount1: reported.b,
                  },
                }
              : {
                  name: "IncreaseLiquidity",
                  args: {
                    liquidity: 1n,
                    amount0: deposited.a,
                    amount1: deposited.b,
                  },
                },
        },
        collect: withPopulate(async () => collectTx, POPULATED),
        balanceOf: async () => queues[addr].shift(),
        allowance: async () => 10n ** 40n,
        increaseLiquidity,
      };
    },
  };
  let sent = 0;
  const signer = {
    provider: {
      getFeeData: async () => ({
        gasPrice: 1000n,
        maxFeePerGas: 2000n,
        maxPriorityFeePerGas: 100n,
      }),
    },
    getAddress: async () => "0xWallet",
    sendTransaction: async () => (++sent === 1 ? collectTx : depositTx),
  };
  return executeCompound(signer, ethersLib, {
    positionManagerAddress: "0xPM",
    tokenId: "7",
    token0: "0xA",
    token1: "0xB",
    recipient: "0xWallet",
    decimals0: 18,
    decimals1: 6,
    price0: 1,
    price1: 1,
    trigger: "auto",
  });
}

describe("a compound's fees, apart from the wallet's other coins", () => {
  let executeCompound;
  const _origRequire = Module.prototype.require;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./compounder-swap") {
        const real = _origRequire.apply(this, arguments);
        return {
          ...real,
          swapForCompound: async () =>
            swapRan
              ? {
                  swapped: true,
                  gasCostWei: 0n,
                  txHash: "0xs",
                  gateReason: null,
                  ...swapExtra,
                }
              : {
                  swapped: false,
                  gasCostWei: 0n,
                  txHash: null,
                  gateReason: "dust",
                },
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/lib/compounder")];
    ({ executeCompound } = require("../src/lib/compounder"));
    Module.prototype.require = _origRequire;
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/lib/compounder")];
  });

  beforeEach(() => {
    initSendTx();
    swapExtra = {};
    offered.length = 0;
  });
  afterEach(() => resetSendTx());

  it("counts a swept deposit out of the fees", async () => {
    swapRan = true;
    /*-
     *  The wallet before the collect, after it, and after the swap,
     *  which sold 4 A of the fees for 4 B: the fees became 6 A + 14 B,
     *  and the deposit, offered the whole wallet, took 106 A + 114 B.
     */
    const result = await compound(
      executeCompound,
      { a: [100n * A, 110n * A, 106n * A], b: [100n * B, 110n * B, 114n * B] },
      { a: 106n * A, b: 114n * B },
    );
    assert.equal(result.compounded, true);
    assert.equal(result.depositedAmount0, 106);
    assert.equal(result.depositedAmount1, 114);
    assert.equal(result.amount0Compounded, String(6n * A));
    assert.equal(result.amount1Compounded, String(14n * B));
    assert.deepEqual(result.feesCompounded, { amount0: 6, amount1: 14 });
  });

  it("counts every coin of a deposit that offered only the fees", async () => {
    /*-
     *  No swap: the deposit is offered the 10 + 10 the collect brought
     *  in and takes what fits, 10 A and 4 B. The wallet's own 100 + 100
     *  stay where they are.
     */
    swapRan = false;
    const result = await compound(
      executeCompound,
      { a: [100n * A, 110n * A], b: [100n * B, 110n * B] },
      { a: 10n * A, b: 4n * B },
    );
    assert.equal(result.amount0Compounded, String(10n * A));
    assert.equal(result.amount1Compounded, String(4n * B));
    assert.deepEqual(result.feesCompounded, { amount0: 10, amount1: 4 });
  });

  it("counts a deposit landing during the swap out of the fees", async () => {
    /*-
     *  The collect reports 10 + 10. The swap's own transaction sold 4 A
     *  for 4 B, and 50 B the owner sent reached the wallet meanwhile, so
     *  the wallet reads 106 A + 164 B before the deposit, which takes it
     *  all. The fees are 6 A + 14 B; the readings alone would say 64 B.
     */
    swapRan = true;
    swapExtra = {
      isToken0To1: true,
      exchange: { sent: 4n * A, received: 4n * B },
    };
    const result = await compound(
      executeCompound,
      { a: [100n * A, 110n * A, 106n * A], b: [100n * B, 110n * B, 164n * B] },
      { a: 106n * A, b: 164n * B },
      { a: 10n * A, b: 10n * B },
    );
    assert.equal(result.amount0Compounded, String(6n * A));
    assert.equal(result.amount1Compounded, String(14n * B));
    assert.deepEqual(result.feesCompounded, { amount0: 6, amount1: 14 });
    assert.deepEqual(result.feesCollected, { amount0: 10, amount1: 10 });
  });

  it("offers only the fees when a deposit lands during the collect", async () => {
    /*-
     *  No swap. 50 B the owner sent landed while the collect confirmed,
     *  so the wallet rose 10 A + 60 B; the collect reports 10 + 10. The
     *  deposit is offered the 10 + 10 and the 50 B stay in the wallet,
     *  for the deposit count. The Activity Log's figure reads 10 + 10.
     */
    swapRan = false;
    const result = await compound(
      executeCompound,
      { a: [100n * A, 110n * A], b: [100n * B, 160n * B] },
      { a: 10n * A, b: 4n * B },
      { a: 10n * A, b: 10n * B },
    );
    assert.deepEqual(offered, [{ a: 10n * A, b: 10n * B }]);
    assert.deepEqual(result.feesCollected, { amount0: 10, amount1: 10 });
    assert.equal(result.amount1Compounded, String(4n * B));
  });

  it("takes the wallet's rise when a token keeps part of each transfer", async () => {
    // The collect reports 10 B; the token kept 1 B of it on the way.
    swapRan = false;
    await compound(
      executeCompound,
      { a: [100n * A, 110n * A], b: [100n * B, 109n * B] },
      { a: 10n * A, b: 4n * B },
      { a: 10n * A, b: 10n * B },
    );
    assert.deepEqual(offered, [{ a: 10n * A, b: 9n * B }]);
  });

  it("decides by the readings alone when the swap's exchange is unknown", async () => {
    swapRan = true;
    swapExtra = { isToken0To1: true, exchange: null };
    const result = await compound(
      executeCompound,
      { a: [100n * A, 110n * A, 106n * A], b: [100n * B, 110n * B, 164n * B] },
      { a: 106n * A, b: 164n * B },
      { a: 10n * A, b: 10n * B },
    );
    assert.equal(result.amount1Compounded, String(64n * B));
  });
});
