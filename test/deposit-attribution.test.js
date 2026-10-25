/**
 * @file test/deposit-attribution.test.js
 * @description How much of each deposit to the wallet each managed
 * position counts, when more than one holds the deposited coin
 * (src/lib/deposit-attribution.js).
 *
 * The rule: while the coins wait in the wallet, each position counts the
 * share of them the Wallet Residual (Pool) credits it; a rebalance takes
 * them all into its new NFT; a compound takes the deposits' part of what
 * it took from the wallet, in proportion to their share of the wallet's
 * balance just before it. The worked case below is the one the user
 * approved: 1,000 deposited, holdings 60/40, a compound taking 300.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  attributeCoin,
  countedFor,
  takenAt,
} = require("../src/lib/deposit-attribution");

const C = "0xshared";
const X = "0xonlya";
const Y = "0xonlyb";

/** A deposit of the shared coin, as coin 0 of the pool listing it. */
const deposit = (key, block, raw, usd = raw) => ({
  key,
  block,
  raw: [raw, 0],
  usd: [usd, 0],
});

/** A position holding the shared coin, as its coin 0. */
function holder(id, extra = {}) {
  return {
    id,
    coins: [C, id === "A" ? X : Y],
    deposits: [],
    mints: [],
    compounds: [],
    ...extra,
  };
}

const near = (actual, expected, label) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-6,
    `${label}: ${actual} is not ${expected}`,
  );

describe("a deposit of a coin one position holds", () => {
  it("counts in full while it waits, at the share the credit gives it", () => {
    const a = holder("A", { deposits: [deposit("0xd", 100, 1000)] });
    const r = attributeCoin([a], C);
    near(countedFor(r, "A", 1).raw, 1000, "waiting, the only holder");
  });

  it("counts in full once its rebalance takes it", () => {
    const a = holder("A", {
      deposits: [deposit("0xd", 100, 1000)],
      mints: [200],
    });
    const r = attributeCoin([a], C);
    near(countedFor(r, "A", 0).raw, 1000, "taken, whatever the share");
  });
});

describe("a deposit of a coin two positions hold", () => {
  /*- Both positions list the same deposit; it arrived once. */
  const lists = () => ({
    a: holder("A", { deposits: [deposit("0xd", 100, 1000)] }),
    b: holder("B", { deposits: [deposit("0xd", 100, 1000)] }),
  });

  it("counts once, divided by the credit's shares while it waits", () => {
    const { a, b } = lists();
    const r = attributeCoin([a, b], C);
    near(countedFor(r, "A", 0.6).raw, 600, "A's share");
    near(countedFor(r, "B", 0.4).raw, 400, "B's share");
    near(countedFor(r, "A", 0.6).usd, 600, "its dollars follow the coins");
  });

  it("counts in full for the position whose rebalance takes it, and none for the other", () => {
    const { a, b } = lists();
    a.mints = [200];
    const r = attributeCoin([a, b], C);
    near(countedFor(r, "A", 0.6).raw, 1000, "A took it all");
    near(countedFor(r, "B", 0.4).raw, 0, "B has none of it");
    near(takenAt(r, "A", 200), 1000, "what A's rebalance took");
  });

  it("takes a deposit in its mint's own block, and not one after it", () => {
    const { a, b } = lists();
    a.mints = [100];
    b.deposits.push(deposit("0xlater", 300, 50));
    const r = attributeCoin([a, b], C);
    near(
      countedFor(r, "A", 0.5).raw,
      1000 + 25,
      "the first, and half the later",
    );
    near(countedFor(r, "B", 0.5).raw, 25, "half the later");
  });

  it("splits a compound's take as the user's worked case: 300 of 1,000, then 9/13", () => {
    const { a, b } = lists();
    a.compounds = [{ block: 200, take: [300, 0], walletBefore: [1000, 0] }];
    const r = attributeCoin([a, b], C);
    /*- After it, A's NFT holds 900 of the coin and B's 400: 9/13, 4/13. */
    near(countedFor(r, "A", 9 / 13).raw, 300 + (700 * 9) / 13, "A");
    near(countedFor(r, "B", 4 / 13).raw, (700 * 4) / 13, "B");
  });

  it("takes only the deposits' share of a compound's take when the wallet held other coins", () => {
    const { a, b } = lists();
    /*- 500 leftovers beside the 1,000: two thirds of the take was deposit. */
    a.compounds = [{ block: 200, take: [300, 0], walletBefore: [1500, 0] }];
    const r = attributeCoin([a, b], C);
    near(countedFor(r, "A", 0).raw, 200, "A's part");
    near(countedFor(r, "B", 1).raw, 800, "what still waits");
  });

  it("takes the deposits' coins first from a compound with no wallet reading", () => {
    const { a, b } = lists();
    a.compounds = [
      { block: 200, take: [300, 0], walletBefore: [null, null] },
      { block: 300, take: [2000, 0], walletBefore: [null, null] },
    ];
    const r = attributeCoin([a, b], C);
    near(countedFor(r, "A", 0).raw, 1000, "300, then the rest");
    near(countedFor(r, "B", 1).raw, 0, "nothing waits");
  });

  it("takes nothing more once a rebalance has taken it", () => {
    const { a, b } = lists();
    a.mints = [200];
    b.compounds = [{ block: 300, take: [300, 0], walletBefore: [300, 0] }];
    const r = attributeCoin([a, b], C);
    near(countedFor(r, "B", 1).raw, 0, "B's compound took leftovers");
    assert.equal(r.takes.length, 1, "only A's rebalance took any of it");
  });

  it("keeps each coin apart: a deposit of A's other coin is A's alone", () => {
    /*- A deposit brings one coin (`_isDeposit`, src/lib/wallet-deposits.js):
     *  here one of the shared coin, which both list, and one of the coin
     *  only A holds. */
    const own = { key: "0xx", block: 100, raw: [0, 70], usd: [0, 7] };
    const a = holder("A", { deposits: [deposit("0xd", 100, 1000), own] });
    const b = holder("B", { deposits: [deposit("0xd", 100, 1000)] });
    near(countedFor(attributeCoin([a, b], X), "A", 1).raw, 70, "A's own coin");
    near(countedFor(attributeCoin([a, b], X), "A", 1).usd, 7, "its dollars");
    near(countedFor(attributeCoin([a, b], C), "A", 0.5).raw, 500, "shared");
  });

  it("finds a deposit only the other position lists, when this one's rebalance takes it", () => {
    const a = holder("A", { mints: [200] });
    const b = holder("B", { deposits: [deposit("0xd", 100, 1000)] });
    const r = attributeCoin([a, b], C);
    near(countedFor(r, "A", 0).raw, 1000, "its NFT holds the coins");
    near(countedFor(r, "B", 1).raw, 0, "B's list names it, but it is gone");
  });
});
