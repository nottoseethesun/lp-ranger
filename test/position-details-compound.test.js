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

const {
  _detectCurrentNftValues,
  savedNftCompoundedUsd,
} = require("../src/position-details-compound");

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

describe("_detectCurrentNftValues", () => {
  it("reads only the NFT being looked at", async () => {
    const d = detector(scan([]));
    await _detectCurrentNftValues(POSITION, {}, PS, PRICES, CHAIN, d.fn);
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
    await _detectCurrentNftValues(POSITION, {}, PS, PRICES, CHAIN, d.fn);
    assert.equal(d.calls[0].opts.fromBlock, 6_000_000);
  });

  it("sums the standalone compounds' own values", async () => {
    const d = detector(
      scan([{ usdValue: 2.5 }, { usdValue: 1.25 }, { usdValue: 0.25 }]),
    );
    const r = await _detectCurrentNftValues(
      POSITION,
      {},
      PS,
      PRICES,
      CHAIN,
      d.fn,
    );
    assert.equal(r.compoundUsd, 4);
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
