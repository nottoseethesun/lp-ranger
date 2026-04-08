/**
 * @file test/server-routes-extra.test.js
 * @description Additional coverage for server-routes.js: getPositionScanStatus,
 *   _handleApiConfig edge cases, _handlePositionLifetime trigger-scan path,
 *   and _autoStartManagedPositions with no managed keys.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createRouteHandlers } = require("../src/server-routes");

/** Build a minimal deps object with stubs. */
function makeDeps(overrides = {}) {
  const posStates = new Map();
  return {
    diskConfig: {
      global: {},
      positions: {},
    },
    positionMgr: {
      runningCount: () => 0,
      count: () => 0,
      stopAll: async () => {},
      startPosition: async () => {},
      get: () => null,
      getAll: () => [],
      migrateKey: () => {},
      getRebalanceLock: () => ({}),
      getScanLock: () => ({}),
      poolKey: () => "",
      canRebalancePool: () => true,
      recordPoolRebalance: () => {},
    },
    privateKeyRef: { current: "0xabc123" },
    walletManager: {
      getStatus: () => ({ loaded: true, address: "0x1234" }),
      getAddress: () => "0x1234",
      importWallet: async () => {},
      revealWallet: async (pw) => ({
        privateKey: "0xpk_" + pw,
        mnemonic: "test seed",
      }),
      hasWallet: () => true,
    },
    jsonResponse: (_res, status, body) => {
      _res._status = status;
      _res._body = body;
    },
    readJsonBody: async () => ({}),
    getAllPositionBotStates: () => posStates,
    createPerPositionBotState: () => ({ running: false }),
    attachMultiPosDeps: () => {},
    updatePositionState: () => {},
    ...overrides,
  };
}

function makeRes() {
  return { _status: null, _body: null };
}

// ── getPositionScanStatus ───────────────────────────────────────────

describe("getPositionScanStatus", () => {
  it("returns idle status initially", () => {
    const h = createRouteHandlers(makeDeps());
    const s = h.getPositionScanStatus();
    assert.strictEqual(s.status, "idle");
    assert.strictEqual(s.progress, null);
  });
});

// ── _handleApiConfig — global-only keys ─────────────────────────────

describe("_handleApiConfig — global-only", () => {
  it("applies multiple global keys without positionKey", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({
        triggerType: "timeout",
        rpcUrl: "http://custom",
      }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied.triggerType, "timeout");
    assert.strictEqual(res._body.applied.rpcUrl, "http://custom");
    assert.strictEqual(deps.diskConfig.global.triggerType, "timeout");
    assert.strictEqual(deps.diskConfig.global.rpcUrl, "http://custom");
  });
});

// ── _handleApiConfig — status preservation warning ──────────────────

describe("_handleApiConfig — status field handling", () => {
  it("preserves status when position keys do not include it", async () => {
    const pk = "pulsechain-0xA-0xB-42";
    const deps = makeDeps({
      readJsonBody: async () => ({
        positionKey: pk,
        slippagePct: 1.0,
      }),
    });
    deps.diskConfig.positions[pk] = { status: "running" };
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(deps.diskConfig.positions[pk].status, "running");
  });
});

// ── _handlePositionLifetime — triggers scan for matching position ───

describe("_handlePositionLifetime — trigger scan", () => {
  it("calls _triggerScan on matching active position", async () => {
    let triggered = false;
    const posStates = new Map();
    posStates.set("pk1", {
      activePosition: { tokenId: "555" },
      _triggerScan: () => {
        triggered = true;
      },
    });
    const deps = makeDeps({
      readJsonBody: async () => ({
        tokenId: "555",
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
        walletAddress: "0xW",
        contractAddress: "0xC",
      }),
      getAllPositionBotStates: () => posStates,
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    // This will hit 500 because computeLifetimeDetails needs RPC,
    // but the trigger scan happens before the RPC call
    await h._handlePositionLifetime({}, res);
    assert.ok(triggered, "_triggerScan should be called");
    assert.strictEqual(res._status, 500);
  });

  it("does not trigger scan when tokenId does not match", async () => {
    let triggered = false;
    const posStates = new Map();
    posStates.set("pk1", {
      activePosition: { tokenId: "999" },
      _triggerScan: () => {
        triggered = true;
      },
    });
    const deps = makeDeps({
      readJsonBody: async () => ({
        tokenId: "123",
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
      }),
      getAllPositionBotStates: () => posStates,
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handlePositionLifetime({}, res);
    assert.ok(!triggered);
  });
});

// ── _handlePositionDetails — 500 on RPC failure ─────────────────────

describe("_handlePositionDetails — RPC error path", () => {
  it("returns 500 when computeQuickDetails throws", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({
        tokenId: "1",
        token0: "0xA",
        token1: "0xB",
        fee: 3000,
        tickLower: -100,
        tickUpper: 100,
      }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    // computeQuickDetails will fail due to no real RPC
    await h._handlePositionDetails({}, res);
    assert.strictEqual(res._status, 500);
    assert.strictEqual(res._body.ok, false);
    assert.ok(res._body.error.length > 0);
  });
});

// ── _handleWalletReveal — response shape ────────────────────────────

describe("_handleWalletReveal — no mnemonic", () => {
  it("sets hasMnemonic to false when mnemonic is null", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({ password: "pw" }),
      walletManager: {
        revealWallet: async () => ({
          privateKey: "0xpk",
          mnemonic: null,
        }),
        getAddress: () => "0xAddr",
        getStatus: () => ({ source: "key" }),
      },
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleWalletReveal({}, res);
    assert.strictEqual(res._body.hasMnemonic, false);
    assert.strictEqual(res._body.source, "key");
  });
});

// ── _handlePositionsScan — refresh delegates to scan handlers ───────

describe("_handlePositionsRefresh via route handlers", () => {
  it("returns 400 when wallet not loaded", async () => {
    const deps = makeDeps({
      walletManager: {
        ...makeDeps().walletManager,
        getStatus: () => ({ loaded: false }),
      },
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handlePositionsRefresh({}, res);
    assert.strictEqual(res._status, 400);
  });
});
