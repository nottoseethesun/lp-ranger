/**
 * @file test/wallet-deposits.test.js
 * @description The wallet's deposits in a range of blocks, one entry per
 *   transaction (`depositsInWindow`, src/lib/wallet-deposits.js).
 *
 *   The Lifetime scan sums these for each gap between mints, and the
 *   deposit count records them one by one, at their own blocks, so a
 *   later window can leave out a transaction already recorded. Each
 *   entry therefore has to name its transaction and its block, and the
 *   rules that tell a deposit from the bot's own moves have to hold per
 *   transaction: a swap or a collect is no deposit, the position
 *   manager's and the pool's transfers are the bot's own, a transaction
 *   the wallet sent itself is no deposit, and a wrap of the native coin
 *   counts once.
 *
 *   The wallet sends every rebalance and compound the bot makes, so
 *   another managed pool's drain, fee collection or swap, bringing in a
 *   coin this pool shares, was counted as this pool's deposit until the
 *   sender was read.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { depositsInWindow } = require("../src/lib/wallet-deposits");
const {
  TRANSFER_TOPIC0,
  DEPOSIT_TOPIC0,
  mockProvider,
  mockEthers,
} = require("./helpers/lifetime-hodl-fixtures");

const E = mockEthers();
const WALLET = "0xW";
const T0 = "0xT0";
const T1 = "0xT1";
const PM = "0xPM";
const POOL = "0xPOOL";
const pad = (a) => E.zeroPadValue(a, 32);
const hex = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

/** A `Transfer` of `token` from `from` to `to`. */
function transfer(token, from, to, amount, block, tx) {
  return {
    address: token,
    topics: [TRANSFER_TOPIC0, pad(from), pad(to)],
    data: hex(amount),
    blockNumber: block,
    transactionHash: tx,
  };
}

/** A wrap of `amount` native coins into `token` for the wallet. */
function wrap(token, amount, block, tx) {
  return {
    address: token,
    topics: [DEPOSIT_TOPIC0, pad(WALLET)],
    data: hex(amount),
    blockNumber: block,
    transactionHash: tx,
  };
}

/** Transactions by hash, each sent by `from`. */
function sentBy(from, ...hashes) {
  return Object.fromEntries(hashes.map((h) => [h, { hash: h, from }]));
}

/**
 * The window 100 → 300, with the position manager and pool excluded,
 * read through a provider that serves `txs` for the senders.
 */
function read(logs, { txs = {}, ...extra } = {}) {
  return depositsInWindow({
    provider: mockProvider({ logs, txs }),
    ethersLib: E,
    token0: T0,
    token1: T1,
    wallet: WALLET,
    fromBlock: 100,
    toBlock: 300,
    excludeFromAddrs: [PM, POOL],
    ...extra,
  });
}

describe("the wallet's deposits in a window", () => {
  it("are one entry per transaction, naming it and its block, in block order", async () => {
    const got = await read(
      [
        transfer(T1, "0xFriend", WALLET, 70, 250, "0xb"),
        transfer(T0, "0xFriend", WALLET, 500, 120, "0xa"),
      ],
      { txs: sentBy("0xFriend", "0xa", "0xb") },
    );
    assert.deepEqual(got, [
      { txHash: "0xa", block: 120, raw0: 500n, raw1: 0n },
      { txHash: "0xb", block: 250, raw0: 0n, raw1: 70n },
    ]);
  });

  it("leave out what the wallet's own transactions brought in: another pool's drain, fee collection or swap", async () => {
    /*- Another managed pool holding T1 pays it into the wallet from its
     *  own pool when it drains or collects fees, and its swap buys T1 from
     *  a router. None of this pool's coins goes out, so only the sender
     *  shows these are the bot's moves, not money put in. The sender is
     *  given in another case than the wallet, as a node may return it. */
    const got = await read(
      [
        transfer(T1, "0xOtherPool", WALLET, 400, 140, "0xdrain"),
        transfer(T1, "0xOtherPool", WALLET, 30, 150, "0xcollect"),
        transfer(T1, "0xRouter", WALLET, 900, 160, "0xswap"),
      ],
      { txs: sentBy("0xw", "0xdrain", "0xcollect", "0xswap") },
    );
    assert.deepEqual(got, []);
  });

  it("count what someone else sent in the same window as the wallet's own moves", async () => {
    const got = await read(
      [
        transfer(T1, "0xOtherPool", WALLET, 400, 140, "0xdrain"),
        transfer(T1, "0xExchange", WALLET, 55, 200, "0xdeposit"),
      ],
      {
        txs: {
          ...sentBy(WALLET, "0xdrain"),
          ...sentBy("0xExchangeHotWallet", "0xdeposit"),
        },
      },
    );
    assert.deepEqual(got, [
      { txHash: "0xdeposit", block: 200, raw0: 0n, raw1: 55n },
    ]);
  });

  it("fail when a possible deposit's sender cannot be read", async () => {
    /*- Counted as none, a deposit would read as a gain; counted as one, a
     *  move of the bot's would read as money put in. */
    await assert.rejects(
      read([transfer(T0, "0xFriend", WALLET, 500, 120, "0xa")]),
      /no sender came back for transaction 0xa/,
    );
  });

  it("leave out a swap, and a collect or drain that brings both coins in", async () => {
    const got = await read([
      transfer(T0, WALLET, "0xRouter", 40, 130, "0xswap"),
      transfer(T1, "0xRouter", WALLET, 90, 130, "0xswap"),
      transfer(T0, "0xVault", WALLET, 10, 140, "0xboth"),
      transfer(T1, "0xVault", WALLET, 20, 140, "0xboth"),
    ]);
    assert.deepEqual(got, []);
  });

  it("leave out transfers from the position manager and the pool, the bot's own", async () => {
    const got = await read([
      transfer(T0, PM, WALLET, 300, 150, "0xcollect"),
      transfer(T1, POOL, WALLET, 300, 160, "0xrefund"),
    ]);
    assert.deepEqual(got, []);
  });

  it("make no entry for a transaction that brought nothing in", async () => {
    const got = await read([
      transfer(T0, WALLET, "0xFriend", 300, 170, "0xsent"),
    ]);
    assert.deepEqual(got, []);
  });

  it("count a wrap of the native coin once, at what it wrapped, though the wallet sends it", async () => {
    /*- No sender is served: a wrap is counted without asking, since the
     *  wallet always sends it and the native coins it wrapped were never
     *  counted. */
    const got = await read(
      [
        wrap(T1, 800, 180, "0xwrap"),
        transfer(T1, "0xRouter", WALLET, 800, 180, "0xwrap"),
      ],
      { wrappedNativeAddress: T1 },
    );
    assert.deepEqual(got, [
      { txHash: "0xwrap", block: 180, raw0: 0n, raw1: 800n },
    ]);
  });

  it("read nothing outside the window", async () => {
    const got = await read([
      transfer(T0, "0xFriend", WALLET, 5, 99, "0xbefore"),
      transfer(T0, "0xFriend", WALLET, 6, 301, "0xafter"),
    ]);
    assert.deepEqual(got, []);
  });
});
