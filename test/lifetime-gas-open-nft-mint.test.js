/**
 * @file test/lifetime-gas-open-nft-mint.test.js
 * @description
 * The Lifetime panel's Gas must include the mint of the NFT the position
 * holds right now.
 *
 * Every other charge sits on a period. A closed period carries its NFT's
 * whole gas, read from chain and priced at that period's close day; the
 * open period collects its own compounds and cancels as they happen. The
 * mint of the currently-open NFT sits on neither — it was spent before
 * that period began, and only reaches a period once the period closes
 * and is rebuilt from chain.
 *
 * Left out, the Lifetime line disagrees with the Current panel, which
 * shows that mint throughout; and a position that has never rebalanced
 * reports no gas at all while plainly having paid some.
 *
 * Driven through `overridePnlWithRealValues`, which is what actually
 * computes the figure, rather than through the helper it calls.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { overridePnlWithRealValues } = require("../src/bot-pnl-updater");
const { _resetForTest } = require("../src/gecko-rate-limit");

const POS = { liquidity: 1000n, tickLower: -600, tickUpper: 600 };
const POOL = { tick: 0, decimals0: 18, decimals1: 18 };

/*- 1 native coin exactly, so a dollar figure divides back to the price
 *  without rounding and the assertions read plainly. */
const ONE_COIN_WEI = "1000000000000000000";
const NATIVE_PRICE = 0.5;

let _origFetch;

/** A baseline carrying a mint charge, as the bot stores one. */
function _baseline(over = {}) {
  return {
    entryValue: 500,
    hodlAmount0: 25,
    hodlAmount1: 125,
    token0UsdPrice: 10,
    token1UsdPrice: 2,
    mintGasWei: ONE_COIN_WEI,
    ...over,
  };
}

/** A snapshot shaped as the tracker hands one over. */
function _snap(over = {}) {
  return {
    liveEpoch: { entryValue: 500 },
    closedEpochs: [{ hodlAmount0: 25, hodlAmount1: 125 }],
    initialDeposit: 500,
    totalGas: 0,
    totalGasNative: 0,
    ...over,
  };
}

describe("Lifetime Gas counts the open NFT's mint", () => {
  beforeEach(() => {
    _origFetch = globalThis.fetch;
    _resetForTest();
    /*- Every price source answers with this one native price, so
     *  whichever the cascade reaches, the arithmetic is the same. */
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        pairs: [
          {
            priceUsd: String(NATIVE_PRICE),
            chainId: "pulsechain",
            liquidity: { usd: 1_000_000 },
          },
        ],
      }),
    });
  });

  afterEach(() => {
    globalThis.fetch = _origFetch;
    _resetForTest();
  });

  it("adds the mint to a position whose periods carry no gas at all", async () => {
    /*- The never-rebalanced case: without this the Lifetime line reads
     *  zero while the operator has plainly paid to mint. */
    const snap = _snap();
    const deps = { _botState: { hodlBaseline: _baseline() } };
    await overridePnlWithRealValues(snap, deps, POS, POOL, 10, 2, 0, null);

    assert.equal(snap.totalGasNative, 1, "the mint's coins reach the total");
    assert.ok(
      Math.abs(snap.totalGas - NATIVE_PRICE) < 1e-9,
      `and are priced at today: expected ${NATIVE_PRICE}, got ${snap.totalGas}`,
    );
  });

  it("adds it on top of the gas the periods already carry", async () => {
    const snap = _snap({ totalGasNative: 4 });
    const deps = { _botState: { hodlBaseline: _baseline() } };
    await overridePnlWithRealValues(snap, deps, POS, POOL, 10, 2, 0, null);

    assert.equal(snap.totalGasNative, 5, "4 from the periods, 1 from the mint");
    assert.ok(
      Math.abs(snap.totalGas - 2.5) < 1e-9,
      `5 coins at ${NATIVE_PRICE}: expected 2.5, got ${snap.totalGas}`,
    );
  });

  it("adds nothing once the period has closed", async () => {
    /*- No open period means the rebalance closed it, and reconstruction
     *  gives that closed period its NFT's whole gas. Adding here too
     *  would count the mint twice. */
    const snap = _snap({ liveEpoch: null, totalGasNative: 4 });
    const deps = { _botState: { hodlBaseline: _baseline() } };
    await overridePnlWithRealValues(snap, deps, POS, POOL, 10, 2, 0, null);

    assert.equal(snap.totalGasNative, 4, "the periods' gas, and only that");
  });

  it("adds nothing when no mint charge was recorded", async () => {
    for (const wei of [undefined, null, "", "0", "not-a-number"]) {
      const snap = _snap({ totalGasNative: 4 });
      const deps = {
        _botState: { hodlBaseline: _baseline({ mintGasWei: wei }) },
      };
      await overridePnlWithRealValues(snap, deps, POS, POOL, 10, 2, 0, null);
      assert.equal(
        snap.totalGasNative,
        4,
        `mintGasWei=${String(wei)} must contribute nothing`,
      );
    }
  });

  it("adds nothing when there is no baseline at all", async () => {
    const snap = _snap({ totalGasNative: 4 });
    for (const state of [{}, { hodlBaseline: null }]) {
      const s = { ...snap, totalGasNative: 4 };
      await overridePnlWithRealValues(
        s,
        { _botState: state },
        POS,
        POOL,
        10,
        2,
        0,
        null,
      );
      assert.equal(s.totalGasNative, 4, "an absent baseline contributes zero");
    }
  });

  it("never produces NaN from a snapshot that has no coin total yet", async () => {
    /*- The exported function is driven directly by several suites with
     *  hand-built snapshots, and `undefined += n` is NaN. A NaN here is
     *  not one wrong reading: totalGas feeds the Lifetime line, Net P&L
     *  and Profit, and compares false against every threshold. */
    for (const mintGasWei of [ONE_COIN_WEI, "0"]) {
      const snap = _snap();
      delete snap.totalGasNative;
      const deps = { _botState: { hodlBaseline: _baseline({ mintGasWei }) } };
      await overridePnlWithRealValues(snap, deps, POS, POOL, 10, 2, 0, null);
      assert.ok(
        !Number.isNaN(snap.totalGasNative),
        `mintGasWei=${mintGasWei} left totalGasNative NaN`,
      );
      assert.ok(
        !Number.isNaN(snap.totalGas),
        `mintGasWei=${mintGasWei} left totalGas NaN`,
      );
    }
  });

  it("counts the mint once however many times a poll runs", async () => {
    /*- The charge is derived at snapshot time rather than stored, so a
     *  fresh snapshot each poll starts from the periods' gas again. This
     *  is what removes the need for any "already counted" mark. */
    const deps = { _botState: { hodlBaseline: _baseline() } };
    for (let i = 0; i < 5; i++) {
      const snap = _snap({ totalGasNative: 4 });
      await overridePnlWithRealValues(snap, deps, POS, POOL, 10, 2, 0, null);
      assert.equal(snap.totalGasNative, 5, `poll ${i + 1} must still read 5`);
    }
  });
});
