"use strict";

/**
 * @file test/coin-decimals.test.js
 * @description `coinDecimals` (src/lib/coin-decimals.js): a rebalance result's
 *   or a position's decimals, with 18 standing in for any not carried.
 *
 *   The user ruled the guess acceptable on the condition that reaching it
 *   is logged: "make sure that if the assuming line of code is reached, a
 *   proper console log message is given about that". So every guess is a
 *   warning naming the NFT, the coin and the reader, and decimals that
 *   are present, zero included, are taken as they are without a word.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { log } = require("../src/lib/log");
const { coinDecimals } = require("../src/lib/coin-decimals");

/** Run `fn` with the warning log captured as formatted-enough lines. */
function captureWarns(t) {
  const lines = [];
  t.mock.method(log, "warn", (...args) => lines.push(args.join(" | ")));
  return lines;
}

describe("coinDecimals", () => {
  it("takes the decimals carried, saying nothing", (t) => {
    const lines = captureWarns(t);
    assert.deepEqual(
      coinDecimals({ decimals0: 6, decimals1: 8 }, "the result", "a reader"),
      { d0: 6, d1: 8 },
    );
    assert.deepEqual(lines, []);
  });

  it("takes zero decimals as carried, not as missing", (t) => {
    const lines = captureWarns(t);
    assert.deepEqual(
      coinDecimals({ decimals0: 0, decimals1: 18 }, "the result", "a reader"),
      { d0: 0, d1: 18 },
    );
    assert.deepEqual(lines, []);
  });

  it("assumes 18 for a coin not carried, warning with the NFT, the coin and the reader", (t) => {
    const lines = captureWarns(t);
    const d = coinDecimals(
      { decimals0: 6, newTokenId: 4242n },
      "the rebalance result",
      "the closing period's exit value",
    );
    assert.deepEqual(d, { d0: 6, d1: 18 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /4242/);
    assert.match(lines[0], /the rebalance result/);
    assert.match(lines[0], /token1/);
    assert.doesNotMatch(lines[0], /token0/);
    assert.match(lines[0], /the closing period's exit value/);
  });

  it("names both coins in one warning when neither is carried", (t) => {
    const lines = captureWarns(t);
    const d = coinDecimals({ tokenId: "77" }, "the position", "a reader");
    assert.deepEqual(d, { d0: 18, d1: 18 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /token0 and token1/);
    assert.match(lines[0], /77/);
  });
});
