/**
 * @file test/handle-manage-pool-state-err.test.js
 * @description Coverage for `handleManage`'s Pool*Error → 503
 *   mapping.  Extracted from `test/server-positions.test.js` so that
 *   parent file stays under the 500-line cap.  Helpers are
 *   intentionally duplicated (small footprint) rather than extracted
 *   to a shared module — keeps each test file self-contained and
 *   independently runnable.
 *
 *   Covers:
 *     - PoolStateUnavailableError (the orchestrator-wrapped case) →
 *       503 + `error: "pool-info-unavailable"` + full err.message
 *       surfaced in body.message; no leaked state on disk or in
 *       _positionBotStates
 *     - PoolStateInvalidError thrown directly (without orchestrator
 *       wrap) → same 503 mapping; discriminator is the error TYPE
 *       not whether it was wrapped
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  createPositionRoutes,
  getAllPositionBotStates,
} = require("../src/server-positions");
const {
  PoolStateInvalidError,
  PoolStateUnavailableError,
} = require("../src/pool-state-validate");

// ── Minimal helpers (mirrors test/server-positions.test.js) ─────────────────

function makeRes() {
  return { _status: null, _body: null };
}
function makeDiskConfig(overrides = {}) {
  return { global: {}, positions: {}, ...overrides };
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
    getSharedSigner: async () => ({
      provider: {},
      signer: { getAddress: async () => "0xAA" },
      address: "0xAA",
    }),
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("handleManage Pool*Error mapping", () => {
  it("maps PoolStateUnavailableError to 503 + pool-info-unavailable, cleans state", async () => {
    /*- When startLoop throws a Pool*Error (raised by
     *  `_tryInitPnlTracker` after `getPoolState`'s retry chain
     *  exhausted both RPCs), the handler must:
     *    - return 503 (not generic 500)
     *    - body.error === "pool-info-unavailable" (dashboard's branch
     *      key for the warning modal)
     *    - body.message === underlying err.message (verbatim in the
     *      modal's scrollable code block)
     *    - leave no `status: 'running'` entry on disk
     *    - leave no in-memory bot-state for that key */
    const inner = new PoolStateInvalidError(
      "decimals0",
      undefined,
      "http://rpc.test",
    );
    const dc = makeDiskConfig();
    const deps = makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({ tokenId: "158970" }),
      positionMgr: makePositionMgr({
        get: () => null,
        startPosition: async () => {
          throw new PoolStateUnavailableError(4, inner);
        },
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);

    assert.strictEqual(res._status, 503, "expected 503 for Pool*Error");
    assert.strictEqual(res._body.error, "pool-info-unavailable");
    assert.match(res._body.message, /exhausted 4 RPC attempt/);
    assert.match(res._body.message, /decimals0/);
    assert.strictEqual(res._body.tokenId, "158970");

    // No phantom entry on disk.
    const runningKeys = Object.keys(dc.positions).filter(
      (k) => dc.positions[k].status === "running",
    );
    assert.deepStrictEqual(runningKeys, []);
    // No phantom in-memory state.
    const inMem = [...getAllPositionBotStates().keys()].filter((k) =>
      k.endsWith("-158970"),
    );
    assert.deepStrictEqual(inMem, []);
  });

  it("maps PoolStateInvalidError directly (no wrap) to 503", async () => {
    /*- A Pool*Error thrown directly (without the orchestrator wrap)
     *  should still trigger the 503 path — handler discriminates on
     *  the error TYPE, not on whether it was wrapped. */
    const dc = makeDiskConfig();
    const deps = makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({ tokenId: "999" }),
      positionMgr: makePositionMgr({
        get: () => null,
        startPosition: async () => {
          throw new PoolStateInvalidError("tick", null, "http://x");
        },
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 503);
    assert.strictEqual(res._body.error, "pool-info-unavailable");
  });
});
