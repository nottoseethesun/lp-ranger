"use strict";

/**
 * @file util/test/_wallet-report-run.js
 * @description
 * The stand-ins the wallet bookkeeping report's whole-run tests share
 * (`coins-in-transactions-on-wallet*.test.js`), and `run`, which runs the
 * report's `main` against them. The run reads a stand-in `app-data/` in a
 * temp folder and a stand-in chain (`_bookkeeping-chain.js`) holding one
 * day of a wallet's moves: a rebalance whose blocks also hold another
 * position's deposit and another sender's transaction, a compound with a
 * cancel in it, coins the owner added with no collect before them, and a
 * compound mined just after the range. Its prices come from a stand-in
 * for LP Ranger's price library, through the report's own price wrapper,
 * and a stand-in opens the Moralis key, so no case prompts. Each run
 * happens at a fixed moment, so the last whole day does not move with the
 * clock. Nothing here reads the install's own `app-data/` or reaches the
 * network.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const { captureConsole } = require("./_capture");
const {
  eventLog,
  nftLog,
  receiptOf,
  standInChain,
} = require("./_bookkeeping-chain");
const { makeTestTempFolder } = require("../../src/lib/test-temp-folders");
const { main } = require("../bookkeeping/coins-in-transactions-on-wallet");
const config = require("../../src/lib/config");
const { usdPriceOn } = require("../bookkeeping/usd-prices");

const CHAIN = config.CHAIN_NAME;
const { cacheTag: CACHE_TAG, nativeCurrencySymbol: NATIVE } = config.CHAIN;
const PM = config.POSITION_MANAGER;
const NATIVE_COIN = config.CHAIN.nativeWrappedToken;
const WALLET = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const COIN0 = "0x3333333333333333333333333333333333333333";
const COIN1 = "0x4444444444444444444444444444444444444444";
const ROUTER = "0x6666666666666666666666666666666666666666";
const ELSEWHERE = "0x7777777777777777777777777777777777777777";
const STRANGER = "0x9999999999999999999999999999999999999999";
const hash = (n) => "0x" + String(n).padStart(64, "0");
const units0 = (s) => ethers.parseUnits(s, 18);
const units1 = (s) => ethers.parseUnits(s, 6);

/** Ten-second blocks; block `NOON` is mined at 2026-10-19 12:00:00 UTC. */
const BLOCK_TIME = 10;
const NOON = Date.UTC(2026, 9, 19, 12) / 1000 / BLOCK_TIME;
const at = (block) => new Date(block * BLOCK_TIME * 1000).toISOString();

const [D, A, S, X, R, Y, M, C, K, P, E, F, G] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
].map(hash);

/**
 * One transaction of the stand-in chain.
 * @param {string} txHash
 * @param {number} offset  Its block, counted from `NOON`.
 * @param {number} nonce
 * @param {string} to
 * @param {object[]} logs
 * @param {object} [extra]  Other receipt fields, or `from`.
 * @returns {object}
 */
function tx(txHash, offset, nonce, to, logs, extra = {}) {
  const from = extra.from ?? WALLET;
  return {
    hash: txHash,
    blockNumber: NOON + offset,
    from,
    nonce,
    receipt: receiptOf(logs, { to, ...extra }),
  };
}

/** The day: a rebalance of #10 into #11, then moves on #11. */
const DAY = [
  tx(D, 0, 40, PM, [
    eventLog(PM, "DecreaseLiquidity", [10n, 5n, units0("1"), 0n]),
    eventLog(COIN0, "Transfer", [POOL, WALLET, units0("1.25")]),
    eventLog(COIN1, "Transfer", [POOL, WALLET, units1("3")]),
    eventLog(PM, "Collect", [10n, WALLET, units0("1.25"), units1("3")]),
  ]),
  tx(A, 1, 41, COIN0, [
    eventLog(COIN0, "Approval", [WALLET, ROUTER, ethers.MaxUint256]),
  ]),
  tx(S, 3, 42, ROUTER, [
    eventLog(COIN0, "Transfer", [WALLET, POOL, units0("0.5")]),
    eventLog(COIN1, "Transfer", [POOL, ROUTER, units1("2")]),
    eventLog(COIN1, "Transfer", [ROUTER, WALLET, units1("2")]),
  ]),
  tx(X, 4, 43, PM, [
    eventLog(ELSEWHERE, "Transfer", [WALLET, POOL, 1n]),
    eventLog(PM, "IncreaseLiquidity", [99n, 1n, 1n, 0n]),
  ]),
  tx(R, 5, 44, ROUTER, [], { status: 0 }),
  tx(Y, 5, 7, ROUTER, [], { from: STRANGER }),
  tx(M, 10, 45, PM, [
    eventLog(COIN0, "Approval", [WALLET, PM, 1n]),
    eventLog(COIN0, "Transfer", [WALLET, POOL, units0("0.75")]),
    eventLog(COIN1, "Transfer", [WALLET, POOL, units1("5")]),
    nftLog(PM, ethers.ZeroAddress, WALLET, 11n),
    eventLog(PM, "IncreaseLiquidity", [11n, 7n, units0("0.75"), units1("5")]),
  ]),
  tx(C, 115, 46, PM, [
    eventLog(COIN0, "Transfer", [POOL, WALLET, units0("0.01")]),
    eventLog(COIN1, "Transfer", [POOL, WALLET, units1("0.02")]),
    eventLog(PM, "Collect", [11n, WALLET, units0("0.01"), units1("0.02")]),
  ]),
  tx(K, 116, 47, WALLET, []),
  tx(P, 120, 48, PM, [
    eventLog(COIN0, "Transfer", [WALLET, POOL, units0("0.01")]),
    eventLog(COIN1, "Transfer", [WALLET, POOL, units1("0.02")]),
    eventLog(PM, "IncreaseLiquidity", [
      11n,
      1n,
      units0("0.01"),
      units1("0.02"),
    ]),
  ]),
  tx(E, 200, 49, PM, [
    eventLog(COIN0, "Transfer", [WALLET, POOL, units0("1")]),
    eventLog(PM, "IncreaseLiquidity", [11n, 1n, units0("1"), 0n]),
  ]),
  tx(F, 4321, 50, PM, [
    eventLog(COIN0, "Transfer", [WALLET, POOL, 1n]),
    eventLog(PM, "IncreaseLiquidity", [11n, 1n, 1n, 0n]),
  ]),
];

/**
 * Write a file under the stand-in `app-data/`, as json.
 * @param {string} dir
 * @param {string} name
 * @param {*} data
 */
function put(dir, name, data) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

/**
 * A stand-in `app-data/` recording the day's moves: the rebalance in the
 * event cache and the log, and three deposits into #11 in its records,
 * with a fourth the chain holds no receipt for when asked.
 * @param {{unminedRecord?: boolean}} [stage]
 * @returns {string}  The folder.
 */
function appData(stage = {}) {
  const dir = makeTestTempFolder("bookkeeping-wallet");
  const short = (a) => a.slice(2, 8).toLowerCase();
  const pool = `${COIN0}-${COIN1}-2500`.toLowerCase();
  const key = `rebalance:${WALLET.toLowerCase()}:${PM.toLowerCase()}:${pool}`;
  put(
    dir,
    `scan-cache/event-cache-${CACHE_TAG}-${short(PM)}-${short(WALLET)}-33333333-44444444-2500.json`,
    {
      [key]: {
        value: {
          chainFirstTokenId: "10",
          chainFirstMintBlock: NOON - 1000,
          events: [
            {
              oldTokenId: "10",
              newTokenId: "11",
              txHash: M,
              blockNumber: NOON + 10,
              timestamp: (NOON + 10) * BLOCK_TIME,
            },
          ],
        },
      },
    },
  );
  put(dir, "rebalance_log.json", [
    {
      wallet: WALLET,
      contract: PM,
      oldTokenId: "10",
      newTokenId: "11",
      txHashes: [D, S, M],
      loggedAt: at(NOON + 11),
      token0: COIN0,
      token1: COIN1,
      decimals0: 18,
      decimals1: 6,
    },
  ]);
  const deposit = (txHash, timestamp) => ({ txHash, tokenId: "11", timestamp });
  const compoundHistory = [
    deposit(P, at(NOON + 120)),
    deposit(E, at(NOON + 200)),
    deposit(F, "2026-10-19T23:59:30.000Z"),
  ];
  if (stage.unminedRecord === true)
    compoundHistory.push(deposit(G, at(NOON + 300)));
  put(dir, "position-records.json", {
    positions: { [`${CHAIN}-${WALLET}-${PM}-11`]: { compoundHistory } },
  });
  put(
    dir,
    `scan-cache/lp-position-cache-${CACHE_TAG}-${short(PM)}-${short(WALLET)}.json`,
    {
      positions: [
        {
          tokenId: "11",
          token0: COIN0,
          token1: COIN1,
          token0Symbol: "AAA",
          token1Symbol: "BBB",
        },
      ],
    },
  );
  return dir;
}

/** What the stand-in price oracle answers, by lower-cased coin address. */
const PRICES = new Map([
  [COIN0.toLowerCase(), 2],
  [COIN1.toLowerCase(), 0.5],
  [NATIVE_COIN.toLowerCase(), 0.0001],
]);

/**
 * A stand-in for LP Ranger's price library: a price from `PRICES`, and 0,
 * as the library answers when no source can price a coin, for any other.
 * @param {string} coin
 * @returns {Promise<number>}
 */
async function standInPrice(coin) {
  return PRICES.get(coin.toLowerCase()) ?? 0;
}

/**
 * The price wrapper the report uses, asking the stand-in rather than
 * Moralis and CoinGecko.
 * @param {string} coin
 * @param {{timestamp: number, blockNumber: number}} moment
 * @returns {Promise<number>}
 */
function priceOn(coin, moment) {
  return usdPriceOn(coin, moment, standInPrice);
}

/*-
 *  The moment each run happens unless a case names another: 2026-10-22
 *  12:00 UTC, when 2026-10-21 is the last whole day in UTC and
 *  2026-10-20 in America/Chicago, so the ranges the cases ask for are
 *  whole.
 */
const RUN_AT = Date.UTC(2026, 9, 22, 12);

/**
 * Run `main` for 2026-10-19 in UTC against the stand-in chain and
 * `app-data/`, keeping the exit status it sets out of the test process's.
 * @param {string[]} [extra]  More arguments.
 * @param {{prices?: Function, failingEndpoint?: boolean,
 *   unminedRecord?: boolean, noReceiptFor?: string, nowMs?: number,
 *   unlock?: Function}} [stage]  Another price oracle; an endpoint that
 *   fails every receipt it is asked for; a recorded deposit the chain has
 *   no receipt for; one transaction of the day whose receipt the endpoint
 *   does not have; another moment for the run; or another way the Moralis
 *   key opens.
 * @returns {Promise<{out: string[], err: string[], exitCode: number,
 *   dir: string, chain: object}>}
 */
async function run(extra = [], stage = {}) {
  const dir = appData(stage);
  const chain = standInChain({
    wallet: WALLET,
    blockTime: BLOCK_TIME,
    txs: DAY,
  });
  const failing = {
    ...chain,
    async getTransactionReceipt() {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "NETWORK_ERROR",
      });
    },
  };
  const missing = {
    ...chain,
    async getTransactionReceipt(txHash) {
      if (txHash === stage.noReceiptFor) return null;
      return chain.getTransactionReceipt(txHash);
    },
  };
  const argv = [
    "--wallet",
    WALLET,
    "--start-date",
    "2026-10-19",
    "--end-date",
    "2026-10-19",
    "--time-zone",
    "UTC",
    ...extra,
  ];
  let provider = chain;
  if (stage.failingEndpoint === true) provider = failing;
  if (stage.noReceiptFor !== undefined) provider = missing;
  const deps = {
    makeProvider: () => provider,
    appDataDir: dir,
    spacingMs: 0,
    usdPriceOn: stage.prices === undefined ? priceOn : stage.prices,
    nowMs: stage.nowMs === undefined ? RUN_AT : stage.nowMs,
    unlockMoralisKey:
      stage.unlock === undefined ? async () => {} : stage.unlock,
  };
  const prior = process.exitCode;
  try {
    const { out, err } = await captureConsole(() => main(argv, deps));
    return { out, err, exitCode: process.exitCode, dir, chain };
  } finally {
    process.exitCode = prior;
  }
}

/**
 * Where a run's csv is, for a range and a time zone.
 * @param {string} dir  The run's stand-in `app-data/`.
 * @param {string} start  The range's first day.
 * @param {string} end  Its last day.
 * @param {string} [zone]  The time zone as the file name writes it.
 * @returns {string}
 */
function csvOf(dir, start, end, zone = "UTC") {
  const name = `${WALLET}_${start}-to-${end}_${zone}_coins-in-transactions.csv`;
  return path.join(dir, "util", "bookkeeping", name);
}

/**
 * The csv a run wrote, as rows of cells keyed by column name.
 * @param {string} file
 * @returns {Array<Object<string, string>>}
 */
function readCsv(file) {
  const [names, ...lines] = fs.readFileSync(file, "utf8").trim().split("\n");
  const columns = names.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(columns.map((c, i) => [c, cells[i]]));
  });
}

/**
 * Whether a run left a csv behind.
 * @param {string} dir  The run's stand-in `app-data/`.
 * @returns {boolean}
 */
function wroteCsv(dir) {
  return fs.existsSync(path.join(dir, "util", "bookkeeping"));
}

module.exports = {
  CHAIN,
  NATIVE,
  WALLET,
  COIN0,
  COIN1,
  BLOCK_TIME,
  NOON,
  D,
  A,
  S,
  R,
  M,
  C,
  K,
  P,
  E,
  F,
  G,
  standInPrice,
  priceOn,
  run,
  csvOf,
  readCsv,
  wroteCsv,
};
