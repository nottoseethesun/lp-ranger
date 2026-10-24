/**
 * @file test/compounded-coins.test.js
 * @description What a compound counts as Fees Compounded
 *   (src/lib/compounded-coins.js): the fees its deposit put back, worked out
 *   from the wallet's readings, and never the coins the wallet already
 *   held that a ratio swap's deposit takes in.
 *
 *   The worked example the user was given: the wallet holds a deposit of
 *   100 A + 100 B when a compound collects 10 A + 10 B of fees, and the
 *   deposit takes all 110 + 110. Ten of each are fees.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  compoundFeeUnits,
  compoundedFields,
  recordedCompounds,
  compoundedUnits,
  compoundedCoins,
  walletCoinsPutIn,
  feesLeftInWallet,
} = require("../src/lib/compounded-coins");

/** A pair of amounts in the coins' smallest units. */
const pair = (raw0, raw1) => ({ raw0, raw1 });

describe("compoundFeeUnits", () => {
  it("counts a swept deposit out of the fees", () => {
    /*-
     *  The wallet held 100 + 100 before the collect, 110 + 110 just
     *  before the deposit, and the deposit took all of it: the wallet
     *  ends at 0, so 100 of each came from its earlier balance.
     */
    const fees = compoundFeeUnits(
      pair(100n, 100n),
      pair(110n, 110n),
      pair(110n, 110n),
    );
    assert.deepEqual(fees, pair(10n, 10n));
  });

  it("counts all of a deposit that offered only the fees", () => {
    /*-
     *  No swap: the deposit is offered the fees alone, and the position
     *  takes what fits. The wallet ends with more than it started with,
     *  so nothing came from its earlier balance.
     */
    const fees = compoundFeeUnits(
      pair(100n, 100n),
      pair(110n, 110n),
      pair(10n, 4n),
    );
    assert.deepEqual(fees, pair(10n, 4n));
  });

  it("counts the fees when the deposit took them and part of the rest", () => {
    // 110 before the deposit, 60 taken, 50 left: 50 of the 100 went in.
    const fees = compoundFeeUnits(
      pair(100n, 0n),
      pair(110n, 10n),
      pair(60n, 10n),
    );
    assert.deepEqual(fees, pair(10n, 10n));
  });

  it("counts each coin on its own", () => {
    /*-
     *  A swap sold 6 of the 10 A fees for 6 B. The deposit took the 4 A
     *  and 16 B the fees became, and 20 B of the wallet's own.
     */
    const fees = compoundFeeUnits(pair(0n, 20n), pair(4n, 36n), pair(4n, 36n));
    assert.deepEqual(fees, pair(4n, 16n));
  });

  it("counts no fees for a coin the wallet lost more of than went in", () => {
    // Coins left the wallet meanwhile: 100 before, 90 ready, 90 taken.
    const fees = compoundFeeUnits(pair(100n, 0n), pair(90n, 5n), pair(90n, 5n));
    assert.deepEqual(fees, pair(0n, 5n));
  });

  it("answers null when a reading is missing or not an amount", () => {
    assert.equal(compoundFeeUnits(undefined, pair(1n, 1n), pair(1n, 1n)), null);
    assert.equal(
      compoundFeeUnits(pair(1n, 1n), pair(1n, -1n), pair(1n, 1n)),
      null,
    );
    assert.equal(
      compoundFeeUnits(pair(1n, 1n), pair(1n, 1n), pair("x", 1n)),
      null,
    );
  });

  it("counts no more than the compound's own transactions moved", () => {
    /*-
     *  50 of coin 1 the owner sent landed while the compound ran: the
     *  wallet rose 10 + 60, the deposit took all of it, and the collect
     *  and the swap moved 10 + 10. The readings alone would say 10 + 60.
     */
    const fees = compoundFeeUnits(
      pair(100n, 100n),
      pair(110n, 160n),
      pair(110n, 160n),
      pair(10n, 10n),
    );
    assert.deepEqual(fees, pair(10n, 10n));
  });

  it("lets the readings decide below the cap, and without one", () => {
    // The deposit took 4 of coin 1: fewer than the 10 the cap allows.
    assert.deepEqual(
      compoundFeeUnits(
        pair(100n, 100n),
        pair(110n, 110n),
        pair(10n, 4n),
        pair(10n, 10n),
      ),
      pair(10n, 4n),
    );
    assert.deepEqual(
      compoundFeeUnits(
        pair(100n, 100n),
        pair(110n, 160n),
        pair(110n, 160n),
        null,
      ),
      pair(10n, 60n),
    );
  });
});

describe("compoundedFields", () => {
  const deposited = { amount0Deposited: 110n, amount1Deposited: 110n };

  it("names the fees in the smallest units and in whole coins", () => {
    const fields = compoundedFields(
      pair(100n, 100n),
      pair(110n, 110n),
      deposited,
      1,
      0,
    );
    assert.deepEqual(fields, {
      amount0Compounded: "10",
      amount1Compounded: "10",
      feesCompounded: { amount0: 1, amount1: 10 },
    });
  });

  it("names none when a reading is missing", () => {
    assert.deepEqual(
      compoundedFields(undefined, pair(1n, 1n), deposited, 18, 18),
      {},
    );
  });

  it("caps the fees at the compound's own transactions", () => {
    const fields = compoundedFields(
      pair(100n, 100n),
      pair(110n, 110n),
      deposited,
      1,
      0,
      pair(10n, 6n),
    );
    assert.equal(fields.amount1Compounded, "6");
    assert.equal(fields.amount0FeesLeft, "0", "the deposit took every fee");
    assert.equal(fields.amount1FeesLeft, "0");
  });

  it("names the fees the deposit could not take, left in the wallet", () => {
    /*-
     *  The user's 10-04 HEX case in small: 10 A + 10 B of fees, no swap,
     *  and a range that takes only 8 A to the 10 B.
     */
    const fields = compoundedFields(
      pair(100n, 100n),
      pair(110n, 110n),
      { amount0Deposited: 8n, amount1Deposited: 10n },
      0,
      0,
      pair(10n, 10n),
    );
    assert.equal(fields.amount0Compounded, "8");
    assert.equal(fields.amount0FeesLeft, "2");
    assert.equal(fields.amount1FeesLeft, "0");
  });

  it("counts the fees left as the swap left them, not as collected", () => {
    /*-
     *  10 A of fees, 5 A swapped for 4 B, then a deposit of 5 A + 3 B: one
     *  B stays. Taken from the coins as collected, 10 A less 5 A would say
     *  five A stayed, which the swap had sold.
     */
    const fields = compoundedFields(
      pair(100n, 100n),
      pair(105n, 104n),
      { amount0Deposited: 5n, amount1Deposited: 3n },
      0,
      0,
      pair(5n, 4n),
    );
    assert.equal(fields.amount0FeesLeft, "0");
    assert.equal(fields.amount1FeesLeft, "1");
  });

  it("names no fees left without the compound's own fee coins", () => {
    /*- The readings alone cannot tell fees from a deposit that reached
     *  the wallet while the compound ran. */
    const fields = compoundedFields(
      pair(100n, 100n),
      pair(110n, 110n),
      { amount0Deposited: 8n, amount1Deposited: 10n },
      0,
      0,
    );
    assert.equal(fields.amount0Compounded, "8");
    assert.equal("amount0FeesLeft" in fields, false);
    assert.equal("amount1FeesLeft" in fields, false);
  });
});

describe("feesLeftInWallet", () => {
  const history = [
    { tokenId: "7", amount0FeesLeft: "200", amount1FeesLeft: "0" },
    { tokenId: "7", amount0FeesLeft: "50", amount1FeesLeft: "30" },
    { tokenId: "6", amount0FeesLeft: "999", amount1FeesLeft: "999" },
    // Recorded before the fees left were kept, or without its fee coins.
    { tokenId: "7", amount0Compounded: "5", amount1Compounded: "5" },
    { tokenId: "7", amount0FeesLeft: "x", amount1FeesLeft: "1" },
    null,
  ];

  it("sums the fees each of the NFT's compounds left, in whole coins", () => {
    assert.deepEqual(feesLeftInWallet(history, 7, 2, 1), {
      amount0: 2.5,
      amount1: 3,
    });
  });

  it("answers no coins for no list", () => {
    assert.deepEqual(feesLeftInWallet(undefined, "7", 18, 18), {
      amount0: 0,
      amount1: 0,
    });
  });
});

describe("recordedCompounds", () => {
  it("keeps the compounds the bot recorded, by lower-cased transaction", () => {
    const map = recordedCompounds([
      { txHash: "0xAA", trigger: "auto" },
      { txHash: "0xBB", trigger: "manual" },
      { txHash: "0xCC", trigger: "unknown" },
      { txHash: "0xDD", trigger: "historical" },
      { trigger: "auto" },
      null,
    ]);
    assert.deepEqual([...map.keys()], ["0xaa", "0xbb"]);
  });

  it("answers an empty map for no list", () => {
    assert.equal(recordedCompounds(undefined).size, 0);
  });
});

describe("compoundedUnits", () => {
  const deposited = pair("110", "110");

  it("takes the fees a record names", () => {
    const record = { amount0Compounded: "10", amount1Compounded: "7" };
    assert.deepEqual(compoundedUnits(deposited, record), pair(10n, 7n));
  });

  it("takes the whole deposit for a record without both fees", () => {
    assert.deepEqual(
      compoundedUnits(deposited, { amount0Compounded: "10" }),
      pair(110n, 110n),
    );
    assert.deepEqual(compoundedUnits(deposited, undefined), pair(110n, 110n));
  });

  it("counts a deposit that is not an amount as nothing", () => {
    assert.deepEqual(
      compoundedUnits(pair(undefined, "x"), undefined),
      pair(0n, 0n),
    );
  });
});

describe("compoundedCoins", () => {
  it("sums a list of records by the fees each names", () => {
    const coins = compoundedCoins(
      [
        {
          txHash: "0x1",
          amount0Deposited: "110",
          amount1Deposited: "1100",
          amount0Compounded: "10",
          amount1Compounded: "100",
        },
        { txHash: "0x2", amount0Deposited: "5", amount1Deposited: "50" },
      ],
      undefined,
      1,
      2,
    );
    assert.deepEqual(coins, { amount0: 1.5, amount1: 1.5 });
  });

  it("takes a chain compound's fees from the record of its transaction", () => {
    /*-
     *  The chain shows the whole deposit; the record, matched whatever
     *  the case of its hash, names the fees. A compound the bot did not
     *  record counts its whole deposit.
     */
    const recorded = recordedCompounds([
      {
        txHash: "0xABC",
        trigger: "auto",
        amount0Compounded: "10",
        amount1Compounded: "10",
      },
    ]);
    const coins = compoundedCoins(
      [
        { txHash: "0xabc", amount0Deposited: "110", amount1Deposited: "110" },
        { txHash: "0xdef", amount0Deposited: "3", amount1Deposited: "4" },
      ],
      recorded,
      0,
      0,
    );
    assert.deepEqual(coins, { amount0: 13, amount1: 14 });
  });

  it("answers no coins for no list", () => {
    assert.deepEqual(compoundedCoins(undefined, undefined, 18, 18), {
      amount0: 0,
      amount1: 0,
    });
  });
});

describe("walletCoinsPutIn", () => {
  /*-
   *  The worked example: the deposit took 110 + 110, ten of each fees,
   *  so it put 100 + 100 of the wallet's coins into the NFT.
   */
  const record = (over = {}) => ({
    tokenId: "7",
    txHash: "0x1",
    trigger: "auto",
    amount0Deposited: "110",
    amount1Deposited: "110",
    amount0Compounded: "10",
    amount1Compounded: "10",
    ...over,
  });

  it("sums what each of the NFT's compounds took beyond its fees", () => {
    const coins = walletCoinsPutIn(
      [record(), record({ txHash: "0x2", amount1Deposited: "10" })],
      7,
      0,
      1,
    );
    assert.deepEqual(coins, { amount0: 200, amount1: 10 });
  });

  it("leaves out another NFT's compounds", () => {
    const coins = walletCoinsPutIn([record({ tokenId: "8" })], "7", 0, 0);
    assert.deepEqual(coins, { amount0: 0, amount1: 0 });
  });

  it("takes nothing from a compound that names no fees", () => {
    /*-
     *  Its whole deposit counts as Fees Compounded (`compoundedUnits`),
     *  so none of it was the wallet's other coins.
     */
    const bare = record();
    delete bare.amount0Compounded;
    delete bare.amount1Compounded;
    assert.deepEqual(walletCoinsPutIn([bare], "7", 0, 0), {
      amount0: 0,
      amount1: 0,
    });
  });

  it("never counts below zero for a coin", () => {
    const coins = walletCoinsPutIn(
      [record({ amount0Deposited: "5", amount0Compounded: "10" })],
      "7",
      0,
      0,
    );
    assert.deepEqual(coins, { amount0: 0, amount1: 100 });
  });

  it("answers no coins for no list", () => {
    assert.deepEqual(walletCoinsPutIn(undefined, "7", 18, 18), {
      amount0: 0,
      amount1: 0,
    });
  });
});
