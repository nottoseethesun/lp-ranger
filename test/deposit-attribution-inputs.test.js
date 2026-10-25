/**
 * @file test/deposit-attribution-inputs.test.js
 * @description The running positions' deposits and moves as the replay
 * reads them from their bot states, and what the replay changes in one
 * position's Lifetime figures (src/lib/deposit-attribution-inputs.js).
 *
 * The positions here share coin `0xc`: it is token0 of the asking
 * position's pool and token1 of the other's. Each lists the same deposit
 * of 1,000 of its smallest units, worth $500 at its own block, and the
 * coin has two decimals, so 1,000 units are 10 coins.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  depositAttribution,
  depositTakenAt,
  holdersOf,
  lifetimeDepositFigure,
  walletStates,
} = require("../src/lib/deposit-attribution-inputs");
const {
  attachMultiPosDeps,
  getAllPositionBotStates,
} = require("../src/lib/server-positions");

const DECIMALS = { decimals0: 2, decimals1: 2 };

/** The deposit both positions list, as a deposit entry of `index`. */
function entry(index, extra = {}) {
  const raw = index === 0 ? ["1000", "0"] : ["0", "1000"];
  return {
    raw0: raw[0],
    raw1: raw[1],
    block: 100,
    kind: "fresh",
    txHash: "0xDEP",
    usd: 500,
    ...extra,
  };
}

/** The asking position: coin 0xc as its token0. */
function selfState(over = {}) {
  return {
    running: true,
    walletAddress: "0xW",
    activePosition: { token0: "0xC", token1: "0xX", tokenId: "1" },
    lifetimeHodlAmounts: {
      deposits: [{ raw0: "5000", raw1: "0", block: 10 }, entry(0)],
      lastBlock: 50,
    },
    rebalanceEvents: [],
    compoundHistory: [],
    ...over,
  };
}

/** The other position: coin 0xc as its token1. */
function otherState(over = {}) {
  return {
    running: true,
    walletAddress: "0xw",
    activePosition: { token0: "0xY", token1: "0xc", tokenId: "2" },
    lifetimeHodlAmounts: { deposits: [entry(1)], lastBlock: 50 },
    rebalanceEvents: [],
    compoundHistory: [],
    ...over,
  };
}

/** The poll's deps for the asking position, seeing both. */
function depsFor(self, other) {
  return { _botState: self, _walletDepositStates: () => [self, other] };
}

const near = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: ${actual} is not ${expected}`,
  );

describe("walletStates", () => {
  it("gives the asking position first, then the running ones of its wallet", () => {
    const self = selfState();
    const other = otherState();
    const stopped = otherState({ running: false });
    const elsewhere = otherState({ walletAddress: "0xelse" });
    const map = new Map([
      ["a", other],
      ["b", self],
      ["c", stopped],
      ["d", elsewhere],
    ]);
    assert.deepEqual(walletStates(map, self), [self, other]);
  });

  it("is what src/lib/server-positions.js hands each position's state", () => {
    const states = getAllPositionBotStates();
    const mine = selfState();
    const sibling = otherState();
    const stopped = otherState({ running: false });
    const keys = ["dep-a", "dep-b", "dep-c"];
    [mine, sibling, stopped].forEach((s, i) => states.set(keys[i], s));
    const lock = { acquire: async () => () => {} };
    try {
      attachMultiPosDeps(mine, {
        getRebalanceLock: () => lock,
        getScanLock: () => lock,
        poolKey: () => "pool",
        canRebalancePool: () => true,
        recordPoolRebalance: () => {},
      });
      assert.deepEqual(mine._walletDepositStates(), [mine, sibling]);
    } finally {
      for (const k of keys) states.delete(k);
    }
  });
});

describe("holdersOf", () => {
  it("reads each state's deposits once, its rebalances' mints and its compounds that took the wallet's coins", () => {
    const self = selfState({
      _depositOverlay: { entries: [entry(0, { txHash: "0xdep" })] },
      rebalanceEvents: [{ blockNumber: 200 }, { blockNumber: "300" }],
      compoundHistory: [
        {
          blockNumber: 150,
          amount0Deposited: "900",
          amount1Deposited: "50",
          amount0Compounded: "600",
          amount1Compounded: "50",
          amount0WalletBefore: "1200",
          amount1WalletBefore: "0",
        },
        // No block recorded, or no fees told apart: no take here.
        {
          amount0Deposited: "9",
          amount0Compounded: "1",
          amount1Compounded: "0",
        },
        { blockNumber: 160, amount0Deposited: "9", amount1Deposited: "9" },
      ],
    });
    const { holders, selfId } = holdersOf([self], self);
    const me = holders.find((h) => h.id === selfId);
    assert.deepEqual(me.coins, ["0xc", "0xx"]);
    assert.deepEqual(me.deposits, [
      { key: "0xdep", block: 100, raw: [1000, 0], usd: [500, 0] },
    ]);
    assert.deepEqual(me.mints, [200]);
    assert.deepEqual(me.compounds, [
      { block: 150, take: [300, 0], walletBefore: [1200, 0] },
    ]);
  });

  it("puts a deposit's dollars on the one coin it brought, and none while it is unpriced", () => {
    /*- A transaction bringing both coins is a drain or a collect, never
     *  a deposit (`_isDeposit`, src/lib/wallet-deposits.js). */
    const self = selfState({
      lifetimeHodlAmounts: {
        deposits: [entry(1, { txHash: "0xone" }), entry(0, { usd: undefined })],
        lastBlock: 50,
      },
    });
    const { holders } = holdersOf([self], self);
    assert.deepEqual(
      holders[0].deposits.map((d) => [d.key, d.usd]),
      [
        ["0xone", [0, 500]],
        ["0xdep", [null, 0]],
      ],
    );
  });

  it("takes the caller's newer list of rebalances for the asking position", () => {
    const self = selfState({ rebalanceEvents: [] });
    const { holders } = holdersOf([self], self, [{ blockNumber: 400 }]);
    assert.deepEqual(holders[0].mints, [400]);
  });
});

describe("depositAttribution", () => {
  it("changes nothing without the running positions in view", () => {
    assert.deepEqual(
      depositAttribution({ _botState: selfState() }, {}, DECIMALS),
      { amount0: 0, amount1: 0, usd: 0 },
    );
  });

  it("counts a waiting deposit at the credit's share instead of in full", () => {
    const self = selfState();
    const got = depositAttribution(
      depsFor(self, otherState()),
      { fraction0: 0.6, fraction1: 1 },
      DECIMALS,
    );
    near(got.amount0, -4, "10 coins listed, 6 counted");
    near(got.amount1, 0, "its other coin");
    near(got.usd, -200, "$500 listed, $300 counted");
  });

  it("counts none of it once the other position's rebalance takes it", () => {
    const self = selfState();
    const other = otherState({ rebalanceEvents: [{ blockNumber: 200 }] });
    const got = depositAttribution(
      depsFor(self, other),
      { fraction0: 0.6, fraction1: 1 },
      DECIMALS,
    );
    near(got.amount0, -10, "none of the 10 coins");
    near(got.usd, -500, "none of the $500");
  });

  it("changes nothing once its own rebalance takes it", () => {
    const self = selfState({ rebalanceEvents: [{ blockNumber: 200 }] });
    const got = depositAttribution(
      depsFor(self, otherState()),
      { fraction0: 0.6, fraction1: 1 },
      DECIMALS,
    );
    near(got.amount0, 0, "it lists all and took all");
    near(got.usd, 0, "the dollars too");
  });

  it("takes none of a waiting deposit for an addition another wallet paid for, which the compound list holds too", () => {
    /*- The compound list holds every addition to the NFT after its mint,
     *  so the other wallet's is there as a compound with no collect before
     *  it: a rebuild names no fees for it, and all of it reads as coins
     *  taken in beyond fees. The deposit list's addition names its
     *  transaction, so the replay takes none of the wallet's coins for it,
     *  and the deposit still waits, counted at the credit's share. */
    const self = selfState({
      lifetimeHodlAmounts: {
        deposits: [
          { raw0: "5000", raw1: "0", block: 10 },
          entry(0),
          {
            raw0: "400",
            raw1: "0",
            block: 170,
            kind: "external",
            txHash: "0xadd",
            tokenId: "1",
          },
        ],
        lastBlock: 50,
      },
      compoundHistory: [
        {
          blockNumber: 170,
          txHash: "0xADD",
          tokenId: "1",
          amount0Deposited: "400",
          amount1Deposited: "0",
          amount0Compounded: "0",
          amount1Compounded: "0",
        },
      ],
    });
    const got = depositAttribution(
      depsFor(self, otherState()),
      { fraction0: 0.6, fraction1: 1 },
      DECIMALS,
    );
    near(got.amount0, -4, "10 coins listed, 6 counted, none taken");
    near(got.usd, -200, "$500 listed, $300 counted");
  });

  it("counts none of what waits when the credit could not be read", () => {
    const got = depositAttribution(
      depsFor(selfState(), otherState()),
      {},
      DECIMALS,
    );
    near(got.amount0, -10, "credited nothing, so counts nothing");
  });

  it("counts what polls found after the newest mint the list covers, as the figures did", () => {
    const self = selfState({
      lifetimeHodlAmounts: { deposits: [], lastBlock: 50 },
      _depositOverlay: { entries: [entry(0)] },
    });
    const got = depositAttribution(
      depsFor(self, otherState()),
      { fraction0: 0.5, fraction1: 1 },
      DECIMALS,
    );
    near(got.amount0, -5, "the poll's 10 coins, half counted");
  });
});

describe("lifetimeDepositFigure", () => {
  it("is the saved total, with what polls found since and the replay's change", () => {
    const self = selfState({
      totalLifetimeDepositUsd: 1000,
      depositUsedFallback: true,
      _depositOverlay: {
        entries: [entry(0, { txHash: "0xpoll", block: 60, usd: 50 })],
      },
    });
    assert.deepEqual(
      lifetimeDepositFigure({ _botState: self }, DECIMALS, { usd: -200 }),
      { total: 850, usedFallback: true },
    );
  });

  it("is null while no total is saved", () => {
    assert.equal(
      lifetimeDepositFigure({ _botState: selfState() }, DECIMALS, { usd: 0 }),
      null,
    );
  });
});

describe("depositTakenAt", () => {
  it("is what one of the position's rebalances took, in whole coins", () => {
    const self = selfState({ _walletDepositStates: null });
    const other = otherState();
    self._walletDepositStates = () => [self, other];
    assert.deepEqual(
      depositTakenAt(self, [{ blockNumber: 200 }], 200, DECIMALS),
      {
        amount0: 10,
        amount1: 0,
      },
    );
    assert.deepEqual(
      depositTakenAt(self, [{ blockNumber: 200 }], 300, DECIMALS),
      {
        amount0: 0,
        amount1: 0,
      },
    );
  });

  it("is null without the running positions in view", () => {
    assert.equal(depositTakenAt(selfState(), [], 200, DECIMALS), null);
  });
});
