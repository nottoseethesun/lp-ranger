/**
 * @file test/server-positions.test.js
 * @description Unit tests for src/server-positions.js.
 *
 * Tests createPerPositionBotState, attachMultiPosDeps,
 * updatePositionState, getAllPositionBotStates, and createPositionRoutes.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  createPerPositionBotState,
  attachMultiPosDeps,
  updatePositionState,
  getAllPositionBotStates,
  createPositionRoutes,
} = require("../src/server-positions");

// Valid EIP-55 checksummed addresses for composite key tests.
const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const CONTRACT = "0xCC05BF51E2B8f0A457E8F15FD5E8e25F34f8b279";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRes() {
  return { _status: null, _body: null };
}

function makeDiskConfig(overrides = {}) {
  return {
    global: {},
    positions: {},
    ...overrides,
  };
}

function makePositionMgr(overrides = {}) {
  return {
    runningCount: () => 0,
    count: () => 0,
    stopAll: async () => {},
    startPosition: async () => {},
    removePosition: async () => {},
    get: () => null,
    getAll: () => [],
    migrateKey: () => {},
    getRebalanceLock: () => ({ acquire: async () => () => {} }),
    getScanLock: () => ({ acquire: async () => () => {} }),
    poolKey: () => "pool",
    canRebalancePool: () => true,
    recordPoolRebalance: () => {},
    ...overrides,
  };
}

function makeRouteDeps(overrides = {}) {
  return {
    diskConfig: makeDiskConfig(),
    positionMgr: makePositionMgr(),
    walletManager: {
      getAddress: () => "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE",
      getStatus: () => ({
        loaded: true,
        address: "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE",
      }),
    },
    getPrivateKey: () => "0xpk123",
    jsonResponse: (res, status, body) => {
      res._status = status;
      res._body = body;
    },
    readJsonBody: async () => ({}),
    ...overrides,
  };
}

// ── createPerPositionBotState ───────────────────────────────────────────────

describe("createPerPositionBotState", () => {
  it("returns default state without saved config", () => {
    const state = createPerPositionBotState({});
    assert.strictEqual(state.running, false);
    assert.strictEqual(state.startedAt, null);
    assert.strictEqual(state.activePosition, null);
    assert.strictEqual(state.rebalanceCount, 0);
    assert.strictEqual(state.lastRebalanceAt, null);
    assert.strictEqual(state.rebalanceError, null);
    assert.strictEqual(state.rebalancePaused, false);
    assert.strictEqual(state.rebalanceScanComplete, false);
    assert.strictEqual(state.rebalanceScanProgress, 0);
  });

  it("pnlEpochs not restored from config (uses epoch-cache)", () => {
    const saved = { pnlEpochs: [{ epoch: 1 }] };
    const state = createPerPositionBotState({}, saved);
    assert.strictEqual(state.pnlEpochs, undefined);
  });

  it("restores hodlBaseline from saved config", () => {
    const saved = { hodlBaseline: { amount0: "10" } };
    const state = createPerPositionBotState({}, saved);
    assert.deepStrictEqual(state.hodlBaseline, { amount0: "10" });
  });

  it("restores residuals from saved config", () => {
    const saved = { residuals: { token0: 5 } };
    const state = createPerPositionBotState({}, saved);
    assert.deepStrictEqual(state.residuals, { token0: 5 });
  });

  it("restores collectedFeesUsd from saved config", () => {
    const saved = { collectedFeesUsd: 42.5 };
    const state = createPerPositionBotState({}, saved);
    assert.strictEqual(state.collectedFeesUsd, 42.5);
  });

  it("ignores unknown saved config fields", () => {
    const saved = { unknownField: "xyz" };
    const state = createPerPositionBotState({}, saved);
    assert.ok(!("unknownField" in state));
  });
});

// ── attachMultiPosDeps ──────────────────────────────────────────────────────

describe("attachMultiPosDeps", () => {
  it("attaches lock and pool functions to botState", () => {
    const botState = {};
    const lock = { acquire: async () => () => {} };
    const scanLock = { acquire: async () => () => {} };
    const mgr = makePositionMgr({
      getRebalanceLock: () => lock,
      getScanLock: () => scanLock,
      poolKey: () => "pk",
      canRebalancePool: () => false,
      recordPoolRebalance: () => {},
    });
    attachMultiPosDeps(botState, mgr);
    assert.strictEqual(botState._rebalanceLock, lock);
    assert.strictEqual(botState._scanLock, scanLock);
    assert.strictEqual(botState._poolKey(), "pk");
    assert.strictEqual(botState._canRebalancePool(), false);
    assert.strictEqual(typeof botState._recordPoolRebalance, "function");
  });
});

// ── updatePositionState ─────────────────────────────────────────────────────

describe("updatePositionState", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-state-"));

  it("creates state entry if not exists and applies patch", () => {
    const key = "pulsechain-0xW-0xC-999";
    const keyRef = { current: key };
    const diskConfig = makeDiskConfig();
    const mgr = makePositionMgr();

    // Clear state from prior tests
    getAllPositionBotStates().delete(key);

    updatePositionState(keyRef, { running: true }, diskConfig, mgr, _tmpDir);
    const state = getAllPositionBotStates().get(key);
    assert.ok(state);
    assert.strictEqual(state.running, true);
    assert.ok(state.updatedAt);

    // Cleanup
    getAllPositionBotStates().delete(key);
  });

  it("pnlEpochs written to epoch-cache, not diskConfig", () => {
    const key = "pulsechain-0xW-0xC-500";
    const keyRef = { current: key };
    const diskConfig = makeDiskConfig();
    const mgr = makePositionMgr();
    getAllPositionBotStates().delete(key);
    updatePositionState(
      keyRef,
      { pnlEpochs: [{ day: "2026-01-01" }] },
      diskConfig,
      mgr,
      _tmpDir,
    );
    assert.strictEqual(
      diskConfig.positions[key]?.pnlEpochs,
      undefined,
      "pnlEpochs should not be in diskConfig",
    );
    getAllPositionBotStates().delete(key);
  });

  it("persists hodlBaseline to disk config", () => {
    const key = "pulsechain-0xW-0xC-501";
    const keyRef = { current: key };
    const diskConfig = makeDiskConfig();
    const mgr = makePositionMgr();
    getAllPositionBotStates().delete(key);

    updatePositionState(
      keyRef,
      { hodlBaseline: { amount0: "100", amount1: "200" } },
      diskConfig,
      mgr,
      _tmpDir,
    );
    assert.deepStrictEqual(diskConfig.positions[key].hodlBaseline, {
      amount0: "100",
      amount1: "200",
    });

    getAllPositionBotStates().delete(key);
  });

  it("persists collectedFeesUsd to disk config", () => {
    const key = "pulsechain-0xW-0xC-502";
    const keyRef = { current: key };
    const diskConfig = makeDiskConfig();
    const mgr = makePositionMgr();
    getAllPositionBotStates().delete(key);

    updatePositionState(
      keyRef,
      { collectedFeesUsd: 55.5 },
      diskConfig,
      mgr,
      _tmpDir,
    );
    assert.strictEqual(diskConfig.positions[key].collectedFeesUsd, 55.5);

    getAllPositionBotStates().delete(key);
  });

  it("migrates key when activePositionId differs from tokenId", () => {
    const key = `pulsechain-${WALLET}-${CONTRACT}-100`;
    const keyRef = { current: key };
    const diskConfig = makeDiskConfig({
      positions: { [key]: { status: "running" } },
    });
    let migratedFrom = null;
    let migratedTo = null;
    const mgr = makePositionMgr({
      migrateKey: (from, to) => {
        migratedFrom = from;
        migratedTo = to;
      },
    });
    getAllPositionBotStates().delete(key);

    updatePositionState(
      keyRef,
      { activePositionId: "200" },
      diskConfig,
      mgr,
      _tmpDir,
    );

    const newKey = `pulsechain-${WALLET}-${CONTRACT}-200`;
    assert.strictEqual(keyRef.current, newKey);
    assert.strictEqual(migratedFrom, key);
    assert.strictEqual(migratedTo, newKey);
    assert.ok(getAllPositionBotStates().has(newKey));
    assert.ok(!getAllPositionBotStates().has(key));

    getAllPositionBotStates().delete(newKey);
  });

  it("does not migrate when activePositionId matches current tokenId", () => {
    const key = `pulsechain-${WALLET}-${CONTRACT}-300`;
    const keyRef = { current: key };
    const diskConfig = makeDiskConfig();
    const mgr = makePositionMgr();
    getAllPositionBotStates().delete(key);

    updatePositionState(
      keyRef,
      { activePositionId: "300" },
      diskConfig,
      mgr,
      _tmpDir,
    );

    assert.strictEqual(keyRef.current, key);

    getAllPositionBotStates().delete(key);
  });
});

// ── getAllPositionBotStates ──────────────────────────────────────────────────

describe("getAllPositionBotStates", () => {
  it("returns a Map instance", () => {
    const result = getAllPositionBotStates();
    assert.ok(result instanceof Map);
  });
});

// ── createPositionRoutes ────────────────────────────────────────────────────

describe("createPositionRoutes", () => {
  it("returns all expected route handlers", () => {
    const routes = createPositionRoutes(makeRouteDeps());
    const expected = [
      "POST /api/position/manage",
      "DELETE /api/position/manage",
      "GET /api/positions/managed",
    ];
    for (const key of expected) {
      assert.strictEqual(
        typeof routes[key],
        "function",
        `Expected route handler for ${key}`,
      );
    }
  });

  // ── handleManage ────────────────────────────────────────────────────────

  describe("handleManage", () => {
    it("returns 400 for missing tokenId", async () => {
      const deps = makeRouteDeps({
        readJsonBody: async () => ({}),
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      await routes["POST /api/position/manage"]({}, res);
      assert.strictEqual(res._status, 400);
      assert.ok(res._body.error.includes("tokenId"));
    });

    it("returns 400 for non-numeric tokenId", async () => {
      const deps = makeRouteDeps({
        readJsonBody: async () => ({ tokenId: "abc" }),
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      await routes["POST /api/position/manage"]({}, res);
      assert.strictEqual(res._status, 400);
      assert.ok(res._body.error.includes("numeric"));
    });

    it("returns 400 when no wallet loaded", async () => {
      const deps = makeRouteDeps({
        readJsonBody: async () => ({ tokenId: "123" }),
        walletManager: { getAddress: () => null },
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      await routes["POST /api/position/manage"]({}, res);
      assert.strictEqual(res._status, 400);
      assert.ok(res._body.error.includes("wallet"));
    });

    it("returns 400 when no private key available", async () => {
      const deps = makeRouteDeps({
        readJsonBody: async () => ({ tokenId: "123" }),
        getPrivateKey: () => null,
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      await routes["POST /api/position/manage"]({}, res);
      assert.strictEqual(res._status, 400);
      assert.ok(res._body.error.includes("private key"));
    });

    it("starts a new position successfully", async () => {
      let startedKey = null;
      const dc = makeDiskConfig();
      const deps = makeRouteDeps({
        diskConfig: dc,
        readJsonBody: async () => ({ tokenId: "42" }),
        positionMgr: makePositionMgr({
          get: () => null,
          startPosition: async (key) => {
            startedKey = key;
          },
          count: () => 1,
        }),
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      await routes["POST /api/position/manage"]({}, res);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(res._body.ok, true);
      assert.strictEqual(res._body.tokenId, "42");
      assert.ok(startedKey);

      // Status persisted so auto-start works on restart
      assert.strictEqual(dc.positions[startedKey].status, "running");

      // Cleanup
      getAllPositionBotStates().delete(startedKey);
    });

    it("returns alreadyRunning for duplicate position", async () => {
      const deps = makeRouteDeps({
        readJsonBody: async () => ({ tokenId: "42" }),
        positionMgr: makePositionMgr({
          get: () => ({ status: "running" }),
        }),
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      await routes["POST /api/position/manage"]({}, res);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(res._body.alreadyRunning, true);
    });
  });

  // ── handleRemove ────────────────────────────────────────────────────────

  describe("handleRemove", () => {
    it("returns 400 for missing key", async () => {
      const deps = makeRouteDeps({
        readJsonBody: async () => ({}),
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      await routes["DELETE /api/position/manage"]({}, res);
      assert.strictEqual(res._status, 400);
    });

    it("removes a position", async () => {
      let removedKey = null;
      const deps = makeRouteDeps({
        readJsonBody: async () => ({ key: "rm-key" }),
        positionMgr: makePositionMgr({
          removePosition: async (k) => {
            removedKey = k;
          },
          count: () => 0,
        }),
      });
      // Pre-populate bot state so delete can clean it up
      getAllPositionBotStates().set("rm-key", { running: false });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      await routes["DELETE /api/position/manage"]({}, res);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(res._body.status, "stopped");
      assert.strictEqual(removedKey, "rm-key");
      assert.ok(!getAllPositionBotStates().has("rm-key"));
    });
  });

  // ── handleManagedList ───────────────────────────────────────────────────

  describe("handleManagedList", () => {
    it("returns list with bot state attached", () => {
      const testKey = "list-test-key";
      getAllPositionBotStates().set(testKey, {
        activePosition: { tokenId: "5" },
        running: true,
      });
      const deps = makeRouteDeps({
        positionMgr: makePositionMgr({
          getAll: () => [{ key: testKey, status: "running" }],
        }),
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      routes["GET /api/positions/managed"]({}, res);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(res._body.ok, true);
      assert.strictEqual(res._body.positions.length, 1);
      assert.strictEqual(res._body.positions[0].running, true);
      assert.deepStrictEqual(res._body.positions[0].activePosition, {
        tokenId: "5",
      });

      getAllPositionBotStates().delete(testKey);
    });

    it("returns positions without bot state gracefully", () => {
      const deps = makeRouteDeps({
        positionMgr: makePositionMgr({
          getAll: () => [{ key: "no-state", status: "paused" }],
        }),
      });
      const routes = createPositionRoutes(deps);
      const res = makeRes();
      routes["GET /api/positions/managed"]({}, res);
      assert.strictEqual(res._body.positions.length, 1);
      assert.ok(!("running" in res._body.positions[0]));
    });
  });
});
