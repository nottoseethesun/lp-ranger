"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet.test.js
 * @description
 * Tests for the wallet bookkeeping report's whole run
 * (`util/bookkeeping/coins-in-transactions-on-wallet/index.js`): the rows
 * it writes and the failures that stop it. How it reads its command line
 * is in coins-in-transactions-on-wallet-options, and the Moralis key and
 * the last whole day in coins-in-transactions-on-wallet-key-and-days. The
 * run, its stand-in `app-data/` and chain, and its stand-in prices are in
 * `_wallet-report-run.js`. The csv it writes is read back row by row. A
 * run stopped by a price, by the endpoint failing, or by the endpoint
 * having no receipt for a transaction it must hold writes none. No case
 * reads the install's own `app-data/` or reaches the network.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const config = require("../../src/lib/config");
const { CHAIN_NAMES, oneChainNotice } = require("../bookkeeping/blockchain");
const { PRICE_ADVICE, usdPriceOn } = require("../bookkeeping/usd-prices");
const { RPC_ADVICE } = require("../bookkeeping/coins-in-transaction");
const {
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
  readCsv,
  wroteCsv,
} = require("./_wallet-report-run");

test("the run writes one row per transaction of each move, in order", async () => {
  const { out, err, exitCode, dir } = await run();
  assert.equal(exitCode, 0);
  assert.deepEqual(
    err,
    [oneChainNotice(CHAIN)].filter((line) => line !== null),
  );
  const file = path.join(
    dir,
    "util",
    "bookkeeping",
    `${WALLET}_2026-10-19-to-2026-10-19_UTC_coins-in-transactions.csv`,
  );
  assert.equal(
    out.at(-1),
    `Wrote 9 transactions, from 1 rebalances, 1 compounds and 1 deposits, to ${file}`,
  );
  const rows = readCsv(file);
  assert.deepEqual(
    rows.map((r) => [r.transaction, r.move, r.nfts, r.kind, r.status]),
    [
      [D, "rebalance", "10 to 11", "drain", "succeeded"],
      [A, "rebalance", "10 to 11", "approval", "succeeded"],
      [S, "rebalance", "10 to 11", "swap", "succeeded"],
      [R, "rebalance", "10 to 11", "reverted", "reverted"],
      [M, "rebalance", "10 to 11", "mint", "succeeded"],
      [C, "compound", "11", "collect", "succeeded"],
      [K, "compound", "11", "cancel", "succeeded"],
      [P, "compound", "11", "deposit", "succeeded"],
      [E, "deposit", "11", "deposit", "succeeded"],
    ],
  );
});

test("each row holds the coins in coins, the drain split, and the gas", async () => {
  const { dir } = await run();
  const [drain, approval, swap, , mint, collect] = readCsv(
    path.join(
      dir,
      "util",
      "bookkeeping",
      `${WALLET}_2026-10-19-to-2026-10-19_UTC_coins-in-transactions.csv`,
    ),
  );
  assert.equal(drain.date, "2026-10-19 12:00:00");
  assert.equal(drain.date_utc, "2026-10-19T12:00:00Z");
  assert.equal(drain.block, String(NOON));
  assert.deepEqual(
    [drain.token0, drain.token0_address, drain.token1, drain.token1_address],
    ["AAA", COIN0, "BBB", COIN1],
  );
  assert.deepEqual(
    [drain.token0_in, drain.token1_in, drain.token0_out, drain.token1_out],
    ["1.25", "3.0", "", ""],
  );
  assert.deepEqual(
    [
      drain.token0_principal,
      drain.token1_principal,
      drain.token0_fees,
      drain.token1_fees,
    ],
    ["1.0", "", "0.25", "3.0"],
  );
  assert.equal(drain[`gas_paid_${NATIVE}`], "1000.0");
  assert.equal(drain[`value_sent_${NATIVE}`], "");
  assert.equal(approval.token0_out, "");
  /*-
   *  Each amount's USD value at the stand-in's prices: AAA at $2, BBB at
   *  $0.50, and the chain's own coin at $0.0001.
   */
  assert.deepEqual(
    [drain.token0_usd_price, drain.token1_usd_price],
    ["2", "0.5"],
  );
  assert.deepEqual(
    [drain.token0_in_usd, drain.token1_in_usd, drain.token0_out_usd],
    ["2.50", "1.50", ""],
  );
  assert.deepEqual(
    [
      drain.token0_principal_usd,
      drain.token1_principal_usd,
      drain.token0_fees_usd,
      drain.token1_fees_usd,
    ],
    ["2.00", "", "0.50", "1.50"],
  );
  assert.equal(drain[`${NATIVE}_usd_price`], "0.0001");
  assert.equal(drain.gas_paid_usd, "0.10");
  assert.equal(drain.value_sent_usd, "");
  assert.deepEqual(
    [approval.token0_usd_price, approval.token1_usd_price],
    ["", ""],
  );
  assert.notEqual(approval.gas_paid_usd, "");
  assert.deepEqual([swap.token0_out, swap.token1_in], ["0.5", "2.0"]);
  assert.deepEqual([mint.token0_out, mint.token1_out], ["0.75", "5.0"]);
  assert.deepEqual(
    [collect.token0_in, collect.token0_fees, collect.token1_fees],
    ["0.01", "0.01", "0.02"],
  );
});

test("the run writes the dates in the zone it is given", async () => {
  const { dir } = await run([
    "--time-zone",
    "America/Chicago",
    "--end-date",
    "2026-10-20",
  ]);
  const file = path.join(
    dir,
    "util",
    "bookkeeping",
    `${WALLET}_2026-10-19-to-2026-10-20_America-Chicago_coins-in-transactions.csv`,
  );
  const rows = readCsv(file);
  assert.equal(rows[0].date, "2026-10-19 07:00:00");
  assert.equal(rows.at(-1).transaction, F);
});

test("the run stops when a coin has no price, writing no csv", async () => {
  const noBbb = (coin, moment) =>
    usdPriceOn(coin, moment, async (c) =>
      c.toLowerCase() === COIN1.toLowerCase() ? 0 : standInPrice(c),
    );
  const { out, err, exitCode, dir } = await run([], { prices: noBbb });
  assert.equal(exitCode, 1);
  assert.equal(wroteCsv(dir), false);
  assert.ok(!out.some((line) => line.startsWith("Wrote ")));
  const text = err.join("\n");
  assert.ok(
    text.includes(
      `a USD price for ${COIN1} at block ${NOON}, on 2026-10-19 (UTC)`,
    ),
    text,
  );
  assert.ok(text.endsWith(PRICE_ADVICE));
});

test("the run prices each coin at its transaction's block and time", async () => {
  const asked = [];
  const recording = (coin, moment) => {
    asked.push(moment);
    return priceOn(coin, moment);
  };
  const { exitCode } = await run([], { prices: recording });
  assert.equal(exitCode, 0);
  assert.ok(asked.length > 0);
  for (const { timestamp, blockNumber } of asked)
    assert.equal(timestamp, blockNumber * BLOCK_TIME, String(blockNumber));
});

test("the run stops when the endpoint fails, naming it, writing no csv", async () => {
  const { err, exitCode, dir } = await run([], { failingEndpoint: true });
  assert.equal(exitCode, 1);
  assert.equal(wroteCsv(dir), false);
  const text = err.join("\n");
  assert.match(text, /failed: connect ECONNREFUSED/);
  assert.ok(text.includes(`${config.RPC_URLS[0]} failed`));
  assert.ok(text.endsWith(RPC_ADVICE));
});

test("the run stops when a recorded transaction has no receipt, writing no csv", async () => {
  const { err, exitCode, dir } = await run([], { unminedRecord: true });
  assert.equal(exitCode, 1);
  assert.equal(wroteCsv(dir), false);
  const text = err.join("\n");
  assert.ok(
    text.includes(
      `${config.RPC_URLS[0]} failed: no receipt for ${G}, which LP Ranger ` +
        "recorded as mined",
    ),
    text,
  );
  assert.ok(text.endsWith(RPC_ADVICE));
});

test("the run stops when a transaction the endpoint lists has no receipt", async () => {
  const { err, exitCode, dir } = await run([], { noReceiptFor: S });
  assert.equal(exitCode, 1);
  assert.equal(wroteCsv(dir), false);
  const text = err.join("\n");
  assert.ok(
    text.includes(
      `${config.RPC_URLS[0]} failed: no receipt for ${S}, which the ` +
        `endpoint lists in block ${NOON + 3}`,
    ),
    text,
  );
  assert.ok(text.endsWith(RPC_ADVICE));
});

test("a --blockchain the configuration did not load is refused", async () => {
  const other = CHAIN_NAMES.find((name) => name !== CHAIN);
  assert.ok(other, "the configuration names a second chain");
  const { err, exitCode, chain, dir } = await run(["--blockchain", other]);
  assert.equal(exitCode, 1);
  assert.match(err[0], /came after the configuration loaded/);
  assert.equal(chain.asked.receipts, 0);
  assert.equal(wroteCsv(dir), false);
});
