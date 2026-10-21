"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet-moves.test.js
 * @description
 * Tests for how the wallet bookkeeping report reads the rebalances and
 * compounds `app-data/` records
 * (`util/bookkeeping/coins-in-transactions-on-wallet/moves.js`). Each case
 * builds a stand-in `app-data/` in a temp folder, with files shaped as LP
 * Ranger writes them: an event cache, the rebalance log with an entry the
 * test suite would write, the position records, and the LP position cache.
 * No case reads the install's own `app-data/`.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { makeTestTempFolder } = require("../../src/test-temp-folders");
const config = require("../../src/config");
const {
  RECORD_MARGIN_MS,
  readJson,
  rebalanceKey,
  cachedRebalances,
  loggedRebalances,
  joinRebalances,
  recordedCompounds,
  positionCoins,
  loggedDecimals,
  recordsNear,
} = require("../bookkeeping/coins-in-transactions-on-wallet/moves");

const CHAIN = config.CHAIN_NAME;
const CACHE_TAG = config.CHAIN.cacheTag;
const PM = config.POSITION_MANAGER;
const WALLET = "0x1111111111111111111111111111111111111111";
const LOOKALIKE = "0x1111110000000000000000000000000000000000";
const COIN0 = "0x3333333333333333333333333333333333333333";
const COIN1 = "0x4444444444444444444444444444444444444444";
const hash = (n) => "0x" + String(n).padStart(64, "0");
const T = Date.UTC(2026, 9, 19, 12);
const WHO = {
  chain: CHAIN,
  cacheTag: CACHE_TAG,
  wallet: WALLET,
  positionManager: PM,
};

/**
 * The event-cache key LP Ranger writes for a wallet's pool.
 * @param {string} wallet
 * @returns {string}
 */
function poolKey(wallet) {
  const pool = `${COIN0}-${COIN1}-2500`.toLowerCase();
  return `rebalance:${wallet.toLowerCase()}:${PM.toLowerCase()}:${pool}`;
}

/**
 * Write a file under a stand-in `app-data/`, as json.
 * @param {string} dir   The stand-in folder.
 * @param {string} name  The file's path inside it.
 * @param {*} data
 */
function put(dir, name, data) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

/**
 * A stand-in `app-data/` holding two rebalances in one pool's chain, a
 * logged rebalance the event cache lacks, an entry the test suite would
 * write, and three positions' compounds.
 * @returns {string}  The folder.
 */
function appData() {
  const dir = makeTestTempFolder("bookkeeping-moves");
  const prefix = `scan-cache/event-cache-${CACHE_TAG}-${PM.slice(2, 8).toLowerCase()}-111111`;
  put(dir, `${prefix}-33333333-44444444-2500.json`, {
    [poolKey(WALLET)]: {
      value: {
        chainFirstTokenId: "10",
        chainFirstMintBlock: 500,
        events: [
          {
            oldTokenId: "10",
            newTokenId: "11",
            txHash: hash(1),
            blockNumber: 1000,
            timestamp: T / 1000,
          },
          {
            oldTokenId: "11",
            newTokenId: "12",
            txHash: hash(2),
            blockNumber: 2000,
            timestamp: T / 1000 + 60,
          },
        ],
      },
      expiresAt: 0,
    },
    [poolKey(LOOKALIKE)]: {
      value: {
        events: [
          {
            oldTokenId: "1",
            newTokenId: "2",
            txHash: hash(9),
            blockNumber: 9,
            timestamp: 9,
          },
        ],
      },
    },
  });
  const logged = (old, made, hashes, wallet = WALLET) => ({
    wallet,
    contract: PM,
    oldTokenId: old,
    newTokenId: made,
    txHashes: hashes,
    loggedAt: new Date(T + 120000).toISOString(),
    token0: COIN0.toLowerCase(),
    token1: COIN1.toLowerCase(),
    decimals0: 18,
    decimals1: 8,
  });
  put(dir, "rebalance_log.json", [
    logged("11", "12", [hash(20), hash(21), hash(2)]),
    logged("20", "21", [hash(3)]),
    logged(
      "1",
      "99",
      ["0xmulticall", "0xmint"],
      "0xSIGNER0000000000000000000000000000000001",
    ),
  ]);
  const compound = (txHash, tokenId, timestamp) => ({
    txHash,
    tokenId,
    timestamp,
  });
  put(dir, "position-records.json", {
    positions: {
      [`${CHAIN}-${WALLET}-${PM}-12`]: {
        compoundHistory: [
          compound(hash(4), "12", new Date(T).toISOString()),
          compound(null, "12", new Date(T).toISOString()),
          compound(hash(5), "11", null),
        ],
      },
      [`${CHAIN}-${LOOKALIKE}-${PM}-5`]: {
        compoundHistory: [compound(hash(6), "5", new Date(T).toISOString())],
      },
      [`pulsechain-testnet-${WALLET}-${PM}-7`]: {
        compoundHistory: [compound(hash(7), "7", new Date(T).toISOString())],
      },
    },
  });
  put(
    dir,
    `scan-cache/lp-position-cache-${CACHE_TAG}-${PM.slice(2, 8).toLowerCase()}-111111.json`,
    {
      positions: [
        {
          tokenId: "12",
          token0: COIN0.toLowerCase(),
          token1: COIN1,
          token0Symbol: "AAA",
          token1Symbol: "BBB",
        },
      ],
      lastBlock: 3000,
    },
  );
  return dir;
}

test("readJson gives null for a missing file and refuses a broken one", () => {
  const dir = makeTestTempFolder("bookkeeping-moves");
  assert.equal(readJson(path.join(dir, "none.json")), null);
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  assert.throws(() => readJson(path.join(dir, "broken.json")), SyntaxError);
});

test("rebalanceKey reads an event-cache key and refuses any other", () => {
  const pool = rebalanceKey(poolKey(WALLET));
  assert.equal(pool.wallet, WALLET.toLowerCase());
  assert.equal(pool.positionManager, PM.toLowerCase());
  assert.equal(pool.token0, COIN0);
  assert.equal(pool.token1, COIN1);
  assert.equal(rebalanceKey("lifetime:1:2:3"), null);
  assert.equal(rebalanceKey("rebalance:1:2:nope-nope-1"), null);
});

test("cachedRebalances reads each mint with the NFT it replaced", () => {
  const moves = cachedRebalances(appData(), WHO);
  assert.deepEqual(
    moves.map((m) => [m.nfts, m.lastHash, m.floorBlock, m.endMs]),
    [
      [["10", "11"], hash(1), 500, T],
      [["11", "12"], hash(2), 1000, T + 60000],
    ],
  );
  assert.deepEqual(moves[0].coins, { token0: COIN0, token1: COIN1 });
  assert.equal(moves[0].type, "rebalance");
});

test("cachedRebalances finds nothing without a scan cache", () => {
  const dir = makeTestTempFolder("bookkeeping-moves");
  assert.deepEqual(cachedRebalances(dir, WHO), []);
});

test("loggedRebalances keeps the wallet's entries and skips the test suite's", () => {
  const logged = loggedRebalances(appData(), WHO);
  assert.deepEqual(
    logged.map((e) => e.newTokenId),
    ["12", "21"],
  );
});

test("joinRebalances adds the log's transactions and its rebalances the cache lacks", () => {
  const dir = appData();
  const moves = joinRebalances(
    cachedRebalances(dir, WHO),
    loggedRebalances(dir, WHO),
  );
  const byNew = new Map(moves.map((m) => [m.nfts[1], m]));
  assert.deepEqual(byNew.get("11").listed, []);
  assert.deepEqual(byNew.get("12").listed, [hash(20), hash(21), hash(2)]);
  assert.equal(byNew.get("12").endMs, T + 60000);
  const onlyLogged = byNew.get("21");
  assert.equal(onlyLogged.lastHash, hash(3));
  assert.equal(onlyLogged.floorBlock, null);
  assert.equal(onlyLogged.endMs, T + 120000);
  assert.deepEqual(onlyLogged.coins, { token0: COIN0, token1: COIN1 });
});

test("recordedCompounds reads each deposit of the wallet's positions on the chain", () => {
  const moves = recordedCompounds(appData(), WHO);
  assert.deepEqual(
    moves.map((m) => [m.type, m.nfts, m.lastHash, m.endMs]),
    [
      ["compound", ["12"], hash(4), T],
      ["compound", ["11"], hash(5), null],
    ],
  );
});

test("positionCoins gives each NFT's coins and each coin's symbol", () => {
  const { coinsOf, symbols } = positionCoins(appData(), WHO);
  assert.deepEqual(coinsOf.get("12"), { token0: COIN0, token1: COIN1 });
  assert.equal(symbols.get(COIN0.toLowerCase()), "AAA");
  assert.equal(symbols.get(COIN1.toLowerCase()), "BBB");
  const empty = positionCoins(makeTestTempFolder("bookkeeping-moves"), WHO);
  assert.equal(empty.coinsOf.size, 0);
});

test("loggedDecimals gives each logged coin's decimals", () => {
  const decimals = loggedDecimals(loggedRebalances(appData(), WHO));
  assert.equal(decimals.get(COIN0.toLowerCase()), 18);
  assert.equal(decimals.get(COIN1.toLowerCase()), 8);
});

test("recordsNear keeps the moves near the range, and those with no time", () => {
  const dir = appData();
  const near = recordsNear(dir, WHO, { startMs: T, endMs: T + 1000 });
  assert.deepEqual(
    near.moves.map((m) => m.lastHash),
    [hash(5), hash(1), hash(4), hash(2), hash(3)],
  );
  const far = recordsNear(dir, WHO, {
    startMs: T + 2 * RECORD_MARGIN_MS,
    endMs: T + 3 * RECORD_MARGIN_MS,
  });
  assert.deepEqual(
    far.moves.map((m) => m.lastHash),
    [hash(5)],
  );
  assert.equal(near.symbols.get(COIN0.toLowerCase()), "AAA");
  assert.equal(near.decimals.get(COIN1.toLowerCase()), 8);
});
