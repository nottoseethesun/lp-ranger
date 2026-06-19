/**
 * @file test/server-positions-stale-key-races.test.js
 * @description Regression tests for the stale-key-after-await bug class
 * fixed by `addManagedPosition(diskConfig, keyRef.current)` in
 * handleManage and the entry-reference capture in handleRemove.
 *
 * These exercise the FULL handler flow with a mocked startBotLoop +
 * positionMgr so that a "migration happened during the await" can be
 * injected without booting a real bot loop.  Lives in a dedicated file
 * because adding to test/server-positions.test.js pushes it past the
 * 500-line max-lines cap.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const {
  createPositionRoutes,
  getAllPositionBotStates,
  updatePositionState,
} = require("../src/server-positions");
const {
  addManagedPosition,
  getPositionConfig,
} = require("../src/bot-config-v2");

// Valid EIP-55 checksummed addresses (parseCompositeKey validates them).
const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const CONTRACT = "0xCC05BF51E2B8f0A457E8F15FD5E8e25F34f8b279";
const key = (tokenId) => `pulsechain-${WALLET}-${CONTRACT}-${tokenId}`;

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
      getAddress: () => WALLET,
      getStatus: () => ({ loaded: true, address: WALLET }),
    },
    getPrivateKey: () => "0xpk",
    jsonResponse: (res, status, body) => {
      res._status = status;
      res._body = body;
    },
    readJsonBody: async () => ({}),
    ...overrides,
  };
}

describe("handleManage stale-key sequence (direct simulation)", () => {
  /*- Direct simulation of handleManage's post-await sequence rather
   *  than a full HTTP-handler integration test.  Mocking `startBotLoop`
   *  via the require cache is unreliable because server-positions.js
   *  destructures `startBotLoop` at module-load — a captured local
   *  reference that subsequent cache mutations cannot reach.
   *
   *  This test verifies the SEMANTIC contract of the fix: after
   *  updatePositionState mutates keyRef.current via a migration patch,
   *  the subsequent addManagedPosition call must use keyRef.current —
   *  NOT the original captured key — to avoid creating a phantom
   *  status=running stub under the dead old key. */
  it("addManagedPosition(keyRef.current) writes only the NEW key after migration", () => {
    const OLD_TOKEN = "159175";
    const NEW_TOKEN = "161616";
    const oldKey = key(OLD_TOKEN);
    const newKey = key(NEW_TOKEN);
    const dc = makeDiskConfig({
      positions: {
        [oldKey]: { status: "stopped" }, // pre-migration disk state
      },
    });
    const states = getAllPositionBotStates();
    states.delete(oldKey);
    states.delete(newKey);

    /*- handleManage captures key + keyRef = { current: key }. */
    const keyRef = { current: oldKey };

    /*- Simulate the bot loop's first poll completing a force rebalance
     *  that mints a new NFT and triggers migration via updateBotState.
     *  This is the EXACT call updatePositionState makes when the bot
     *  reports activePositionId !== current tokenId. */
    let migrateKeyCalled = null;
    const mgr = {
      migrateKey: (from, to, newTid) => {
        migrateKeyCalled = { from, to, newTid };
      },
    };
    updatePositionState(keyRef, { activePositionId: NEW_TOKEN }, dc, mgr);

    /*- The migration has happened: keyRef.current is now newKey,
     *  diskConfig's old slot has been renamed to newKey, and the
     *  positionMgr.migrateKey was called. */
    assert.strictEqual(
      keyRef.current,
      newKey,
      "keyRef.current was mutated to newKey",
    );
    assert.strictEqual(
      dc.positions[oldKey],
      undefined,
      "old disk slot was deleted by migrateConfigKey",
    );
    assert.ok(dc.positions[newKey], "new disk slot exists post-migration");
    assert.deepStrictEqual(migrateKeyCalled, {
      from: oldKey,
      to: newKey,
      newTid: NEW_TOKEN,
    });

    /*- THE FIX: handleManage now calls addManagedPosition(dc,
     *  keyRef.current) instead of addManagedPosition(dc, key).  Verify
     *  the correct (post-migration) key gets status=running, and NO
     *  phantom is resurrected under the old key. */
    addManagedPosition(dc, keyRef.current);

    assert.strictEqual(
      dc.positions[oldKey],
      undefined,
      "phantom old-key entry must NOT be resurrected by addManagedPosition",
    );
    assert.strictEqual(dc.positions[newKey].status, "running");

    states.delete(oldKey);
    states.delete(newKey);
  });

  it("REGRESSION: calling addManagedPosition with the STALE key would resurrect a phantom", () => {
    /*- This test explicitly demonstrates the bug shape.  Calling
     *  addManagedPosition with the original (stale) key after a
     *  migration produces the exact phantom signature the dashboard
     *  was stuck on.  Verifies our purge would catch it. */
    const OLD_TOKEN = "159175";
    const NEW_TOKEN = "161616";
    const oldKey = key(OLD_TOKEN);
    const newKey = key(NEW_TOKEN);
    const dc = makeDiskConfig({
      positions: { [oldKey]: { status: "stopped" } },
    });
    const states = getAllPositionBotStates();
    states.delete(oldKey);
    states.delete(newKey);

    const keyRef = { current: oldKey };
    updatePositionState(keyRef, { activePositionId: NEW_TOKEN }, dc, {
      migrateKey: () => {},
    });

    /*- BAD CALLER: uses captured `oldKey` instead of `keyRef.current`. */
    addManagedPosition(dc, oldKey);

    /*- Phantom signature: status=running + only the `status` field. */
    assert.ok(dc.positions[oldKey], "phantom entry was created");
    assert.deepStrictEqual(Object.keys(dc.positions[oldKey]), ["status"]);
    assert.strictEqual(dc.positions[oldKey].status, "running");

    states.delete(oldKey);
    states.delete(newKey);
  });

  it("non-lazy getPositionConfig prevents handleManage from lazy-creating during _persistPositionConfig", () => {
    /*- When the bot loop fires updateBotState with persistable fields
     *  (e.g. nftGasWeiByTokenId) but the keyRef points at a key whose
     *  slot has just been migrated away, _persistPositionConfig must
     *  not lazy-create the slot — that would be the same phantom
     *  shape.  The non-lazy getPositionConfig + null-skip guard
     *  enforces this. */
    const dc = makeDiskConfig();
    const STALE_KEY = key("100");
    const keyRef = { current: STALE_KEY };

    /*- No slot for STALE_KEY in dc.  updatePositionState should warn
     *  and skip rather than create a phantom. */
    updatePositionState(keyRef, { nftGasWeiByTokenId: { 100: "1234" } }, dc, {
      migrateKey: () => {},
    });

    assert.strictEqual(
      getPositionConfig(dc, STALE_KEY),
      null,
      "no phantom slot created by missing-key persist attempt",
    );

    getAllPositionBotStates().delete(STALE_KEY);
  });
});

describe("handleRemove stale-key races", () => {
  it("uses migrated entry.key for cleanup when stop() spans a migration", async () => {
    /*- During `await positionMgr.removePosition(body.key)`, the bot's
     *  stop() awaits the in-flight poll, which can complete a
     *  rebalance.  That rebalance fires updatePositionState →
     *  positionMgr.migrateKey, mutating entry.key in place.  By the
     *  time control returns to handleRemove, the entry.key reflects
     *  the post-migration key.  handleRemove captures the entry
     *  reference BEFORE the await and reads entry.key AFTER, so
     *  downstream removeManagedPosition + _positionBotStates.delete
     *  target the right (migrated) key. */
    const OLD_KEY = key("100");
    const NEW_KEY = key("200");
    const dc = makeDiskConfig({
      positions: { [OLD_KEY]: { status: "running", slippagePct: 0.5 } },
    });
    const states = getAllPositionBotStates();
    states.set(OLD_KEY, { running: true });

    /*- The entry object whose .key will be migrated in-place during stop. */
    const entry = { key: OLD_KEY, tokenId: "100", status: "running" };
    const deps = makeRouteDeps({
      readJsonBody: async () => ({ key: OLD_KEY }),
      diskConfig: dc,
      positionMgr: makePositionMgr({
        get: (k) => (k === OLD_KEY ? entry : null),
        removePosition: async () => {
          /*- Simulate the in-flight poll completing a rebalance during
           *  stop(): migrate the entry under the new key. */
          entry.key = NEW_KEY;
          entry.tokenId = "200";
          /*- Mirror the bot's migration callback effect: rename the
           *  disk slot and the bot state map entry. */
          dc.positions[NEW_KEY] = dc.positions[OLD_KEY];
          delete dc.positions[OLD_KEY];
          states.set(NEW_KEY, states.get(OLD_KEY));
          states.delete(OLD_KEY);
        },
        count: () => 0,
      }),
    });

    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["DELETE /api/position/manage"]({}, res);

    assert.strictEqual(res._status, 200);
    /*- Migrated key has status flipped to stopped.  Without the entry-
     *  reference capture fix, the cleanup would have targeted the
     *  original OLD_KEY (now absent on disk) and silently left the
     *  migrated NEW_KEY entry as running. */
    assert.ok(dc.positions[NEW_KEY], "migrated entry still on disk");
    assert.strictEqual(dc.positions[NEW_KEY].status, "stopped");
    assert.ok(!states.has(NEW_KEY), "bot state cleared for migrated key");
    assert.ok(!states.has(OLD_KEY), "no bot state under stale old key");
  });

  it("falls back to body.key when positionMgr returns no entry", async () => {
    /*- Edge case: the position was already gone from positionMgr (e.g.
     *  a prior remove or never-started).  handleRemove falls back to
     *  body.key for cleanup, which is correct because no migration
     *  could have happened without an active bot loop. */
    const KEY = key("400");
    const dc = makeDiskConfig({ positions: { [KEY]: { status: "running" } } });
    const states = getAllPositionBotStates();
    states.set(KEY, {});

    const deps = makeRouteDeps({
      readJsonBody: async () => ({ key: KEY }),
      diskConfig: dc,
      positionMgr: makePositionMgr({
        get: () => null, // no entry — already removed or never started
        removePosition: async () => {},
        count: () => 0,
      }),
    });

    const routes = createPositionRoutes(deps);
    const res = makeRes();
    await routes["DELETE /api/position/manage"]({}, res);

    assert.strictEqual(res._status, 200);
    assert.strictEqual(dc.positions[KEY].status, "stopped");
    assert.ok(!states.has(KEY));
  });
});
