/**
 * @file test/gas-monitor.test.js
 * @description Unit tests for the gas-monitor module.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  checkGasBalance,
  STANDARD_SEND_TX_COST_FACTOR,
  _computeThreshold,
  _lastRebalanceGasNative,
  _formatNative,
} = require("../src/gas-monitor");

let _originalFetch;
beforeEach(() => {
  _originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

describe("gas-monitor — STANDARD_SEND_TX_COST_FACTOR", () => {
  it("is 38 (800k rebalance / 21k send)", () => {
    assert.strictEqual(STANDARD_SEND_TX_COST_FACTOR, 38);
  });
});

describe("gas-monitor — _lastRebalanceGasNative", () => {
  it("returns 0n when no tracker", () => {
    assert.strictEqual(_lastRebalanceGasNative(null), 0n);
  });

  it("returns 0n when no closed epochs", () => {
    const tracker = { serialize: () => ({ closedEpochs: [] }) };
    assert.strictEqual(_lastRebalanceGasNative(tracker), 0n);
  });

  it("returns last epoch gasNative as wei", () => {
    const tracker = {
      serialize: () => ({
        closedEpochs: [{ gasNative: 0.001 }, { gasNative: 0.005 }],
      }),
    };
    const result = _lastRebalanceGasNative(tracker);
    assert.strictEqual(result, BigInt(Math.round(0.005 * 1e18)));
  });
});

describe("gas-monitor — _computeThreshold", () => {
  it("uses 4x last rebalance gas when available", async () => {
    const tracker = {
      serialize: () => ({
        closedEpochs: [{ gasNative: 0.01 }],
      }),
    };
    const provider = { getFeeData: async () => ({ gasPrice: 1000n }) };
    const result = await _computeThreshold(provider, tracker);
    const expected = BigInt(Math.round(0.01 * 1e18)) * 4n;
    assert.strictEqual(result, expected);
  });

  it("falls back to send cost × factor × 2 when no epochs", async () => {
    const gasPrice = 30_000_000_000n; // 30 gwei
    const provider = { getFeeData: async () => ({ gasPrice }) };
    const result = await _computeThreshold(provider, null);
    const expected = gasPrice * 21_000n * 38n * 2n;
    assert.strictEqual(result, expected);
  });

  it("returns 0n when getFeeData fails", async () => {
    const provider = {
      getFeeData: async () => {
        throw new Error("rpc");
      },
    };
    const result = await _computeThreshold(provider, null);
    assert.strictEqual(result, 0n);
  });
});

describe("gas-monitor — checkGasBalance", () => {
  it("alerts when balance is below threshold", async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    const alertState = { alerted: false };
    const provider = {
      getBalance: async () => 1000n,
      getFeeData: async () => ({ gasPrice: 30_000_000_000n }),
    };
    await checkGasBalance({
      provider,
      address: "0x1234",
      pnlTracker: null,
      position: { tokenId: 42 },
      alertState,
    });
    assert.strictEqual(alertState.alerted, true);
  });

  it("does not re-alert once alerted", async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return { ok: true, json: async () => ({}) };
    };
    const alertState = { alerted: true };
    const provider = {
      getBalance: async () => 1000n,
      getFeeData: async () => ({ gasPrice: 30_000_000_000n }),
    };
    await checkGasBalance({
      provider,
      address: "0x1234",
      pnlTracker: null,
      position: { tokenId: 42 },
      alertState,
    });
    assert.strictEqual(fetchCount, 0, "should not send again");
  });

  it("resets alert when balance recovers", async () => {
    const alertState = { alerted: true };
    const provider = {
      getBalance: async () => 999_000_000_000_000_000_000n, // 999 native
      getFeeData: async () => ({ gasPrice: 1n }),
    };
    await checkGasBalance({
      provider,
      address: "0x1234",
      pnlTracker: null,
      position: { tokenId: 42 },
      alertState,
    });
    assert.strictEqual(alertState.alerted, false, "should reset");
  });
});

describe("gas-monitor — _formatNative", () => {
  it("formats large values with 4 decimals", () => {
    assert.strictEqual(_formatNative(1_500_000_000_000_000_000n), "1.5000");
  });

  it("formats tiny values in scientific notation", () => {
    const result = _formatNative(1_000_000_000n); // 0.000000001
    assert.ok(
      result.includes("e"),
      `expected scientific notation, got ${result}`,
    );
  });
});
