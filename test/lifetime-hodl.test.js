/**
 * @file test/lifetime-hodl.test.js
 * @description Tests for lifetime HODL amount accumulation across rebalance chains.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  computeLifetimeHodl,
  _buildChainOrder,
} = require("../src/lifetime-hodl");

/** Helper: build a mock IL event with BigInt amounts. */
function ilEvent(amount0, amount1, blockNumber = 100) {
  return {
    amount0: BigInt(amount0),
    amount1: BigInt(amount1),
    blockNumber,
    txHash: "0x" + blockNumber.toString(16),
  };
}

/** Helper: build a mock Collect event. */
function colEvent(amount0, amount1, blockNumber = 200) {
  return {
    amount0: BigInt(amount0),
    amount1: BigInt(amount1),
    blockNumber,
    txHash: "0x" + blockNumber.toString(16),
  };
}

/** Helper: build a mock DecreaseLiquidity event. */
function dlEvent(liquidity, blockNumber = 150, amount0 = 0, amount1 = 0) {
  return {
    amount0: BigInt(amount0),
    amount1: BigInt(amount1),
    liquidity: BigInt(liquidity),
    blockNumber,
    txHash: "0x" + blockNumber.toString(16),
  };
}

describe("lifetime-hodl", () => {
  describe("_buildChainOrder", () => {
    it("returns single tokenId for no rebalances", () => {
      const order = _buildChainOrder("100", []);
      assert.deepStrictEqual(order, ["100"]);
    });

    it("orders oldest to newest with rebalance events", () => {
      const events = [
        { oldTokenId: "10", newTokenId: "20" },
        { oldTokenId: "20", newTokenId: "30" },
      ];
      const order = _buildChainOrder("30", events);
      assert.deepStrictEqual(order, ["10", "20", "30"]);
    });
  });

  describe("computeLifetimeHodl", () => {
    const basePosition = { tokenId: "100", decimals0: 8, decimals1: 8 };

    it("single NFT, original deposit only", () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
        collectEvents: [],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: basePosition,
      });
      assert.strictEqual(result.amount0, 1000);
      assert.strictEqual(result.amount1, 2000);
    });

    it("single NFT + external deposit", () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 10), // mint
          ilEvent(500_00000000, 800_00000000, 5000), // external deposit (no fees collected)
        ],
        collectEvents: [],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: basePosition,
      });
      assert.strictEqual(result.amount0, 1500);
      assert.strictEqual(result.amount1, 2800);
    });

    it("two NFTs (rebalance), no extra deposits", () => {
      const events = new Map();
      // First NFT: minted 1000/2000, then drained
      events.set("50", {
        ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
        collectEvents: [colEvent(1000_00000000, 2000_00000000, 200)],
        dlEvents: [dlEvent(1000, 150)],
      });
      // Second NFT: rebalance mint with same amounts
      events.set("100", {
        ilEvents: [ilEvent(1000_00000000, 2000_00000000, 210)],
        collectEvents: [],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "100" }],
        position: basePosition,
      });
      // Lifetime = original mint only (rebalance mint nets to 0)
      assert.strictEqual(result.amount0, 1000);
      assert.strictEqual(result.amount1, 2000);
    });

    it("rebalance mint ratio change ignored (swap, not deposit)", () => {
      const events = new Map();
      events.set("50", {
        ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
        collectEvents: [colEvent(1000_00000000, 2000_00000000, 200)],
        dlEvents: [dlEvent(1000, 150)],
      });
      // Rebalance mint with different ratio (swap changed it)
      events.set("100", {
        ilEvents: [ilEvent(1200_00000000, 1800_00000000, 210)],
        collectEvents: [],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "100" }],
        position: basePosition,
      });
      // Rebalance mint contributes 0 — ratio change is from swap, not deposit
      assert.strictEqual(result.amount0, 1000);
      assert.strictEqual(result.amount1, 2000);
    });

    it("external deposit on second NFT", () => {
      const events = new Map();
      events.set("50", {
        ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
        collectEvents: [colEvent(1000_00000000, 2000_00000000, 200)],
        dlEvents: [dlEvent(1000, 150)],
      });
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 210), // rebalance mint
          ilEvent(500_00000000, 300_00000000, 5000), // external deposit
        ],
        collectEvents: [],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "100" }],
        position: basePosition,
      });
      assert.strictEqual(result.amount0, 1500);
      assert.strictEqual(result.amount1, 2300);
    });

    it("compound events excluded from accumulation", () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 10), // mint
          ilEvent(50_00000000, 30_00000000, 500), // compound (within fee cap)
        ],
        collectEvents: [
          colEvent(100_00000000, 80_00000000, 400), // fees collected > compound
        ],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: basePosition,
      });
      // Compound (50/30) is within fee cap (100/80) → excluded
      assert.strictEqual(result.amount0, 1000);
      assert.strictEqual(result.amount1, 2000);
    });

    it("IL exceeding fee cap treated as external deposit", () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 10), // mint
          ilEvent(500_00000000, 300_00000000, 500), // exceeds fee cap
        ],
        collectEvents: [
          colEvent(10_00000000, 5_00000000, 400), // tiny fees
        ],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: basePosition,
      });
      // 500/300 exceeds fee cap 10/5 → treated as external deposit
      assert.strictEqual(result.amount0, 1500);
      assert.strictEqual(result.amount1, 2300);
    });

    it("fee cap subtracts DL amounts from Collect amounts", () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 10),
          ilEvent(500_00000000, 300_00000000, 500),
        ],
        collectEvents: [colEvent(1500_00000000, 2500_00000000, 100_000)],
        dlEvents: [dlEvent(1000, 100_000, 1490_00000000, 2490_00000000)],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: basePosition,
      });
      // feeCap = collect(1500/2500) - DL(1490/2490) = 10/10
      // deposit 500/300 > feeCap 10/10 → external
      assert.strictEqual(result.amount0, 1500);
      assert.strictEqual(result.amount1, 2300);
    });

    it("handles empty events gracefully", () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [],
        collectEvents: [],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: basePosition,
      });
      assert.strictEqual(result.amount0, 0);
      assert.strictEqual(result.amount1, 0);
    });

    it("uses position decimals for conversion", () => {
      const events = new Map();
      // 1e18 raw = 1.0 with decimals=18
      events.set("100", {
        ilEvents: [ilEvent("1000000000000000000", "2000000000000000000", 10)],
        collectEvents: [],
        dlEvents: [],
      });
      const result = computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: { tokenId: "100", decimals0: 18, decimals1: 18 },
      });
      assert.strictEqual(result.amount0, 1);
      assert.strictEqual(result.amount1, 2);
    });
  });

  describe("_lifetimeAmounts in bot-pnl-updater", () => {
    it("prefers lifetimeHodlAmounts over closedEpochs[0]", () => {
      const { _lifetimeAmounts } = require("../src/bot-pnl-updater");
      const deps = {
        _botState: {
          lifetimeHodlAmounts: { amount0: 100, amount1: 50 },
          hodlBaseline: { hodlAmount0: 5, hodlAmount1: 3 },
        },
      };
      const snap = {
        closedEpochs: [{ hodlAmount0: 30, hodlAmount1: 15 }],
      };
      const { a0, a1 } = _lifetimeAmounts(deps, snap);
      assert.strictEqual(a0, 100);
      assert.strictEqual(a1, 50);
    });

    it("falls back to closedEpochs[0] when no lifetimeHodlAmounts", () => {
      const { _lifetimeAmounts } = require("../src/bot-pnl-updater");
      const deps = {
        _botState: { hodlBaseline: { hodlAmount0: 5, hodlAmount1: 3 } },
      };
      const snap = { closedEpochs: [{ hodlAmount0: 30, hodlAmount1: 15 }] };
      const { a0, a1 } = _lifetimeAmounts(deps, snap);
      assert.strictEqual(a0, 30);
      assert.strictEqual(a1, 15);
    });

    it("uses baseline when it exceeds lifetime scan amounts", () => {
      const { _lifetimeAmounts } = require("../src/bot-pnl-updater");
      const deps = {
        _botState: {
          lifetimeHodlAmounts: { amount0: 50, amount1: 30 },
          hodlBaseline: { hodlAmount0: 200, hodlAmount1: 100 },
        },
      };
      const snap = { closedEpochs: [] };
      const { a0, a1 } = _lifetimeAmounts(deps, snap);
      assert.strictEqual(a0, 200);
      assert.strictEqual(a1, 100);
    });

    it("_ilFor returns undefined when amounts are zero", () => {
      const { _ilFor } = require("../src/bot-pnl-updater");
      assert.strictEqual(_ilFor(100, 0, 0, 1, 1), undefined);
    });

    it("_ilFor computes HODL IL", () => {
      const { _ilFor } = require("../src/bot-pnl-updater");
      const il = _ilFor(100, 50, 50, 1, 1);
      assert.strictEqual(typeof il, "number");
      assert.strictEqual(il, 0); // 100 - (50*1 + 50*1) = 0
    });

    it("_maxAmount picks larger value", () => {
      const { _maxAmount } = require("../src/bot-pnl-updater");
      assert.strictEqual(_maxAmount(10, 5), 10);
      assert.strictEqual(_maxAmount(3, 7), 7);
      assert.strictEqual(_maxAmount(0, 0), 0);
    });

    it("returns zeros when no data available", () => {
      const { _lifetimeAmounts } = require("../src/bot-pnl-updater");
      const { a0, a1 } = _lifetimeAmounts(
        { _botState: {} },
        { closedEpochs: [] },
      );
      assert.strictEqual(a0, 0);
      assert.strictEqual(a1, 0);
    });
  });
});
