/**
 * @file test/nft-move-rules.test.js
 * @description The two rules that find the transaction a move began
 * with: a rebalance's drain and a compound's collect. The bot applies
 * them to the NFT events its lifetime scan reads, for the Activity Log's
 * figures, and the bookkeeping report in util/bookkeeping applies them
 * to the logs it searches for (its own suite covers that wiring).
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  drainBefore,
  collectBeforeDeposit,
} = require("../src/lib/nft-move-rules");

const hash = (n) => "0x" + String(n).padStart(64, "0");
const SPAN = 9000;

describe("drainBefore", () => {
  it("is the latest DecreaseLiquidity at or before the mint", () => {
    const decreases = [
      { blockNumber: 900, txHash: hash(900) },
      { blockNumber: 950, txHash: hash(950) },
      { blockNumber: 1200, txHash: hash(1200) },
    ];
    assert.equal(drainBefore(decreases, 1000).blockNumber, 950);
    assert.equal(drainBefore(decreases, 950).blockNumber, 950);
  });

  it("takes the given events in any order", () => {
    const decreases = [
      { blockNumber: 950, txHash: hash(950) },
      { blockNumber: 900, txHash: hash(900) },
    ];
    assert.equal(drainBefore(decreases, 1000).blockNumber, 950);
  });

  it("orders events in one block by their place in it when known", () => {
    const decreases = [
      { blockNumber: 950, logIndex: 7, txHash: hash(7) },
      { blockNumber: 950, logIndex: 2, txHash: hash(2) },
    ];
    assert.equal(drainBefore(decreases, 1000).txHash, hash(7));
  });

  it("is null when the NFT has none at or before the mint", () => {
    assert.equal(
      drainBefore([{ blockNumber: 1200, txHash: hash(1) }], 1000),
      null,
    );
    assert.equal(drainBefore([], 1000), null);
    assert.equal(drainBefore(undefined, 1000), null);
  });
});

describe("collectBeforeDeposit", () => {
  const deposit = { blockNumber: 105, txHash: hash(105) };
  const ev = (kind, blockNumber, extra = {}) => ({
    kind,
    blockNumber,
    txHash: hash(blockNumber),
    ...extra,
  });

  it("finds the collect just before the deposit", () => {
    const events = [ev("deposit", 50), ev("collect", 100), ev("deposit", 105)];
    assert.equal(collectBeforeDeposit(events, deposit, SPAN).blockNumber, 100);
  });

  it("finds none when another deposit came after the collect", () => {
    /*-
     *  The owner's own deposit at 95 sits between the collect and this
     *  deposit, so nothing was collected for this one.
     */
    const events = [ev("collect", 90), ev("deposit", 95), ev("deposit", 105)];
    assert.equal(collectBeforeDeposit(events, deposit, SPAN), null);
  });

  it("counts the mint as a deposit", () => {
    const events = [ev("deposit", 50), ev("deposit", 105)];
    assert.equal(collectBeforeDeposit(events, deposit, SPAN), null);
  });

  it("finds none when the deposit is alone in the span", () => {
    assert.equal(
      collectBeforeDeposit([ev("deposit", 105)], deposit, SPAN),
      null,
    );
    assert.equal(collectBeforeDeposit([], deposit, SPAN), null);
  });

  it("looks back one span of blocks and no further", () => {
    // A collect exactly one span back is the oldest the rule reaches.
    const atEdge = { blockNumber: 10_000, txHash: hash(10_000) };
    const inside = [ev("collect", 1001), ev("deposit", 10_000)];
    assert.equal(collectBeforeDeposit(inside, atEdge, SPAN).blockNumber, 1001);
    const outside = [ev("collect", 1000), ev("deposit", 10_000)];
    assert.equal(collectBeforeDeposit(outside, atEdge, SPAN), null);
  });

  it("sets the deposit's own transaction aside, whatever its case", () => {
    /*-
     *  A hash with letters in it, written in lower case by the chain and
     *  in upper case by the caller: still the same transaction, so the
     *  deposit is not mistaken for another deposit before itself.
     */
    const lower = "0x" + "ab".repeat(32);
    const events = [
      ev("collect", 100),
      { kind: "deposit", blockNumber: 105, txHash: lower },
    ];
    const caller = { blockNumber: 105, txHash: "0x" + "AB".repeat(32) };
    assert.equal(collectBeforeDeposit(events, caller, SPAN).blockNumber, 100);
  });

  it("orders a shared block by place in it, the deposit's own place taken from its event", () => {
    const sameBlock = { blockNumber: 105, txHash: hash(5) };
    const before = [
      { kind: "collect", blockNumber: 105, logIndex: 1, txHash: hash(1) },
      { kind: "deposit", blockNumber: 105, logIndex: 4, txHash: hash(5) },
    ];
    assert.equal(collectBeforeDeposit(before, sameBlock, SPAN).txHash, hash(1));
    const after = [
      { kind: "deposit", blockNumber: 105, logIndex: 1, txHash: hash(5) },
      { kind: "collect", blockNumber: 105, logIndex: 4, txHash: hash(1) },
    ];
    assert.equal(collectBeforeDeposit(after, sameBlock, SPAN), null);
  });

  it("ignores events after the deposit", () => {
    const events = [ev("deposit", 105), ev("collect", 110)];
    assert.equal(collectBeforeDeposit(events, deposit, SPAN), null);
  });
});
