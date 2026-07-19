/**
 * @file test/server-reload-position.test.js
 * @description Tests for the POST /api/position/reload handler.
 * Covers the on-chain-derived-keys clear-list invariant and the
 * in-progress guard that rejects reloads racing an in-flight
 * rebalance or compound on the SAME position.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  createReloadPositionHandler,
  _ON_CHAIN_DERIVED_KEYS,
  _resetBotState,
} = require("../src/server-reload-position");

/*- Every test that hits `loadConfig`/`saveConfig` (bot-config-v2) needs
 *  the config file to live in a tmp dir so real user state is never
 *  touched.  We override the module-level path via require.cache tricks.
 *  In practice bot-config-v2 reads a fixed path; for these tests we
 *  focus on paths that don't hit the config file directly. */

// ── Utilities ───────────────────────────────────────────────────────

function _mockPosition() {
  return {
    tokenId: "161973",
    token0: "0x0000000000000000000000000000000000000A11",
    token1: "0x0000000000000000000000000000000000000A12",
    fee: 10000,
  };
}

function _mockKey() {
  return (
    "pulsechain-" +
    "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A-" +
    "0xCC05bf10CE7b70C3F72D6D5A4d3f1c7a1d0000e0-" +
    "161973"
  );
}

/*- Minimal positionMgr shape needed by both the handler AND
 *  resolveLiveKey.  `get(key)` is the fast-path used by resolveLiveKey;
 *  `getPosition(key)` is our own fallback when the bot state is
 *  absent.  Both return the mock position so the handler always
 *  resolves to a valid pool identity in tests. */
function _mockPositionMgr(overrides) {
  return {
    get: () => ({ key: _mockKey() }),
    getPosition: () => _mockPosition(),
    getAll: () => [],
    ...overrides,
  };
}

function _mockDeps(overrides) {
  const responses = [];
  const deps = {
    jsonResponse: (_res, code, body) => responses.push({ code, body }),
    readJsonBody: async () => overrides?.body || { positionKey: _mockKey() },
    getAllPositionBotStates: () => overrides?.states || new Map(),
    positionMgr: overrides?.positionMgr || _mockPositionMgr(),
    walletManager: {
      getAddress: () => "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
    },
    /*- Shared in-memory disk config — the handler mutates it in place
     *  so the bot loop's `readConfigValue` sees the clears immediately.
     *  Overridable so tests can seed / assert against the object. */
    diskConfig: overrides?.diskConfig || { global: {}, positions: {} },
  };
  return { deps, responses };
}

// ── Handler shape ───────────────────────────────────────────────────

describe("createReloadPositionHandler", () => {
  it("returns a function", () => {
    const { deps } = _mockDeps();
    const h = createReloadPositionHandler(deps);
    assert.strictEqual(typeof h, "function");
  });
});

// ── Bad-request paths ───────────────────────────────────────────────

describe("POST /api/position/reload — validation", () => {
  it("rejects missing positionKey with 400", async () => {
    const { deps, responses } = _mockDeps({ body: {} });
    const h = createReloadPositionHandler(deps);
    await h({}, {});
    assert.strictEqual(responses[0].code, 400);
    assert.strictEqual(responses[0].body.ok, false);
    assert.match(responses[0].body.error, /positionKey/);
  });

  it("rejects invalid positionKey format with 400", async () => {
    const { deps, responses } = _mockDeps({
      body: { positionKey: "not-a-composite-key" },
    });
    const h = createReloadPositionHandler(deps);
    await h({}, {});
    assert.strictEqual(responses[0].code, 400);
  });
});

// ── In-progress guard (409) ─────────────────────────────────────────

describe("POST /api/position/reload — in-progress guard", () => {
  it("returns 409 scan-in-progress when state._scanRunning", async () => {
    const key = _mockKey();
    const state = {
      activePosition: _mockPosition(),
      _scanRunning: true,
    };
    const states = new Map([[key, state]]);
    const { deps, responses } = _mockDeps({ states });
    const h = createReloadPositionHandler(deps);
    await h({}, {});
    assert.strictEqual(responses[0].code, 409);
    assert.strictEqual(responses[0].body.error, "scan-in-progress");
    assert.match(responses[0].body.message, /already running/);
  });

  it("returns 409 rebalance-in-progress when state.rebalanceInProgress", async () => {
    const key = _mockKey();
    const state = {
      activePosition: _mockPosition(),
      rebalanceInProgress: true,
    };
    const states = new Map([[key, state]]);
    const { deps, responses } = _mockDeps({ states });
    const h = createReloadPositionHandler(deps);
    await h({}, {});
    assert.strictEqual(responses[0].code, 409);
    assert.strictEqual(responses[0].body.error, "rebalance-in-progress");
    assert.match(responses[0].body.message, /currently rebalancing/);
  });

  it("returns 409 compound-in-progress when state.compoundInProgress", async () => {
    const key = _mockKey();
    const state = {
      activePosition: _mockPosition(),
      compoundInProgress: true,
    };
    const states = new Map([[key, state]]);
    const { deps, responses } = _mockDeps({ states });
    const h = createReloadPositionHandler(deps);
    await h({}, {});
    assert.strictEqual(responses[0].code, 409);
    assert.strictEqual(responses[0].body.error, "compound-in-progress");
    assert.match(responses[0].body.message, /currently compounding/);
  });
});

// ── Clear-list invariant ────────────────────────────────────────────

describe("_ON_CHAIN_DERIVED_KEYS", () => {
  it("covers every on-chain-derived key documented in engineering.md", () => {
    /*- The clear-list is the invariant the reload flow depends on:
     *  every value that could survive a reload and re-corrupt the
     *  fresh scan must be here.  Guarded so future additions to the
     *  disk config get a matching test-failure. */
    const expected = [
      "compoundHistory",
      "totalCompoundedUsd",
      "collectedFeesUsd",
      "nftCompoundedUsdByTokenId",
      "nftGasWeiByTokenId",
      "hodlBaseline",
      "lifetimeHodlAmounts",
      "totalLifetimeDepositUsd",
    ];
    assert.deepStrictEqual([..._ON_CHAIN_DERIVED_KEYS].sort(), expected.sort());
  });
});

// ── _resetBotState ──────────────────────────────────────────────────

describe("_resetBotState", () => {
  it("clears every on-chain-derived field and stamps _needsFullRescan", () => {
    const state = {
      _catastrophicScanError: { message: "boom" },
      _lifetimeScanError: "prior err",
      _lifetimeScanErrorAt: 12345,
      _needsFullRescan: false,
      lifetimeScanComplete: true,
      rebalanceScanComplete: true,
      totalLifetimeDepositUsd: 999.99,
      compoundHistory: [{ tokenId: "1" }],
      totalCompoundedUsd: 100,
      collectedFeesUsd: 50,
      nftCompoundedUsdByTokenId: { 1: 42 },
      nftGasWeiByTokenId: { 1: "abc" },
      hodlBaseline: { mintDate: "2026-01-01" },
      lifetimeHodlAmounts: { amount0: 1, amount1: 2 },
      /*- Fields that should NOT be touched (settings, not on-chain-derived). */
      slippagePctToken0: 0.75,
      autoCompoundEnabled: true,
    };
    _resetBotState(state);
    assert.strictEqual(state._catastrophicScanError, null);
    assert.strictEqual(state._lifetimeScanError, null);
    assert.strictEqual(state._lifetimeScanErrorAt, null);
    assert.strictEqual(state._needsFullRescan, true);
    assert.strictEqual(state.lifetimeScanComplete, false);
    assert.strictEqual(state.rebalanceScanComplete, false);
    assert.strictEqual(state.totalLifetimeDepositUsd, 0);
    assert.deepStrictEqual(state.compoundHistory, []);
    assert.strictEqual(state.totalCompoundedUsd, 0);
    assert.strictEqual(state.collectedFeesUsd, 0);
    assert.deepStrictEqual(state.nftCompoundedUsdByTokenId, {});
    assert.deepStrictEqual(state.nftGasWeiByTokenId, {});
    assert.strictEqual(state.hodlBaseline, null);
    assert.strictEqual(state.lifetimeHodlAmounts, null);
    /*- Settings preserved. */
    assert.strictEqual(state.slippagePctToken0, 0.75);
    assert.strictEqual(state.autoCompoundEnabled, true);
  });
});

// Guard tmp-dir cleanup — swallow any leftover fixtures.
process.on("exit", () => {
  try {
    const base = path.join(os.tmpdir(), "lp-ranger-reload-");
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith("lp-ranger-reload-")) {
        fs.rmSync(path.join(os.tmpdir(), name), {
          recursive: true,
          force: true,
        });
      }
    }
    void base;
  } catch {
    /* ignore */
  }
});
