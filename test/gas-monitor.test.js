/**
 * @file test/gas-monitor.test.js
 * @description Unit tests for the two-tier gas-monitor.
 *
 * Covers `computeGasStatus` tier logic, `getGasStatus` RPC wrapper,
 * `checkGasBalance` alert state machine, and the singleton observation
 * used by the /api/status handler.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  checkGasBalance,
  computeGasStatus,
  getGasStatus,
  getLatestObservation,
  WORST_CASE_GAS_FACTOR,
  SAFETY_MULTIPLIER,
  SEND_GAS,
  _formatNative,
} = require("../src/gas-monitor");

let _originalFetch;
beforeEach(() => {
  _originalFetch = globalThis.fetch;
  /*- Telegram notify posts via fetch; default mock keeps tests offline. */
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
});
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

describe("gas-monitor — constants (from tunables JSON)", () => {
  it("worst-case factor matches shipped tunables default (91)", () => {
    assert.strictEqual(WORST_CASE_GAS_FACTOR, 91);
  });
  it("safety multiplier matches shipped tunables default (3)", () => {
    assert.strictEqual(SAFETY_MULTIPLIER, 3);
  });
  it("send gas matches shipped tunables default (21000)", () => {
    assert.strictEqual(SEND_GAS, 21_000n);
  });
  it("loaded values match app-config/static-tunables/low-gas-thresholds.json", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const p = path.join(
      __dirname,
      "..",
      "app-config",
      "static-tunables",
      "low-gas-thresholds.json",
    );
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(json.worstCaseGasFactor, WORST_CASE_GAS_FACTOR);
    assert.strictEqual(json.safetyMultiplier, SAFETY_MULTIPLIER);
    assert.strictEqual(BigInt(json.standardSendGas), SEND_GAS);
  });
});

describe("gas-monitor — computeGasStatus tiers", () => {
  const gasPriceWei = 1_000_000_000_000n; // 1e12 wei/gas
  /* floorWei = 21000 × 91 × 1e12 = 1.911e18 */
  const floorWei = 21_000n * 91n * gasPriceWei;

  it("level='critical' when balance < floor", () => {
    const r = computeGasStatus({
      balanceWei: floorWei - 1n,
      gasPriceWei,
      positionCount: 1,
    });
    assert.strictEqual(r.level, "critical");
    assert.strictEqual(r.floorWei, floorWei);
  });

  it("level='low' when floor ≤ balance < recommended (N=1)", () => {
    /* recommended(1) = floor × 3 */
    const balanceWei = floorWei + 1n;
    const r = computeGasStatus({ balanceWei, gasPriceWei, positionCount: 1 });
    assert.strictEqual(r.level, "low");
    assert.strictEqual(r.recommendedWei, floorWei * 3n);
  });

  it("level='ok' when balance ≥ recommended", () => {
    const balanceWei = floorWei * 10n;
    const r = computeGasStatus({ balanceWei, gasPriceWei, positionCount: 1 });
    assert.strictEqual(r.level, "ok");
  });

  it("recommended scales linearly with positionCount", () => {
    const r1 = computeGasStatus({
      balanceWei: 0n,
      gasPriceWei,
      positionCount: 1,
    });
    const r4 = computeGasStatus({
      balanceWei: 0n,
      gasPriceWei,
      positionCount: 4,
    });
    assert.strictEqual(r4.recommendedWei, r1.recommendedWei * 4n);
  });

  it("floor is positionCount-independent (one rebalance)", () => {
    const r1 = computeGasStatus({
      balanceWei: 0n,
      gasPriceWei,
      positionCount: 1,
    });
    const r7 = computeGasStatus({
      balanceWei: 0n,
      gasPriceWei,
      positionCount: 7,
    });
    assert.strictEqual(r7.floorWei, r1.floorWei);
  });

  it("positionCount < 1 is clamped to 1 (prevent zero threshold)", () => {
    const r = computeGasStatus({
      balanceWei: 0n,
      gasPriceWei,
      positionCount: 0,
    });
    assert.strictEqual(r.positionCount, 1);
  });

  it("'low' for balance just above critical boundary (4 positions)", () => {
    /* With 4 positions, balance of 2 rebalances worth sits between
     * floor(1 rebalance) and recommended(12 rebalances). */
    const balanceWei = floorWei * 2n;
    const r = computeGasStatus({ balanceWei, gasPriceWei, positionCount: 4 });
    assert.strictEqual(r.level, "low");
  });
});

describe("gas-monitor — getGasStatus", () => {
  it("fetches balance + fee data and returns tier", async () => {
    const provider = {
      getBalance: async () => 100n,
      getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
    };
    const r = await getGasStatus({
      provider,
      address: "0x1",
      positionCount: 1,
    });
    assert.ok(r);
    assert.strictEqual(r.level, "critical");
  });

  it("returns null when gasPrice is zero or missing", async () => {
    const provider = {
      getBalance: async () => 100n,
      getFeeData: async () => ({ gasPrice: 0n }),
    };
    const r = await getGasStatus({
      provider,
      address: "0x1",
      positionCount: 1,
    });
    assert.strictEqual(r, null);
  });

  it("returns null on RPC error", async () => {
    const provider = {
      getBalance: async () => {
        throw new Error("rpc");
      },
      getFeeData: async () => ({ gasPrice: 1n }),
    };
    const r = await getGasStatus({
      provider,
      address: "0x1",
      positionCount: 1,
    });
    assert.strictEqual(r, null);
  });

  it("updates the singleton observation", async () => {
    const provider = {
      getBalance: async () => 42n,
      getFeeData: async () => ({ gasPrice: 7n }),
    };
    await getGasStatus({ provider, address: "0x1", positionCount: 1 });
    const obs = getLatestObservation();
    assert.strictEqual(obs.balanceWei, 42n);
    assert.strictEqual(obs.gasPriceWei, 7n);
    assert.ok(typeof obs.ts === "number");
  });
});

describe("gas-monitor — checkGasBalance alert state", () => {
  it("alerts when tier drops to 'low'", async () => {
    const alertState = { alerted: false };
    /* Balance between floor and recommended → low. */
    const gasPriceWei = 1_000_000_000_000n;
    const floorWei = 21_000n * 91n * gasPriceWei;
    const provider = {
      getBalance: async () => floorWei + 1n,
      getFeeData: async () => ({ gasPrice: gasPriceWei }),
    };
    await checkGasBalance({
      provider,
      address: "0x1",
      position: { tokenId: 42 },
      alertState,
      getPositionCount: () => 1,
    });
    assert.strictEqual(alertState.alerted, true);
  });

  it("alerts when tier is 'critical'", async () => {
    const alertState = { alerted: false };
    const provider = {
      getBalance: async () => 1n,
      getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
    };
    await checkGasBalance({
      provider,
      address: "0x1",
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
      getBalance: async () => 1n,
      getFeeData: async () => ({ gasPrice: 1n }),
    };
    await checkGasBalance({
      provider,
      address: "0x1",
      position: { tokenId: 42 },
      alertState,
    });
    assert.strictEqual(fetchCount, 0, "should not notify again");
  });

  it("resets alert when balance recovers to 'ok'", async () => {
    const alertState = { alerted: true };
    const provider = {
      getBalance: async () => 10n ** 25n,
      getFeeData: async () => ({ gasPrice: 1n }),
    };
    await checkGasBalance({
      provider,
      address: "0x1",
      position: { tokenId: 42 },
      alertState,
      getPositionCount: () => 4,
    });
    assert.strictEqual(alertState.alerted, false);
  });

  it("scales recommendation with getPositionCount", async () => {
    /* With N=4, same balance that would be 'ok' for N=1 should alert. */
    const gasPriceWei = 1n;
    const floorWei = 21_000n * 91n * gasPriceWei;
    /* Balance = 5 × floor → ok for N=1 (need 3×), low for N=4 (need 12×). */
    const balance = floorWei * 5n;
    const alertState = { alerted: false };
    await checkGasBalance({
      provider: {
        getBalance: async () => balance,
        getFeeData: async () => ({ gasPrice: gasPriceWei }),
      },
      address: "0x1",
      position: { tokenId: 1 },
      alertState,
      getPositionCount: () => 4,
    });
    assert.strictEqual(alertState.alerted, true);
  });
});

describe("gas-monitor — _formatNative", () => {
  it("formats large values with 4 decimals", () => {
    assert.strictEqual(_formatNative(1_500_000_000_000_000_000n), "1.5000");
  });
  it("formats tiny values in scientific notation", () => {
    const result = _formatNative(1_000_000_000n);
    assert.ok(result.includes("e"));
  });
});
