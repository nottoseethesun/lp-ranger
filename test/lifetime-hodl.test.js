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
  _freshDeposits,
} = require("../src/lifetime-hodl");

function ilEvent(a0, a1, block = 100) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}
function colEvent(a0, a1, block = 200) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}
function dlEvent(liq, block = 150, a0 = 0, a1 = 0) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    liquidity: BigInt(liq),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}

function _topicsMatch(logTopics, filterTopics) {
  if (!filterTopics) return true;
  for (let i = 0; i < filterTopics.length; i++) {
    if (filterTopics[i] === null) continue;
    if (logTopics[i] !== filterTopics[i]) return false;
  }
  return true;
}

function mockProvider(opts = {}) {
  const balances = opts.balances || {};
  const logs = opts.logs || [];
  return {
    getLogs(filter) {
      return Promise.resolve(
        logs.filter(
          (l) =>
            l.address === filter.address &&
            l.blockNumber >= filter.fromBlock &&
            l.blockNumber <= filter.toBlock &&
            _topicsMatch(l.topics, filter.topics),
        ),
      );
    },
    _balances: balances,
  };
}

const TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
function mockEthers() {
  return {
    Contract: class {
      constructor(addr, _abi, prov) {
        this._addr = addr;
        this._prov = prov;
      }
      async balanceOf(_w, opts = {}) {
        const b = opts.blockTag || "latest";
        return (this._prov._balances[this._addr] || {})[b] ?? 0n;
      }
    },
    zeroPadValue(addr, _len) {
      return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
    },
    id(_s) {
      return TOPIC0;
    },
  };
}

/** Create a two-NFT rebalance test fixture (drain NFT #50 → mint NFT #100). */
function twoNftFixture(drain0, drain1, mint0, mint1) {
  const events = new Map();
  events.set("50", {
    ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
    collectEvents: [colEvent(drain0, drain1, 200)],
    dlEvents: [dlEvent(1000, 150)],
  });
  events.set("100", {
    ilEvents: [ilEvent(mint0, mint1, 210)],
    collectEvents: [],
    dlEvents: [],
  });
  const rebalanceEvents = [{ oldTokenId: "50", newTokenId: "100" }];
  return { events, rebalanceEvents };
}

describe("lifetime-hodl", () => {
  describe("_buildChainOrder", () => {
    it("returns single tokenId for no rebalances", () => {
      assert.deepStrictEqual(_buildChainOrder("100", []), ["100"]);
    });
    it("orders oldest to newest with rebalance events", () => {
      const events = [
        { oldTokenId: "10", newTokenId: "20" },
        { oldTokenId: "20", newTokenId: "30" },
      ];
      assert.deepStrictEqual(_buildChainOrder("30", events), [
        "10",
        "20",
        "30",
      ]);
    });
  });

  describe("computeLifetimeHodl", () => {
    const pos8 = { tokenId: "100", decimals0: 8, decimals1: 8 };

    it("single NFT, original deposit only", async () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
        collectEvents: [],
        dlEvents: [],
      });
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: pos8,
      });
      assert.strictEqual(r.amount0, 1000);
      assert.strictEqual(r.amount1, 2000);
    });

    it("single NFT + external deposit", async () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 10),
          ilEvent(500_00000000, 800_00000000, 5000),
        ],
        collectEvents: [],
        dlEvents: [],
      });
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: pos8,
      });
      assert.strictEqual(r.amount0, 1500);
      assert.strictEqual(r.amount1, 2800);
    });

    it("two NFTs, no fresh deposits — no provider", async () => {
      const { events, rebalanceEvents } = twoNftFixture(
        1000_00000000,
        2000_00000000,
        1000_00000000,
        2000_00000000,
      );
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents,
        position: pos8,
      });
      assert.strictEqual(r.amount0, 1000);
      assert.strictEqual(r.amount1, 2000);
    });

    it("rebalance with no fresh capital (Transfer scan)", async () => {
      const t0 = "0xToken0",
        t1 = "0xToken1",
        w = "0xWallet";
      const prov = mockProvider({});
      const { events, rebalanceEvents } = twoNftFixture(
        1000_00000000,
        2000_00000000,
        1000_00000000,
        2000_00000000,
      );
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents,
        position: { ...pos8, token0: t0, token1: t1 },
        provider: prov,
        ethersLib: mockEthers(),
        walletAddress: w,
      });
      assert.strictEqual(r.amount0, 1000);
      assert.strictEqual(r.amount1, 2000);
    });

    it("rebalance with deposit Transfer before drain", async () => {
      const t0 = "0xToken0",
        t1 = "0xToken1",
        w = "0xWallet";
      const e = mockEthers();
      const wPad = e.zeroPadValue(w, 32);
      const extPad = e.zeroPadValue("0xExternal", 32);
      // 500 token0 deposited between prev mint (block 10) and next mint (block 210)
      const depositLog = {
        address: t0,
        topics: [TOPIC0, extPad, wPad],
        data: "0x" + 500_00000000n.toString(16).padStart(64, "0"),
        blockNumber: 50,
        transactionHash: "0xdep1",
      };
      const prov = mockProvider({ logs: [depositLog] });
      const { events, rebalanceEvents } = twoNftFixture(
        1000_00000000,
        2000_00000000,
        1500_00000000,
        2000_00000000,
      );
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents,
        position: { ...pos8, token0: t0, token1: t1 },
        provider: prov,
        ethersLib: e,
        walletAddress: w,
      });
      assert.strictEqual(r.amount0, 1500);
      assert.strictEqual(r.amount1, 2000);
    });

    it("rebalance with Transfer deposit between drain and mint", async () => {
      const t0 = "0xToken0",
        t1 = "0xToken1",
        w = "0xWallet";
      const e = mockEthers();
      const wPad = e.zeroPadValue(w, 32);
      const extPad = e.zeroPadValue("0xExternal", 32);
      const depositLog = {
        address: t0,
        topics: [TOPIC0, extPad, wPad],
        data: "0x" + 300_00000000n.toString(16).padStart(64, "0"),
        blockNumber: 205,
        transactionHash: "0xdeposit1",
      };
      const prov = mockProvider({ logs: [depositLog] });
      const { events, rebalanceEvents } = twoNftFixture(
        1000_00000000,
        2000_00000000,
        1300_00000000,
        2000_00000000,
      );
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents,
        position: { ...pos8, token0: t0, token1: t1 },
        provider: prov,
        ethersLib: e,
        walletAddress: w,
      });
      assert.strictEqual(r.amount0, 1300);
      assert.strictEqual(r.amount1, 2000);
    });

    it("swap TX excluded from fresh deposits", async () => {
      const t0 = "0xToken0",
        t1 = "0xToken1",
        w = "0xWallet";
      const e = mockEthers();
      const wPad = e.zeroPadValue(w, 32);
      const rPad = e.zeroPadValue("0xRouter", 32);
      const swapOut = {
        address: t0,
        topics: [TOPIC0, wPad, rPad],
        data: "0x" + 500_00000000n.toString(16).padStart(64, "0"),
        blockNumber: 205,
        transactionHash: "0xswap1",
      };
      const swapIn = {
        address: t1,
        topics: [TOPIC0, rPad, wPad],
        data: "0x" + 800_00000000n.toString(16).padStart(64, "0"),
        blockNumber: 205,
        transactionHash: "0xswap1",
      };
      const prov = mockProvider({ logs: [swapOut, swapIn] });
      const { events, rebalanceEvents } = twoNftFixture(
        1000_00000000,
        2000_00000000,
        500_00000000,
        2800_00000000,
      );
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents,
        position: { ...pos8, token0: t0, token1: t1 },
        provider: prov,
        ethersLib: e,
        walletAddress: w,
      });
      assert.strictEqual(r.amount0, 1000);
      assert.strictEqual(r.amount1, 2000);
    });

    it("external deposit on second NFT via IL", async () => {
      const events = new Map();
      events.set("50", {
        ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
        collectEvents: [colEvent(1000_00000000, 2000_00000000, 200)],
        dlEvents: [dlEvent(1000, 150)],
      });
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 210),
          ilEvent(500_00000000, 300_00000000, 5000),
        ],
        collectEvents: [],
        dlEvents: [],
      });
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents: [{ oldTokenId: "50", newTokenId: "100" }],
        position: pos8,
      });
      assert.strictEqual(r.amount0, 1500);
      assert.strictEqual(r.amount1, 2300);
    });

    it("compound events excluded from accumulation", async () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 10),
          ilEvent(50_00000000, 30_00000000, 500),
        ],
        collectEvents: [colEvent(100_00000000, 80_00000000, 400)],
        dlEvents: [],
      });
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: pos8,
      });
      assert.strictEqual(r.amount0, 1000);
      assert.strictEqual(r.amount1, 2000);
    });

    it("IL exceeding fee cap treated as external deposit", async () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 10),
          ilEvent(500_00000000, 300_00000000, 500),
        ],
        collectEvents: [colEvent(10_00000000, 5_00000000, 400)],
        dlEvents: [],
      });
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: pos8,
      });
      assert.strictEqual(r.amount0, 1500);
      assert.strictEqual(r.amount1, 2300);
    });

    it("fee cap subtracts DL amounts from Collect amounts", async () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [
          ilEvent(1000_00000000, 2000_00000000, 10),
          ilEvent(500_00000000, 300_00000000, 500),
        ],
        collectEvents: [colEvent(1500_00000000, 2500_00000000, 100_000)],
        dlEvents: [dlEvent(1000, 100_000, 1490_00000000, 2490_00000000)],
      });
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: pos8,
      });
      assert.strictEqual(r.amount0, 1500);
      assert.strictEqual(r.amount1, 2300);
    });

    it("handles empty events gracefully", async () => {
      const events = new Map();
      events.set("100", { ilEvents: [], collectEvents: [], dlEvents: [] });
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: pos8,
      });
      assert.strictEqual(r.amount0, 0);
      assert.strictEqual(r.amount1, 0);
    });

    it("uses position decimals for conversion", async () => {
      const events = new Map();
      events.set("100", {
        ilEvents: [ilEvent("1000000000000000000", "2000000000000000000", 10)],
        collectEvents: [],
        dlEvents: [],
      });
      const r = await computeLifetimeHodl(events, {
        rebalanceEvents: [],
        position: { tokenId: "100", decimals0: 18, decimals1: 18 },
      });
      assert.strictEqual(r.amount0, 1);
      assert.strictEqual(r.amount1, 2);
    });
  });

  describe("_freshDeposits", () => {
    it("finds deposit Transfer between prev mint and next mint", async () => {
      const e = mockEthers();
      const wPad = e.zeroPadValue("0xW", 32);
      const extPad = e.zeroPadValue("0xExt", 32);
      const depositLog = {
        address: "0xT0",
        topics: [TOPIC0, extPad, wPad],
        data: "0x" + 500n.toString(16).padStart(64, "0"),
        blockNumber: 105,
        transactionHash: "0xdep1",
      };
      const prov = mockProvider({ logs: [depositLog] });
      const { f0, f1 } = await _freshDeposits(
        prov,
        e,
        "0xT0",
        "0xT1",
        "0xW",
        100,
        210,
      );
      assert.strictEqual(f0, 500n);
      assert.strictEqual(f1, 0n);
    });

    it("returns zero when no transfers in window", async () => {
      const prov = mockProvider({});
      const { f0, f1 } = await _freshDeposits(
        prov,
        mockEthers(),
        "0xT0",
        "0xT1",
        "0xW",
        100,
        210,
      );
      assert.strictEqual(f0, 0n);
      assert.strictEqual(f1, 0n);
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
      const snap = { closedEpochs: [{ hodlAmount0: 30, hodlAmount1: 15 }] };
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

    it("uses scan amounts even when baseline is larger", () => {
      const { _lifetimeAmounts } = require("../src/bot-pnl-updater");
      const deps = {
        _botState: {
          lifetimeHodlAmounts: { amount0: 50, amount1: 30 },
          hodlBaseline: { hodlAmount0: 200, hodlAmount1: 100 },
        },
      };
      const { a0, a1 } = _lifetimeAmounts(deps, { closedEpochs: [] });
      assert.strictEqual(a0, 50);
      assert.strictEqual(a1, 30);
    });

    it("_ilFor returns undefined when amounts are zero", () => {
      const { _ilFor } = require("../src/bot-pnl-updater");
      assert.strictEqual(_ilFor(100, 0, 0, 1, 1), undefined);
    });

    it("_ilFor computes HODL IL", () => {
      const { _ilFor } = require("../src/bot-pnl-updater");
      assert.strictEqual(_ilFor(100, 50, 50, 1, 1), 0);
    });

    it("_maxAmount picks larger value", () => {
      const { _maxAmount } = require("../src/bot-pnl-updater");
      assert.strictEqual(_maxAmount(10, 5), 10);
      assert.strictEqual(_maxAmount(3, 7), 7);
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
