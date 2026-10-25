/**
 * @file test/deposit-attribution-figures.test.js
 * @description A deposit of a coin two managed positions hold, through
 * the figures the Lifetime panel shows (`overridePnlWithRealValues` and
 * `walletResiduals`, src/lib/bot-pnl-updater.js).
 *
 * The asking position holds coin `0xc` as its token0, the other as its
 * token1. Both list the same deposit of 100 coins, worth $50 at its own
 * block. The asking position's saved Total Lifetime Deposit is $550: its
 * first mint's $500 and that deposit. While the coins wait, it counts
 * the share of them the Wallet Residual (Pool) credits it; once a
 * rebalance takes them, the position whose rebalance it was counts them
 * all.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  overridePnlWithRealValues,
  walletResiduals,
} = require("../src/lib/bot-pnl-updater");
const rangeMath = require("../src/lib/range-math");
const { NO_OTHER_NFTS } = require("../src/lib/wallet-coin-share");
const { _resetForTest } = require("../src/lib/gecko-rate-limit");

let _originalFetch;
beforeEach(() => {
  _originalFetch = globalThis.fetch;
  _resetForTest();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

const POS = { tokenId: "1", liquidity: 1000n, tickLower: -600, tickUpper: 600 };
const POOL = { tick: 0, decimals0: 0, decimals1: 0 };

/** The deposit both positions list, as a deposit entry of `index`. */
function shared(index) {
  return {
    raw0: index === 0 ? "100" : "0",
    raw1: index === 0 ? "0" : "100",
    block: 100,
    kind: "fresh",
    txHash: "0xdep",
    usd: 50,
  };
}

/** The asking position's bot state. */
function self() {
  return {
    running: true,
    walletAddress: "0xw",
    activePosition: { token0: "0xc", token1: "0xx", tokenId: "1" },
    totalLifetimeDepositUsd: 550,
    lifetimeHodlAmounts: {
      amount0: 600,
      amount1: 0,
      deposits: [{ raw0: "500", raw1: "0", block: 10 }, shared(0)],
      lastBlock: 50,
    },
    rebalanceEvents: [],
    compoundHistory: [],
  };
}

/** The other position's bot state. */
function other(rebalanceEvents = []) {
  return {
    running: true,
    walletAddress: "0xw",
    activePosition: { token0: "0xy", token1: "0xc", tokenId: "2" },
    lifetimeHodlAmounts: { deposits: [shared(1)], lastBlock: 50 },
    rebalanceEvents,
    compoundHistory: [],
  };
}

/** The Lifetime figures for the asking position, credited `fraction0`. */
async function figures(withOthers, otherEvents) {
  const me = self();
  const deps = { _botState: me };
  if (withOthers) deps._walletDepositStates = () => [me, other(otherEvents)];
  const snap = { liveEpoch: { entryValue: 500 }, totalGas: 0 };
  await overridePnlWithRealValues(snap, deps, POS, POOL, 1, 1, 0, {
    usd: 60,
    usd0: 60,
    usd1: 0,
    amount0: 60,
    amount1: 0,
    fraction0: 0.6,
    fraction1: 1,
  });
  return {
    deposit: snap.totalLifetimeDeposit,
    holding: snap.ilInputs.lt.hodlAmount0,
  };
}

describe("a deposit of a coin another position holds, in the Lifetime figures", () => {
  it("counts in full, as it was, while no other position is in view", async () => {
    assert.deepEqual(await figures(false), { deposit: 550, holding: 600 });
  });

  it("counts the credit's share of it while its coins wait", async () => {
    const got = await figures(true);
    assert.ok(Math.abs(got.deposit - 530) < 1e-9, `deposit ${got.deposit}`);
    assert.ok(Math.abs(got.holding - 560) < 1e-9, `holding ${got.holding}`);
  });

  it("counts none of it once the other position's rebalance has taken it", async () => {
    const got = await figures(true, [{ blockNumber: 200 }]);
    assert.ok(Math.abs(got.deposit - 500) < 1e-9, `deposit ${got.deposit}`);
    assert.ok(Math.abs(got.holding - 500) < 1e-9, `holding ${got.holding}`);
  });
});

describe("the bot loop", () => {
  it("hands every poll the running positions of its wallet", () => {
    /*- The loop has no fixture of its own, so its one line is pinned by
     *  reading the source, as test/deposit-count-on-rise-wiring.test.js
     *  pins the deposit count's. */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "bot-loop.js"),
      "utf8",
    );
    assert.match(src, /_walletDepositStates: botState\._walletDepositStates,/);
  });
});

describe("walletResiduals: each coin's share", () => {
  /** A wallet holding `balances`, read through a stub of ethers. */
  function wallet(balances) {
    function Contract(address) {
      return { balanceOf: async () => balances[address] };
    }
    return { Contract };
  }
  const position = { ...POS, token0: "0xc", token1: "0xx" };
  const own = rangeMath.positionAmounts(1000n, 0, -600, 600, 0, 0);

  it("is the amount of each coin in the position's NFT, out of the amount in the NFTs of every running position whose pool contains it", async () => {
    const deps = {
      signer: { getAddress: async () => "0xw" },
      _coinInOtherNfts: (coin) =>
        coin === "0xc"
          ? { amount: own.amount0 / 0.6 - own.amount0, value: 0, positions: 1 }
          : NO_OTHER_NFTS,
    };
    const r = await walletResiduals(
      deps,
      wallet({ "0xc": 100n, "0xx": 10n }),
      null,
      position,
      POOL,
      1,
      1,
    );
    assert.ok(Math.abs(r.fraction0 - 0.6) < 1e-9, `fraction0 ${r.fraction0}`);
    assert.equal(r.fraction1, 1);
    assert.ok(Math.abs(r.amount0 - 60) < 1e-9, "its share of the coins");
  });

  it("is the whole balance of a coin no other running position's pool contains", async () => {
    const deps = {
      signer: { getAddress: async () => "0xw" },
      _coinInOtherNfts: () => NO_OTHER_NFTS,
    };
    const r = await walletResiduals(
      deps,
      wallet({ "0xc": 100n, "0xx": 10n }),
      null,
      position,
      POOL,
      1,
      1,
    );
    assert.equal(r.fraction0, 1);
    assert.equal(r.amount0, 100);
  });
});
