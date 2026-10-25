/**
 * @file test/position-details-compound.test.js
 * @description The two compound figures an unmanaged position shows, and
 *   the one thing that must stay true of both: neither reads the chain
 *   beyond the single NFT being looked at.
 *
 *   An unmanaged position has no Lifetime panel, so nothing here
 *   classifies compounds across the rebalance chain. The Current panel's
 *   Fees Compounded and Gas come from one scan floored at that NFT's own
 *   mint block — and where the coins are already on disk, from no scan
 *   at all.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");
const {
  _detectCurrentNftValues,
  savedNftCompoundedUsd,
  savedWalletCoinsPutIn,
} = require("../src/server/position-details-compound");

/** #100 → #200 → #300, the later two minted 5M and 6M blocks in. */
const CHAIN = [
  { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000_000 },
  { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000_000 },
];
const POSITION = { tokenId: "300", token0: "0xA", token1: "0xB", fee: 3000 };
const PS = { decimals0: 18, decimals1: 18, poolAddress: "0xPool" };
const PRICES = { price0: 1, price1: 2 };

/** A stand-in detector recording the options it was handed. */
function detector(result) {
  const calls = [];
  const fn = async (tokenId, opts) => {
    calls.push({ tokenId, opts });
    if (result instanceof Error) throw result;
    return result;
  };
  return { fn, calls };
}

const scan = (compounds, totalNftGasWei = "0") => ({
  compounds,
  totalCompoundedUsd: 0,
  totalGasWei: "0",
  totalNftGasWei,
});

/** One coin of an 18-decimal token, in its smallest unit. */
const COIN = 10n ** 18n;

/** A compound as the scan reports it: its whole deposit, in coins. */
const deposit = (txHash, coins0, coins1) => ({
  txHash,
  amount0Deposited: String(BigInt(coins0) * COIN),
  amount1Deposited: String(BigInt(coins1) * COIN),
});

describe("_detectCurrentNftValues", () => {
  it("reads only the NFT being looked at", async () => {
    const d = detector(scan([]));
    await _detectCurrentNftValues(POSITION, {}, PS, PRICES, CHAIN, [], d.fn);
    assert.equal(d.calls.length, 1, "one NFT, never the chain");
    assert.equal(d.calls[0].tokenId, "300");
  });

  it("floors the scan at that NFT's own mint block", async () => {
    /*-
     *  This runs on every unmanaged request. From the pool's creation
     *  block it would re-read years of blocks for an NFT usually days
     *  old; the chain names its mint, so the floor is free.
     */
    const d = detector(scan([]));
    await _detectCurrentNftValues(POSITION, {}, PS, PRICES, CHAIN, [], d.fn);
    assert.equal(d.calls[0].opts.fromBlock, 6_000_000);
  });

  it("values the coins the standalone compounds put back", async () => {
    // 4 of token0 at $1 and 3 of token1 at $2.
    const d = detector(scan([deposit("0x1", 3, 1), deposit("0x2", 1, 2)]));
    const r = await _detectCurrentNftValues(
      POSITION,
      {},
      PS,
      PRICES,
      CHAIN,
      [],
      d.fn,
    );
    assert.equal(r.compoundUsd, 10);
  });

  it("counts only the fees a compound the bot made put back", async () => {
    /*-
     *  The same figure the bot shows for this NFT while it manages it:
     *  the saved record of the compound the bot made names its fees, 10
     *  + 10, among the 110 + 110 its swap's deposit took from the wallet.
     *  An unmanaged view that summed the whole deposit would disagree.
     */
    const d = detector(scan([deposit("0xAB", 110, 110)]));
    const saved = [
      {
        txHash: "0xab",
        trigger: "manual",
        amount0Compounded: String(10n * COIN),
        amount1Compounded: String(10n * COIN),
      },
    ];
    const r = await _detectCurrentNftValues(
      POSITION,
      {},
      PS,
      PRICES,
      CHAIN,
      saved,
      d.fn,
    );
    assert.equal(r.compoundUsd, 30);
  });

  it("answers zero for both rather than failing the request", async () => {
    /*-
     *  The figures feed two Current-panel rows. A scan that cannot run
     *  leaves them at zero; it must not take the whole details response
     *  down with it.
     */
    const d = detector(new Error("RPC down"));
    const r = await _detectCurrentNftValues(
      POSITION,
      {},
      PS,
      PRICES,
      CHAIN,
      [],
      d.fn,
    );
    assert.deepEqual(r, { compoundUsd: 0, gasUsd: 0 });
  });

  it("reports no gas when the scan found none", async () => {
    const d = detector(scan([], "0"));
    const r = await _detectCurrentNftValues(
      POSITION,
      {},
      PS,
      PRICES,
      CHAIN,
      [],
      d.fn,
    );
    assert.equal(r.gasUsd, 0);
  });
});

describe("savedNftCompoundedUsd", () => {
  const KEY = "pulsechain-0xW-0xC-300";
  const cfg = (slot) => ({
    global: {},
    positions: slot ? { [KEY]: slot } : {},
  });

  it("prices the saved coins at the prices given", () => {
    const disk = cfg({
      nftCompoundedAmountsByTokenId: { 300: { amount0: 4, amount1: 3 } },
    });
    // 4 at $1 plus 3 at $2.
    assert.equal(savedNftCompoundedUsd(disk, KEY, "300", 1, 2), 10);
  });

  it("follows the price, since what is saved is coins", () => {
    const disk = cfg({
      nftCompoundedAmountsByTokenId: { 300: { amount0: 4, amount1: 0 } },
    });
    const a = savedNftCompoundedUsd(disk, KEY, "300", 1, 1);
    const b = savedNftCompoundedUsd(disk, KEY, "300", 2, 2);
    assert.equal(b, a * 2);
  });

  it("answers zero for a position with no slot", () => {
    assert.equal(savedNftCompoundedUsd(cfg(null), KEY, "300", 1, 1), 0);
  });

  it("answers zero for an NFT the map does not name", () => {
    const disk = cfg({
      nftCompoundedAmountsByTokenId: { 999: { amount0: 5, amount1: 5 } },
    });
    assert.equal(savedNftCompoundedUsd(disk, KEY, "300", 1, 1), 0);
  });

  it("answers zero for a slot that has never been managed", () => {
    /*-
     *  Only the bot's lifetime scan writes those coins, so an unmanaged
     *  position keeps answering zero. Removing nothing is the honest
     *  answer — the LP value stands as it is.
     */
    assert.equal(savedNftCompoundedUsd(cfg({}), KEY, "300", 1, 1), 0);
  });

  it("resolves a numeric tokenId the same as a string one", () => {
    const disk = cfg({
      nftCompoundedAmountsByTokenId: { 300: { amount0: 4, amount1: 0 } },
    });
    assert.equal(
      savedNftCompoundedUsd(disk, KEY, 300, 1, 1),
      savedNftCompoundedUsd(disk, KEY, "300", 1, 1),
    );
  });
});

describe("savedWalletCoinsPutIn", () => {
  const KEY = "pulsechain-0xW-0xC-300";
  const cfg = (slot) => ({
    global: {},
    positions: slot ? { [KEY]: slot } : {},
  });

  it("reads the wallet's coins the NFT's compounds took in from the saved list", () => {
    /*-
     *  The deposit took 110 + 5 coins, 10 + 5 of them fees: 100 of the
     *  first coin came from the wallet.
     */
    const disk = cfg({
      compoundHistory: [
        {
          tokenId: "300",
          txHash: "0xsweep",
          trigger: "manual",
          amount0Deposited: String(110n * COIN),
          amount1Deposited: String(5n * COIN),
          amount0Compounded: String(10n * COIN),
          amount1Compounded: String(5n * COIN),
        },
      ],
    });
    assert.deepEqual(savedWalletCoinsPutIn(disk, KEY, "300", PS), {
      amount0: 100,
      amount1: 0,
    });
  });

  it("answers none for a position the bot never managed", () => {
    assert.deepEqual(savedWalletCoinsPutIn(cfg(null), KEY, "300", PS), {
      amount0: 0,
      amount1: 0,
    });
  });
});
