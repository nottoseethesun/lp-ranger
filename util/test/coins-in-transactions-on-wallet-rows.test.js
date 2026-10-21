"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet-rows.test.js
 * @description
 * Tests for the rows of the wallet bookkeeping report and the steps that
 * build them: the csv cells (`coins-in-transactions-on-wallet/csv.js`),
 * and from `index.js` which transactions belong to a move, how a move is
 * named, where a rebalance's drain and a move's coins are found, and when
 * the chain is asked a coin's symbol and decimals. Records are built by
 * `coins-in-transaction.js` from receipts encoded in
 * `_bookkeeping-chain.js`, so every row is one a real transaction could
 * give.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");

const { eventLog, receiptOf, standInChain } = require("./_bookkeeping-chain");
const { readReceipt } = require("../bookkeeping/coins-in-transaction");
const {
  columns,
  priceText,
  usdValue,
  usd,
  coins,
  moved,
  takenOut,
  inPool,
  coinsToPrice,
  otherCoins,
  rowOf,
  csvCell,
  toCsv,
} = require("../bookkeeping/coins-in-transactions-on-wallet/csv");
const {
  describe: nameOf,
  belongsTo,
  lastOf,
  drainBlockOf,
  poolOf,
  learnCoins,
  pricesOn,
  failureText,
} = require("../bookkeeping/coins-in-transactions-on-wallet");
const { PRICE_ADVICE } = require("../bookkeeping/usd-prices");
const { RPC_ADVICE } = require("../bookkeeping/coins-in-transaction");

const PM = "0x2222222222222222222222222222222222222222";
const WALLET = "0x1111111111111111111111111111111111111111";
const POOL = "0x5555555555555555555555555555555555555555";
const COIN0 = "0x3333333333333333333333333333333333333333";
const COIN1 = "0x4444444444444444444444444444444444444444";
const ELSEWHERE = "0x7777777777777777777777777777777777777777";
const hash = (n) => "0x" + String(n).padStart(64, "0");
const POOL_COINS = { token0: COIN0, token1: COIN1 };

/**
 * A transaction's record, read from a receipt of these logs.
 * @param {object[]} logs
 * @param {object} [fields]
 * @returns {object}
 */
function recordOf(logs, fields = {}) {
  const receipt = receiptOf(logs, {
    hash: hash(1),
    from: WALLET,
    to: PM,
    ...fields,
  });
  return readReceipt(receipt, { wallet: WALLET, positionManager: PM });
}

const DRAIN = recordOf([
  eventLog(PM, "DecreaseLiquidity", [7n, 1n, 100n, 0n]),
  eventLog(COIN0, "Transfer", [POOL, WALLET, 103n]),
  eventLog(COIN1, "Transfer", [POOL, WALLET, 9n]),
  eventLog(PM, "Collect", [7n, WALLET, 103n, 9n]),
]);

const COLLECT = recordOf([
  eventLog(COIN0, "Transfer", [POOL, WALLET, 4n]),
  eventLog(COIN0, "Transfer", [POOL, WALLET, 1n]),
  eventLog(PM, "Collect", [7n, WALLET, 5n, 6n]),
]);

/* ---------- cells ---------- */

test("columns name the gas and value in the chain's own coin", () => {
  const names = columns("tPLS");
  assert.equal(names[0], "date");
  assert.ok(names.includes("gas_paid_tPLS"));
  assert.ok(names.includes("value_sent_tPLS"));
  assert.equal(names.at(-1), "other_coins");
});

test("columns follow each amount with its USD value, and give the prices", () => {
  const names = columns("PLS");
  for (const amount of [
    "token0_out",
    "token0_in",
    "token1_out",
    "token1_in",
    "token0_principal",
    "token1_principal",
    "token0_fees",
    "token1_fees",
  ]) {
    assert.equal(names[names.indexOf(amount) + 1], `${amount}_usd`, amount);
  }
  assert.equal(names[names.indexOf("token0_address") + 1], "token0_usd_price");
  assert.equal(names[names.indexOf("token1_address") + 1], "token1_usd_price");
  assert.deepEqual(
    names.slice(names.indexOf("gas_paid_PLS"), names.indexOf("other_coins")),
    [
      "gas_paid_PLS",
      "PLS_usd_price",
      "gas_paid_usd",
      "value_sent_PLS",
      "value_sent_usd",
    ],
  );
});

test("priceText writes plain decimals, never an exponent, and empty for none", () => {
  assert.equal(priceText(2), "2");
  assert.equal(priceText(0.5), "0.5");
  assert.equal(priceText(6.933786466e-8), "0.00000006933786466");
  assert.equal(priceText(undefined), "");
});

test("usd values the coins at the price, with two to six decimals", () => {
  assert.equal(usdValue(2500000000000000000n, 18, 2), "5.00");
  assert.equal(usdValue(1n, 0, 0.0000314159), "0.000031");
  assert.equal(usdValue(0n, 18, 2), "0.00");
  assert.equal(usd(0n, 18, 2), "");
  assert.equal(usd(1500000n, 6n, 0.5), "0.75");
});

test("coinsToPrice names the pool's coins a row shows and every other coin", () => {
  assert.deepEqual(coinsToPrice(DRAIN, POOL_COINS, ["7"]), [COIN0, COIN1]);
  assert.deepEqual(coinsToPrice(COLLECT, POOL_COINS, ["7"]), [COIN0, COIN1]);
  const outside = recordOf([
    eventLog(ELSEWHERE, "Transfer", [WALLET, POOL, 2n]),
    eventLog(ELSEWHERE, "Transfer", [POOL, WALLET, 3n]),
  ]);
  assert.deepEqual(coinsToPrice(outside, POOL_COINS, ["7"]), [ELSEWHERE]);
  const none = recordOf([]);
  assert.deepEqual(coinsToPrice(none, POOL_COINS, ["7"]), []);
  assert.equal(inPool(COIN0.toLowerCase(), POOL_COINS), true);
  assert.equal(inPool(ELSEWHERE, POOL_COINS), false);
});

test("pricesOn asks for each coin's price at the transaction's block and time", async () => {
  const asked = [];
  const ctx = {
    usdPriceOn: async (coin, moment) => {
      asked.push([coin, moment]);
      return coin === COIN0 ? 2 : 0.5;
    },
  };
  const moment = { timestamp: 1760875200, blockNumber: 26_400_000 };
  const prices = await pricesOn([COIN0, COIN1], moment, ctx);
  assert.deepEqual(
    [...prices.entries()],
    [
      [COIN0.toLowerCase(), 2],
      [COIN1.toLowerCase(), 0.5],
    ],
  );
  assert.deepEqual(asked, [
    [COIN0, moment],
    [COIN1, moment],
  ]);
});

test("failureText says what to try for a price, an endpoint or the key, and nothing else", () => {
  const price = Object.assign(new Error("no USD price"), {
    priceUnavailable: true,
  });
  assert.equal(failureText(price, "http://e"), `no USD price\n${PRICE_ADVICE}`);
  const rpc = Object.assign(new Error("timeout"), { rpcFailure: true });
  assert.equal(
    failureText(rpc, "http://e"),
    `http://e failed: timeout\n${RPC_ADVICE}`,
  );
  const key = Object.assign(new Error("Moralis refused the api key."), {
    keyRefused: true,
  });
  assert.equal(failureText(key, "http://e"), "Moralis refused the api key.");
  assert.equal(failureText(new Error("a bug"), "http://e"), null);
});

test("coins divides by the decimals exactly, and leaves nothing empty", () => {
  assert.equal(coins(0n, 18), "");
  assert.equal(coins(1500000000000000000n, 18), "1.5");
  assert.equal(coins(123456789n, 8n), "1.23456789");
});

test("moved sums a coin's transfers one way", () => {
  assert.equal(moved(COLLECT, COIN0, "in"), 5n);
  assert.equal(moved(COLLECT, COIN0.toLowerCase(), "out"), 0n);
  assert.equal(moved(COLLECT, COIN1, "in"), 0n);
});

test("takenOut splits a drain and counts a whole collect as fees", () => {
  assert.deepEqual(takenOut(DRAIN, ["7"]), {
    principal0: 100n,
    principal1: 0n,
    fees0: 3n,
    fees1: 9n,
  });
  assert.deepEqual(takenOut(COLLECT, ["7"]), {
    principal0: 0n,
    principal1: 0n,
    fees0: 5n,
    fees1: 6n,
  });
  assert.deepEqual(takenOut(DRAIN, ["8"]), {
    principal0: 0n,
    principal1: 0n,
    fees0: 0n,
    fees1: 0n,
  });
});

test("otherCoins lists the wallet's transfers of coins outside the pool", () => {
  const record = recordOf([
    eventLog(COIN0, "Transfer", [WALLET, POOL, 1n]),
    eventLog(ELSEWHERE, "Transfer", [WALLET, POOL, 2000000n]),
    eventLog(ELSEWHERE, "Transfer", [POOL, WALLET, 3000000n]),
  ]);
  const info = new Map([
    [ELSEWHERE.toLowerCase(), { symbol: "CCC", decimals: 6 }],
  ]);
  const prices = new Map([[ELSEWHERE.toLowerCase(), 4]]);
  assert.equal(
    otherCoins(record, POOL_COINS, info, prices),
    `out 2.0 CCC of ${ELSEWHERE} ($8.00); in 3.0 CCC of ${ELSEWHERE} ($12.00)`,
  );
  assert.equal(otherCoins(DRAIN, POOL_COINS, info, prices), "");
});

test("rowOf writes PLS sent as the value, and coins from outside the pool", () => {
  const record = recordOf([
    eventLog(ELSEWHERE, "Transfer", [WALLET, POOL, 2n]),
    eventLog(PM, "IncreaseLiquidity", [7n, 1n, 0n, 0n]),
  ]);
  const info = new Map([
    [COIN0.toLowerCase(), { symbol: "AAA", decimals: 18 }],
    [COIN1.toLowerCase(), { symbol: "BBB", decimals: 6n }],
    [ELSEWHERE.toLowerCase(), { symbol: "CCC", decimals: 0 }],
  ]);
  const cells = rowOf({
    tx: {
      blockNumber: 9,
      timestamp: Date.UTC(2025, 9, 19, 12) / 1000,
      value: 2500000000000000000n,
    },
    record,
    move: { type: "deposit", nfts: ["7"] },
    pool: POOL_COINS,
    info,
    timeZone: "UTC",
    prices: new Map([[ELSEWHERE.toLowerCase(), 3]]),
    nativePrice: 0.0002,
  });
  const row = Object.fromEntries(columns("PLS").map((c, i) => [c, cells[i]]));
  assert.equal(row.date, "2025-10-19 12:00:00");
  assert.equal(row.date_utc, "2025-10-19T12:00:00Z");
  assert.equal(row.kind, "deposit");
  assert.equal(row.value_sent_PLS, "2.5");
  assert.equal(row.value_sent_usd, "0.0005");
  assert.equal(row.PLS_usd_price, "0.0002");
  assert.equal(row.other_coins, `out 2 CCC of ${ELSEWHERE} ($6.00)`);
  assert.equal(row.token0, "AAA");
  assert.deepEqual([row.token0_usd_price, row.token1_usd_price], ["", ""]);
});

test("csvCell quotes a cell holding a comma, a quote or a line break", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a, b"), '"a, b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
});

test("toCsv writes the names, then a line per row, ending in a line break", () => {
  assert.equal(
    toCsv(
      ["a", "b"],
      [
        ["1", "x, y"],
        ["2", ""],
      ],
    ),
    'a,b\n1,"x, y"\n2,\n',
  );
  assert.equal(toCsv(["a"], []), "a\n");
});

/* ---------- moves ---------- */

test("describe names each kind of move", () => {
  assert.equal(
    nameOf({ type: "rebalance", nfts: ["1", "2"] }),
    "Rebalance of NFT #1 into #2",
  );
  assert.equal(nameOf({ type: "compound", nfts: ["3"] }), "Compound of NFT #3");
  assert.equal(nameOf({ type: "deposit", nfts: ["3"] }), "Deposit into NFT #3");
});

test("belongsTo keeps a move's own transactions and leaves others'", () => {
  const move = { nfts: ["7", "8"] };
  assert.equal(belongsTo(DRAIN, move, POOL_COINS), true);
  assert.equal(belongsTo(DRAIN, { nfts: ["9"] }, POOL_COINS), false);
  const swap = recordOf(
    [
      eventLog(COIN0, "Transfer", [WALLET, POOL, 1n]),
      eventLog(COIN1, "Transfer", [POOL, WALLET, 2n]),
    ],
    { to: POOL },
  );
  assert.equal(belongsTo(swap, move, POOL_COINS), true);
  assert.equal(
    belongsTo(swap, move, { token0: COIN0, token1: ELSEWHERE }),
    false,
  );
  const cancel = recordOf([], { to: WALLET });
  assert.equal(belongsTo(cancel, move, POOL_COINS), true);
});

/* ---------- finding a move's blocks and coins ---------- */

/** A chain holding a drain of #7 at block 150, then a swap and a mint. */
function chainWithDrain() {
  const txOf = (n, blockNumber, logs) => ({
    hash: hash(n),
    blockNumber,
    from: WALLET,
    nonce: n,
    receipt: receiptOf(logs, { to: PM }),
  });
  return standInChain({
    wallet: WALLET,
    blockTime: 10,
    txs: [
      txOf(1, 150, [eventLog(PM, "DecreaseLiquidity", [7n, 1n, 1n, 1n])]),
      txOf(2, 160, [eventLog(COIN0, "Transfer", [WALLET, POOL, 1n])]),
      txOf(3, 170, [eventLog(PM, "IncreaseLiquidity", [8n, 1n, 1n, 1n])]),
    ],
  });
}

const CTX = {
  wallet: WALLET,
  positionManager: PM,
  blocksPerMonth: 1000,
  coinsOf: new Map([["7", POOL_COINS]]),
  symbols: new Map([[COIN0.toLowerCase(), "AAA"]]),
  decimals: new Map([[COIN0.toLowerCase(), 18]]),
};

test("lastOf gives the last transaction's block and time, or null", async () => {
  const chain = chainWithDrain();
  assert.deepEqual(await lastOf(chain, { lastHash: hash(3) }), {
    blockNumber: 170,
    endMs: 1700000,
  });
  assert.equal(await lastOf(chain, { lastHash: hash(99) }), null);
});

test("drainBlockOf takes the log's first transaction when it is the drain", async () => {
  const move = {
    nfts: ["7", "8"],
    listed: [hash(1), hash(3)],
    floorBlock: 100,
  };
  const chain = chainWithDrain();
  assert.equal(await drainBlockOf(chain, move, 170, CTX), 150);
  assert.equal(chain.asked.logs, 0);
});

test("drainBlockOf searches by NFT when the first listed is not the drain", async () => {
  const chain = chainWithDrain();
  const listed = {
    nfts: ["7", "8"],
    listed: [hash(2), hash(3)],
    floorBlock: 100,
  };
  assert.equal(await drainBlockOf(chain, listed, 170, CTX), 150);
  assert.equal(chain.asked.logs, 1);
  const unlisted = { nfts: ["7", "8"], listed: [], floorBlock: null };
  assert.equal(await drainBlockOf(chain, unlisted, 170, CTX), 150);
});

const CALLS = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

/**
 * A provider whose contracts answer calls from `answers`, by name, and
 * that counts them.
 * @param {object} answers
 * @returns {{call: Function, calls: string[]}}
 */
function callsProvider(answers) {
  const calls = [];
  return {
    calls,
    async call({ to, data }) {
      const name = CALLS.parseTransaction({ data }).name;
      calls.push(`${name}@${to}`);
      return CALLS.encodeFunctionResult(name, answers[name]);
    },
  };
}

test("poolOf takes a move's coins from the files before asking the chain", async () => {
  const provider = callsProvider({
    positions: [
      0,
      ethers.ZeroAddress,
      COIN1,
      ELSEWHERE,
      500,
      0,
      1,
      1,
      0,
      0,
      0,
      0,
    ],
  });
  const given = { coins: POOL_COINS, nfts: ["1"] };
  assert.deepEqual(await poolOf(provider, given, CTX), POOL_COINS);
  const cached = { coins: null, nfts: ["7"] };
  assert.deepEqual(await poolOf(provider, cached, CTX), POOL_COINS);
  assert.deepEqual(provider.calls, []);
  const unknown = { coins: null, nfts: ["9"] };
  assert.deepEqual(await poolOf(provider, unknown, CTX), {
    token0: COIN1,
    token1: ELSEWHERE,
  });
  assert.deepEqual(provider.calls, [`positions@${PM}`]);
});

test("learnCoins asks the chain only for a coin the files do not describe", async () => {
  const provider = callsProvider({ symbol: ["BBB"], decimals: [6] });
  const ctx = { ...CTX, info: new Map() };
  await learnCoins(provider, [COIN0, COIN1], ctx);
  await learnCoins(provider, [COIN0, COIN1], ctx);
  assert.deepEqual(ctx.info.get(COIN0.toLowerCase()), {
    symbol: "AAA",
    decimals: 18,
  });
  assert.deepEqual(ctx.info.get(COIN1.toLowerCase()), {
    symbol: "BBB",
    decimals: 6n,
  });
  assert.deepEqual(provider.calls, [`decimals@${COIN1}`, `symbol@${COIN1}`]);
});
