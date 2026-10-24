/**
 * @file test/wallet-coin-share.test.js
 * @description The part of the wallet's balance of a coin that a running
 * managed position's Wallet Residual (Pool) line counts as its own
 * (src/lib/wallet-coin-share.js), and the poll that asks for it
 * (`walletResiduals`, src/lib/bot-pnl-updater.js), with the other running
 * positions as src/lib/server-positions.js shows each position.
 *
 * Coin `0xc` stands for WPLS: the asking position's pool contains it as
 * its token0 and the other position's pool as its token1, as #167040's
 * PulseX/WPLS pool and #164743's WPLS/Gold Pieces pool both contain WPLS.
 * The wallet holds 30 of it.
 */

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  NO_OTHER_NFTS,
  coinInOtherNfts,
  coinShare,
  poolCoinShares,
} = require("../src/lib/wallet-coin-share");
const {
  positionValueUsd,
  walletResiduals,
} = require("../src/lib/bot-pnl-updater");
const {
  attachMultiPosDeps,
  getAllPositionBotStates,
} = require("../src/lib/server-positions");
const rangeMath = require("../src/lib/range-math");

const near = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: ${actual} is not ${expected}`,
  );

describe("coinShare", () => {
  it("is the amount of the coin in the position's NFT, out of the amount in every running position's NFT", () => {
    near(
      coinShare(100, 0, { amount: 50, value: 0, positions: 1 }),
      100 / 150,
      "100 of 150",
    );
  });

  it("is all of a coin no other running position's pool contains, whatever the position's NFT contains", () => {
    assert.equal(coinShare(100, 500, NO_OTHER_NFTS), 1);
    assert.equal(coinShare(0, 500, NO_OTHER_NFTS), 1);
    assert.equal(coinShare(0, 0, NO_OTHER_NFTS), 1);
  });

  it("divides by each position's value when no NFT contains any of the coin", () => {
    near(
      coinShare(0, 600, { amount: 0, value: 400, positions: 1 }),
      0.6,
      "$600 of $1,000",
    );
    assert.equal(coinShare(0, 0, { amount: 0, value: 400, positions: 1 }), 0);
  });

  it("divides evenly when no NFT contains any of the coin and no position has any value", () => {
    near(
      coinShare(0, 0, { amount: 0, value: 0, positions: 2 }),
      1 / 3,
      "one of three",
    );
  });

  it("is never less than none of the coin, nor more than all of it", () => {
    for (const own of [0, 1, 100])
      for (const amount of [0, 1, 50])
        for (const value of [0, 400]) {
          const share = coinShare(own, 300, { amount, value, positions: 1 });
          assert.ok(
            share >= 0 && share <= 1,
            `own ${own}, others ${amount} and $${value}: ${share}`,
          );
        }
  });
});

describe("coinInOtherNfts", () => {
  /** A running position whose last check saved its NFT's coins. */
  const checked = (token0, token1, b0, b1, value, over = {}) => ({
    running: true,
    activePosition: { token0, token1 },
    positionStats: { balance0: String(b0), balance1: String(b1) },
    pnlSnapshot: { currentValue: value },
    ...over,
  });

  it("adds up the other running positions whose pool contains the coin, as each saved its NFT's coins at the end of its last check", () => {
    const self = checked("0xC", "0xX", 100, 0, 600);
    const states = [
      self,
      checked("0xY", "0xc", 7, 50, 400),
      checked("0xc", "0xZ", 25, 3, 100),
      checked("0xY", "0xZ", 9, 9, 999),
      checked("0xc", "0xZ", 99, 0, 999, { running: false }),
      { running: true, activePosition: { token0: "0xc", token1: "0xZ" } },
    ];
    assert.deepEqual(coinInOtherNfts(states, self, "0xc"), {
      amount: 75,
      value: 500,
      positions: 2,
    });
  });

  it("finds none for a coin no other running position's pool contains", () => {
    const self = checked("0xc", "0xX", 100, 0, 600);
    assert.deepEqual(coinInOtherNfts([self], self, "0xC"), {
      amount: 0,
      value: 0,
      positions: 0,
    });
  });
});

describe("poolCoinShares", () => {
  it("asks for each of the pool's two coins, and gives a position with no others all of both", () => {
    const asked = [];
    const others = (coin) => {
      asked.push(coin);
      return coin === "0xc"
        ? { amount: 50, value: 400, positions: 1 }
        : NO_OTHER_NFTS;
    };
    const position = { token0: "0xc", token1: "0xx" };
    const own = { amount0: 100, amount1: 0 };
    const [share0, share1] = poolCoinShares(others, position, own, 600);
    near(share0, 100 / 150, "token0");
    assert.equal(share1, 1);
    assert.deepEqual(asked, ["0xc", "0xx"]);
    assert.deepEqual(poolCoinShares(null, position, own, 600), [1, 1]);
  });
});

describe("walletResiduals, with the other positions as src/lib/server-positions.js shows them", () => {
  /** A wallet holding 30 of the coin and 10 of the other, read through a stub of ethers. */
  const ethersStub = {
    Contract: function (address) {
      return { balanceOf: async () => ({ "0xc": 30n, "0xx": 10n })[address] };
    },
  };
  const position = {
    tokenId: "1",
    token0: "0xc",
    token1: "0xx",
    liquidity: 1000n,
    tickLower: -600,
    tickUpper: 600,
  };
  /*- Tick 0 is inside the range, where the NFT contains some of each
   *  coin; tick 700 is above it, where it contains only token1. */
  const IN_RANGE = { tick: 0, decimals0: 0, decimals1: 0 };
  const ABOVE_RANGE = { tick: 700, decimals0: 0, decimals1: 0 };
  const coinNow = rangeMath.positionAmounts(1000n, 0, -600, 600, 0, 0).amount0;
  const lock = { acquire: async () => () => {} };
  const positionMgr = {
    getRebalanceLock: () => lock,
    getScanLock: () => lock,
    poolKey: () => "pool",
    canRebalancePool: () => true,
    recordPoolRebalance: () => {},
  };
  const keys = [];
  afterEach(() => {
    for (const k of keys.splice(0)) getAllPositionBotStates().delete(k);
  });

  /** Put `state` in the server's map of position states, as a start does. */
  function register(key, state) {
    getAllPositionBotStates().set(key, state);
    keys.push(key);
    return state;
  }

  /** The asking position, running, with the server's view of the others. */
  function asking(over = {}) {
    const self = register("wallet-coin-share-self", {
      running: true,
      activePosition: { token0: "0xC", token1: "0xX", tokenId: "1" },
      ...over,
    });
    attachMultiPosDeps(self, positionMgr);
    return self;
  }

  /** The other position, whose last check saved `coin` of the coin in its NFT. */
  function other(coin) {
    return register("wallet-coin-share-other", {
      running: true,
      activePosition: { token0: "0xY", token1: "0xc", tokenId: "2" },
      positionStats: { balance0: "0", balance1: String(coin) },
      pnlSnapshot: { currentValue: 400 },
    });
  }

  /** The asking position's poll, as the bot loop hands it the others. */
  function poll(self, pool) {
    const deps = {
      signer: { getAddress: async () => "0xw" },
      _coinInOtherNfts: self._coinInOtherNfts,
    };
    return walletResiduals(deps, ethersStub, null, position, pool, 1, 1);
  }

  it("counts the coins in the position's NFT at its first check, before it has saved any", async () => {
    const self = asking();
    other(50);
    const r = await poll(self, IN_RANGE);
    near(r.fraction0, coinNow / (coinNow + 50), "its part of the coin");
    near(r.amount0, (30 * coinNow) / (coinNow + 50), "its part of the 30");
  });

  it("counts the coins in the position's NFT at this check, not as its last check saved them", async () => {
    // Its last check found the price outside its range, its NFT containing none of the coin.
    const self = asking({ positionStats: { balance0: "0", balance1: "500" } });
    other(50);
    const r = await poll(self, IN_RANGE);
    near(r.fraction0, coinNow / (coinNow + 50), "back inside its range");
  });

  it("keeps all of a coin only its pool contains, on the check where its NFT stops containing any", async () => {
    // Its last check saved 5,000 of the coin; the price has since left its range.
    const self = asking({ positionStats: { balance0: "5000", balance1: "0" } });
    const r = await poll(self, ABOVE_RANGE);
    assert.equal(r.fraction0, 1);
    assert.equal(r.amount0, 30);
  });

  it("divides the coin by each position's value when neither NFT contains any of it", async () => {
    const self = asking({ positionStats: { balance0: "0", balance1: "500" } });
    other(0);
    const value = positionValueUsd(position, ABOVE_RANGE, 1, 1);
    const r = await poll(self, ABOVE_RANGE);
    near(r.fraction0, value / (value + 400), "its value out of both");
    near(r.amount0, (30 * value) / (value + 400), "its part of the 30");
  });
});
