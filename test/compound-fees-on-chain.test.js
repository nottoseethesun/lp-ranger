/**
 * @file test/compound-fees-on-chain.test.js
 * @description The fees a compound's deposit put back, worked out from
 * the chain for a compound whose record names none
 * (src/lib/compound-fees-on-chain.js), the rebuild of the compound list
 * that keeps them on its entry (`compoundHistoryFrom`,
 * src/lib/compound-activity-figures.js), and the counts that read them
 * (src/lib/compounded-coins.js).
 *
 * The fixture compound on NFT #7 collected 10 of token0 and 20 of token1
 * at block 5000, swapped 4 of token0 for 6 of token1 at block 5002, and
 * deposited 8 of token0 and 16 of token1 at block 5005. Its fee coins
 * after the swap are 6 and 26, so the deposit put back 6 of token0 and
 * all 16 of token1: 2 of token0 came from the wallet's other coins, and
 * 10 of token1 stayed in the wallet.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const ethers = require("ethers");
const {
  depositAndCollect,
  feeCoinsAfterSwaps,
  feeFieldsOf,
  walletSwapsBetween,
  feesFromChain,
} = require("../src/lib/compound-fees-on-chain");
const {
  feeRecords,
  namesNoFeesOn,
  compoundedCoinsByNft,
  walletCoinsPutIn,
  feesLeftInWallet,
} = require("../src/lib/compounded-coins");

/*-
 *  The historical price lookup is the rebuild module's one way out of
 *  the process, replaced while it loads.
 */
const _origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "./price-fetcher")
    return {
      fetchHistoricalPriceGecko: async () => ({ price0: 2, price1: 1 }),
    };
  return _origRequire.apply(this, arguments);
};
delete require.cache[require.resolve("../src/lib/compound-activity-figures")];
const { compoundHistoryFrom } = require("../src/lib/compound-activity-figures");
Module.prototype.require = _origRequire;

const WALLET = "0x00000000000000000000000000000000000000aa";
const TOKEN0 = "0x00000000000000000000000000000000000000c0";
const TOKEN1 = "0x00000000000000000000000000000000000000c1";
const ROUTER = "0x00000000000000000000000000000000000000ee";
const COMPOUND_TX = "0x" + "c1".repeat(32);
const SPAN = 9000;

/** An NFT event as the batch read decodes it. */
const ev = (blockNumber, txHash, amount0, amount1, liquidity) => ({
  blockNumber,
  txHash,
  amount0: BigInt(amount0),
  amount1: BigInt(amount1),
  liquidity: liquidity === undefined ? undefined : BigInt(liquidity),
});

/** NFT #7's events: its mint, the compound's collect and its deposit. */
function nftEvents(over = {}) {
  return {
    ilEvents: [
      ev(100, "0xmint", 1000, 1000, 1300),
      ev(5005, COMPOUND_TX, 8, 16, 100),
    ],
    collectEvents: [ev(5000, "0xcollect", 10, 20)],
    dlEvents: [],
    ...over,
  };
}

const COMPOUND = Object.freeze({
  txHash: COMPOUND_TX,
  timestamp: "2026-10-04T12:00:00.000Z",
  tokenId: "7",
  amount0Deposited: "8",
  amount1Deposited: "16",
  usdValue: 32,
});

const SWAP = Object.freeze({ sold: 0, sent: 4n, received: 6n });

const FIELDS = Object.freeze({
  amount0Compounded: "6",
  amount1Compounded: "16",
  amount0FeesLeft: "0",
  amount1FeesLeft: "10",
});

/** A reader of the wallet's swaps that records what it was asked. */
function swapsReader(answer) {
  const asked = [];
  const read = async (range) => {
    asked.push(range);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { asked, read };
}

describe("feeCoinsAfterSwaps", () => {
  it("is what the collect brought in, less what the swaps sold, plus what they bought", () => {
    assert.deepEqual(feeCoinsAfterSwaps({ raw0: 10n, raw1: 20n }, [SWAP]), {
      raw0: 6n,
      raw1: 26n,
    });
    assert.deepEqual(
      feeCoinsAfterSwaps({ raw0: 10n, raw1: 20n }, [
        SWAP,
        { sold: 1, sent: 6n, received: 3n },
      ]),
      { raw0: 9n, raw1: 20n },
      "two chunks of a swap, the second the other way",
    );
  });

  it("is never below none of a coin", () => {
    assert.deepEqual(feeCoinsAfterSwaps({ raw0: 1n, raw1: 0n }, [SWAP]), {
      raw0: 0n,
      raw1: 6n,
    });
  });
});

describe("feeFieldsOf", () => {
  it("counts each coin's fees first, up to the fee coins, the rest of the deposit the wallet's", () => {
    assert.deepEqual(
      feeFieldsOf(
        { amount0Deposited: 8n, amount1Deposited: 16n },
        { raw0: 6n, raw1: 26n },
      ),
      FIELDS,
    );
  });
});

describe("depositAndCollect", () => {
  it("finds the compound's deposit and the collect just before it", () => {
    const found = depositAndCollect(COMPOUND, nftEvents(), SPAN);
    assert.equal(found.own.txHash, COMPOUND_TX);
    assert.equal(found.collect.txHash, "0xcollect");
  });

  it("finds no collect for a deposit with none before it, and no deposit the events do not hold", () => {
    const found = depositAndCollect(
      COMPOUND,
      nftEvents({ collectEvents: [] }),
      SPAN,
    );
    assert.equal(found.collect, null);
    assert.equal(
      depositAndCollect({ txHash: "0xother" }, nftEvents(), SPAN),
      null,
    );
    assert.equal(depositAndCollect(COMPOUND, undefined, SPAN), null);
  });
});

describe("feesFromChain", () => {
  it("reads the wallet's swaps between the collect and the deposit, leaving both out", async () => {
    const reader = swapsReader([SWAP]);
    const got = await feesFromChain(COMPOUND, nftEvents(), {
      span: SPAN,
      walletSwaps: reader.read,
    });
    assert.deepEqual(got, FIELDS);
    assert.deepEqual(reader.asked, [
      { fromBlock: 5000, toBlock: 5005, skip: ["0xcollect", COMPOUND_TX] },
    ]);
  });

  it("counts none of a deposit with no collect before it as fees, asking for no swap", async () => {
    const reader = swapsReader([SWAP]);
    const got = await feesFromChain(
      COMPOUND,
      nftEvents({ collectEvents: [] }),
      { span: SPAN, walletSwaps: reader.read },
    );
    assert.deepEqual(got, {
      amount0Compounded: "0",
      amount1Compounded: "0",
      amount0FeesLeft: "0",
      amount1FeesLeft: "0",
    });
    assert.deepEqual(reader.asked, []);
  });

  it("names no fees when the swaps cannot be read, so the whole deposit still counts", async () => {
    for (const walletSwaps of [
      swapsReader(null).read,
      swapsReader(new Error("endpoint down")).read,
      undefined,
    ])
      assert.deepEqual(
        await feesFromChain(COMPOUND, nftEvents(), { span: SPAN, walletSwaps }),
        {},
      );
  });
});

describe("walletSwapsBetween", () => {
  const TRANSFER = ethers.id("Transfer(address,address,uint256)");
  const pad = (a) => ethers.zeroPadValue(a, 32).toLowerCase();
  const transfer = (coin, from, to, value) => ({
    address: coin,
    topics: [TRANSFER, pad(from), pad(to)],
    data: ethers.toBeHex(value, 32),
  });
  /*- The wallet sent token0 in the swap and in the deposit, and token1
   *  to another wallet in a transaction of its own. */
  const RECEIPTS = {
    "0xswap": {
      logs: [
        transfer(TOKEN0, WALLET, ROUTER, 4),
        transfer(TOKEN1, ROUTER, WALLET, 6),
      ],
    },
    "0xsend": { logs: [transfer(TOKEN1, WALLET, ROUTER, 3)] },
  };
  function provider(receipts = RECEIPTS) {
    const asked = [];
    return {
      asked,
      getLogs: async (f) =>
        f.address === TOKEN0
          ? [{ transactionHash: "0xSWAP" }, { transactionHash: COMPOUND_TX }]
          : [{ transactionHash: "0xsend" }],
      getTransactionReceipt: async (tx) => {
        asked.push(tx);
        return receipts[tx] ?? null;
      },
    };
  }
  const range = (p) => ({
    provider: p,
    ethersLib: ethers,
    wallet: WALLET,
    token0: TOKEN0,
    token1: TOKEN1,
    fromBlock: 5000,
    toBlock: 5005,
    skip: ["0xcollect", COMPOUND_TX],
  });

  it("is each transaction that sent one of the coins from the wallet and paid it the other", async () => {
    const p = provider();
    assert.deepEqual(await walletSwapsBetween(range(p)), [SWAP]);
    assert.deepEqual(p.asked, ["0xswap", "0xsend"], "the deposit is left out");
  });

  it("is null when a transaction's receipt cannot be read", async () => {
    const p = provider({ "0xswap": RECEIPTS["0xswap"] });
    assert.equal(await walletSwapsBetween(range(p)), null);
  });
});

describe("compoundHistoryFrom, for a compound whose record names no fees", () => {
  const events = () => new Map([["7", nftEvents()]]);
  const opts = (over = {}) => ({
    decimals0: 0,
    decimals1: 0,
    price0: 2,
    price1: 1,
    compoundPrices: async () => ({ price0: 2, price1: 1 }),
    ...over,
  });

  it("works them out from the chain and keeps them on the entry", async () => {
    const reader = swapsReader([SWAP]);
    const [entry] = await compoundHistoryFrom([COMPOUND], events(), {
      ...opts(),
      walletSwaps: reader.read,
    });
    assert.deepEqual(
      {
        amount0Compounded: entry.amount0Compounded,
        amount1Compounded: entry.amount1Compounded,
        amount0FeesLeft: entry.amount0FeesLeft,
        amount1FeesLeft: entry.amount1FeesLeft,
      },
      FIELDS,
    );
    assert.equal(entry.trigger, "unknown");
    assert.equal(reader.asked.length, 1);
  });

  it("works them out for a compound the bot recorded before it named them, keeping its trigger", async () => {
    const saved = [{ ...COMPOUND, trigger: "auto" }];
    const reader = swapsReader([SWAP]);
    const [entry] = await compoundHistoryFrom([COMPOUND], events(), {
      ...opts({ savedCompoundHistory: () => saved }),
      walletSwaps: reader.read,
    });
    assert.equal(entry.trigger, "auto");
    assert.equal(entry.amount0Compounded, "6");
  });

  it("keeps the fees an earlier rebuild worked out, and the bot's own, asking the chain for neither", async () => {
    for (const trigger of ["unknown", "manual"]) {
      const saved = [{ ...COMPOUND, ...FIELDS, trigger }];
      const reader = swapsReader([]);
      const [entry] = await compoundHistoryFrom([COMPOUND], events(), {
        ...opts({ savedCompoundHistory: () => saved }),
        walletSwaps: reader.read,
      });
      assert.equal(entry.amount1FeesLeft, "10", trigger);
      assert.deepEqual(reader.asked, [], trigger);
    }
  });
});

describe("the counts, once the entry names the fees", () => {
  const ENTRY = { ...COMPOUND, ...FIELDS, trigger: "unknown" };

  it("count the fees put back as Fees Compounded, not the whole deposit", () => {
    assert.deepEqual(compoundedCoinsByNft([ENTRY], 0, 0), {
      7: { amount0: 6, amount1: 16 },
    });
    assert.ok(feeRecords([ENTRY]).has(COMPOUND_TX.toLowerCase()));
    assert.deepEqual(compoundedCoinsByNft([COMPOUND], 0, 0), {
      7: { amount0: 8, amount1: 16 },
    });
  });

  it("count the wallet's coins the deposit took, and the fees it left", () => {
    assert.deepEqual(walletCoinsPutIn([ENTRY], "7", 0, 0), {
      amount0: 2,
      amount1: 0,
    });
    assert.deepEqual(feesLeftInWallet([ENTRY], "7", 0, 0), {
      amount0: 0,
      amount1: 10,
    });
  });

  it("ask for a rebuild while the NFT holds a compound whose fees are not named", () => {
    assert.equal(namesNoFeesOn([COMPOUND], "7"), true);
    assert.equal(namesNoFeesOn([ENTRY], "7"), false);
    assert.equal(namesNoFeesOn([COMPOUND], "8"), false, "another NFT's");
    assert.equal(namesNoFeesOn(undefined, "7"), false);
  });
});
