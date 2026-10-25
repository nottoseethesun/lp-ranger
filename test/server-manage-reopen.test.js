/**
 * @file test/server-manage-reopen.test.js
 * @description The Manage route's re-open path in src/lib/server-positions.js
 *   (`POST /api/position/manage` with `forceRebalance: true`): the flag a
 *   re-open stamps on the position's bot state before its first poll, the
 *   retry on a position already running, and that retry refused while a
 *   scan is running on the position (src/lib/scan-state.js). Split from
 *   test/server-can-reopen.test.js at the line cap.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  createPositionRoutes,
  getAllPositionBotStates,
} = require("../src/lib/server-positions");
const { compositeKey } = require("../src/lib/bot-config-v2");
const config = require("../src/lib/config");
const { poolReadStandIn } = require("./helpers/pool-read-stand-in");
const { makeRes } = require("./helpers/route-handler-deps");

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";

/*- Minimal helpers mirroring test/server-positions.test.js so this file
 *  stays self-contained without depending on extracting them upstream. */
function _makeDiskConfig(overrides = {}) {
  return { global: {}, positions: {}, ...overrides };
}
function _makePositionMgr(overrides = {}) {
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
function _makeRouteDeps(overrides = {}) {
  return {
    diskConfig: _makeDiskConfig(),
    positionMgr: _makePositionMgr(),
    walletManager: {
      getAddress: () => WALLET,
      getStatus: () => ({ loaded: true, address: WALLET }),
    },
    getPrivateKey: () => "0xpk123",
    jsonResponse: (res, status, body) => {
      res._status = status;
      res._body = body;
    },
    readJsonBody: async () => ({}),
    ...poolReadStandIn(),
    ...overrides,
  };
}

describe("handleManage re-open flag propagation", () => {
  it("stamps forceRebalance on posBotState BEFORE startPosition fires (re-open path)", async () => {
    /*- When the dashboard re-opens a closed position via Manage, it
     *  POSTs `{ forceRebalance: true }` alongside `tokenId`.  Server
     *  must apply the flag to the freshly-built posBotState BEFORE
     *  `startPosition` runs the bot loop's first poll — otherwise
     *  `bot-cycle-drain.js`'s drain guard would re-arm the 30-min
     *  retire timer instead of letting the rebalance pipeline run on
     *  the drained NFT.
     *
     *  As of the "Migrate Rebalance UI dialog into Bot Settings" plan,
     *  the range-width override is a persistent per-position config
     *  key (`rebalanceRangeWidthPct` POSITION_KEY) — no longer sent in
     *  the request body and no longer stamped on state.  Even if a
     *  stale caller sends `customRangeWidthPct` in the body, this
     *  test asserts state stays clean of it. */
    let stateAtStartPosition = null;
    const dc = _makeDiskConfig();
    const deps = _makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({
        tokenId: "158970",
        forceRebalance: true,
        /*- Stale field a legacy client might still send; MUST NOT
         *  leak onto state. */
        customRangeWidthPct: 7.5,
      }),
      positionMgr: _makePositionMgr({
        get: () => null,
        startPosition: async (key) => {
          stateAtStartPosition = {
            ...getAllPositionBotStates().get(key),
          };
        },
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 200);
    assert.ok(stateAtStartPosition, "startPosition should have been called");
    assert.strictEqual(
      stateAtStartPosition.forceRebalance,
      true,
      "forceRebalance must be on posBotState at startPosition call time",
    );
    assert.strictEqual(
      stateAtStartPosition.customRangeWidthPct,
      undefined,
      "customRangeWidthPct must NOT leak from body onto state — read from config now",
    );

    const key = Object.keys(dc.positions).find((k) => k.endsWith("-158970"));
    if (key) getAllPositionBotStates().delete(key);
  });

  it("does NOT stamp forceRebalance for a normal Manage (healthy position) call", async () => {
    /*- Healthy unmanaged position → user clicks Manage normally → no
     *  forceRebalance in the body → posBotState comes up clean. */
    let stateAtStartPosition = null;
    const dc = _makeDiskConfig();
    const deps = _makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({ tokenId: "42" }),
      positionMgr: _makePositionMgr({
        get: () => null,
        startPosition: async (key) => {
          stateAtStartPosition = {
            ...getAllPositionBotStates().get(key),
          };
        },
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(
      stateAtStartPosition.forceRebalance,
      undefined,
      "forceRebalance should remain unset on normal Manage",
    );
    assert.strictEqual(
      stateAtStartPosition.customRangeWidthPct,
      undefined,
      "customRangeWidthPct should remain unset on normal Manage",
    );
    const key = Object.keys(dc.positions).find((k) => k.endsWith("-42"));
    if (key) getAllPositionBotStates().delete(key);
  });

  it("stamps forceRebalance + clears paused state on already-running position (retry path)", async () => {
    /*- User clicks Manage on a closed-but-running position to retry
     *  after the previous re-open's swap aborted on slippage.
     *  handleManage's "already running — skipping" short-circuit must
     *  route through `_stampReopenFlagsOnLive` so the flag is wired
     *  through to the live posBotState AND the paused/midway state
     *  cleared, otherwise the bot would keep returning early at the
     *  rebalancePaused gate in `_checkRebalanceGates` and the retry
     *  would never fire. */
    const dc = _makeDiskConfig();
    const liveKey = compositeKey(
      "pulsechain",
      WALLET,
      config.POSITION_MANAGER,
      "99999",
    );
    /*- Pre-populate _positionBotStates with a paused live state,
     *  including `_retireImmediately: true` (set by bot-loop.js's
     *  re-open-failure path).  All these flags must be cleared by
     *  `_stampReopenFlagsOnLive` so the retry can actually run on
     *  the next poll instead of being preempted by drain.js's
     *  immediate-retire branch. */
    const liveState = {
      rebalancePaused: true,
      rebalanceFailedMidway: true,
      rebalanceError: "Swap aborted: price impact 2.4% exceeds slippage 0.75%",
      _retireImmediately: true,
    };
    getAllPositionBotStates().set(liveKey, liveState);
    let startPositionCalled = false;
    const deps = _makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({
        tokenId: "99999",
        forceRebalance: true,
        /*- Stale legacy field: must not leak onto state.  Range width
         *  comes from the persistent `rebalanceRangeWidthPct`
         *  POSITION_KEY, read by `bot-cycle-opts.js` via
         *  `deps._getConfig`. */
        customRangeWidthPct: 12,
      }),
      positionMgr: _makePositionMgr({
        get: (k) => (k === liveKey ? { status: "running" } : null),
        startPosition: async () => {
          startPositionCalled = true;
        },
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(
      res._body.alreadyRunning,
      true,
      "should report alreadyRunning=true",
    );
    assert.strictEqual(
      res._body.reopenStamped,
      true,
      "should report reopenStamped=true",
    );
    assert.strictEqual(
      startPositionCalled,
      false,
      "must NOT start a second bot loop",
    );
    assert.strictEqual(liveState.forceRebalance, true);
    assert.strictEqual(
      liveState.customRangeWidthPct,
      undefined,
      "customRangeWidthPct must NOT leak from body onto live state",
    );
    assert.strictEqual(liveState.rebalancePaused, false);
    assert.strictEqual(liveState.rebalanceFailedMidway, false);
    assert.strictEqual(liveState.rebalanceError, null);
    /*- Regression: _retireImmediately must be cleared too.  If the
     *  prior re-open failure set it (bot-loop.js's `_handleError`),
     *  drain.js would fire retire on the next poll BEFORE the
     *  forceRebalance can take effect, silently losing the user's
     *  retry click. */
    assert.strictEqual(liveState._retireImmediately, false);
    getAllPositionBotStates().delete(liveKey);
  });

  it("refuses a re-open retried while a scan is running on the position", async () => {
    /*- The bot would make the rebalance during the scan, and leave it
     *  out of the figures the scan rebuilds (src/lib/scan-state.js), so the
     *  retry is refused as a Rebalance Now is, and nothing is stamped.
     *  A plain Manage of the same position is answered as before. */
    const dc = _makeDiskConfig();
    const liveKey = compositeKey(
      "pulsechain",
      WALLET,
      config.POSITION_MANAGER,
      "77777",
    );
    const liveState = { _scanRunning: true, rebalancePaused: true };
    getAllPositionBotStates().set(liveKey, liveState);
    const manage = async (body) => {
      const routes = createPositionRoutes(
        _makeRouteDeps({
          diskConfig: dc,
          readJsonBody: async () => body,
          positionMgr: _makePositionMgr({
            get: (k) => (k === liveKey ? { status: "running" } : null),
          }),
        }),
      );
      const res = makeRes();
      await routes["POST /api/position/manage"]({}, res);
      return res;
    };
    try {
      const res = await manage({ tokenId: "77777", forceRebalance: true });
      assert.strictEqual(res._status, 409);
      assert.strictEqual(res._body.ok, false);
      assert.strictEqual(res._body.positionKey, liveKey);
      assert.match(res._body.error, /history from the blockchain/);
      assert.match(res._body.error, /click Manage again/);
      assert.strictEqual(liveState.forceRebalance, undefined);
      assert.strictEqual(liveState.rebalancePaused, true);
      const plain = await manage({ tokenId: "77777" });
      assert.strictEqual(plain._status, 200);
      assert.strictEqual(plain._body.alreadyRunning, true);
    } finally {
      getAllPositionBotStates().delete(liveKey);
    }
  });

  it("does NOT stamp anything when forceRebalance is absent on already-running position", async () => {
    /*- Plain Manage click on an already-running position should still
     *  no-op (no flag carry-over from a stale request).  reopenStamped
     *  must be false. */
    const dc = _makeDiskConfig();
    const liveKey = compositeKey(
      "pulsechain",
      WALLET,
      config.POSITION_MANAGER,
      "88888",
    );
    const liveState = { rebalancePaused: false };
    getAllPositionBotStates().set(liveKey, liveState);
    const deps = _makeRouteDeps({
      diskConfig: dc,
      readJsonBody: async () => ({ tokenId: "88888" }),
      positionMgr: _makePositionMgr({
        get: (k) => (k === liveKey ? { status: "running" } : null),
      }),
    });
    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["POST /api/position/manage"]({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.alreadyRunning, true);
    assert.strictEqual(res._body.reopenStamped, false);
    assert.strictEqual(liveState.forceRebalance, undefined);
    getAllPositionBotStates().delete(liveKey);
  });
});
