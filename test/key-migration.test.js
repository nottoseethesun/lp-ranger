/**
 * @file test/key-migration.test.js
 * @description Tests that composite key migration (rebalance → new tokenId)
 *   correctly updates all closure references so subsequent updateBotState
 *   and getConfig calls use the new key, not the stale old key.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  updatePositionState,
  createPerPositionBotState,
  getAllPositionBotStates,
} = require("../src/server-positions");
const {
  getPositionConfig,
  compositeKey,
  readConfigValue,
  addManagedPosition,
} = require("../src/bot-config-v2");

/** Minimal position manager mock. */
function mockPositionMgr() {
  const migrated = [];
  return {
    migrateKey(oldKey, newKey, newTokenId) {
      migrated.push({ oldKey, newKey, newTokenId });
    },
    getMigrated() {
      return migrated;
    },
  };
}

// Production file protection handled by scripts/check.sh
describe("key migration on rebalance", () => {
  it("keyRef.current updates so subsequent calls use the new key", () => {
    const diskConfig = {
      global: {},
      positions: {},
    };
    const oldKey = compositeKey(
      "pulsechain",
      "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      "100",
    );
    const newTokenId = "200";
    const mgr = mockPositionMgr();

    // Set up initial state
    addManagedPosition(diskConfig, oldKey);
    getPositionConfig(diskConfig, oldKey).slippagePct = 2;
    const posBotState = createPerPositionBotState(
      diskConfig.global,
      getPositionConfig(diskConfig, oldKey),
    );

    // Simulate what the server does: create keyRef + closures
    const keyRef = { current: oldKey };
    const updateBotState = (patch) =>
      updatePositionState(keyRef, patch, diskConfig, mgr);
    const getConfig = (k) => readConfigValue(diskConfig, keyRef.current, k);

    // Register in the global map (server-positions internal)
    getAllPositionBotStates().set(oldKey, posBotState);

    // First update — should work with old key
    updateBotState({ running: true });
    assert.strictEqual(getAllPositionBotStates().get(oldKey)?.running, true);

    // Trigger migration by setting activePositionId
    updateBotState({ activePositionId: newTokenId });

    const newKey = compositeKey(
      "pulsechain",
      "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      newTokenId,
    );
    assert.strictEqual(
      keyRef.current,
      newKey,
      "keyRef.current should be updated to new key",
    );
    assert.strictEqual(
      getAllPositionBotStates().has(oldKey),
      false,
      "old key should be deleted",
    );
    assert.ok(getAllPositionBotStates().has(newKey), "new key should exist");

    // Subsequent updates should use the NEW key
    updateBotState({
      rebalanceError: "test error",
      rebalancePaused: true,
    });
    const state = getAllPositionBotStates().get(newKey);
    assert.strictEqual(state.rebalanceError, "test error");
    assert.strictEqual(state.rebalancePaused, true);

    // getConfig should read from the new key's config
    assert.strictEqual(
      getConfig("slippagePct"),
      2,
      "getConfig should read from migrated position config",
    );

    // Disk config should have the new key, not the old
    assert.ok(diskConfig.positions[newKey], "disk config should have new key");

    // Cleanup
    getAllPositionBotStates().delete(newKey);
  });

  it("forceRebalance is cleared during migration", () => {
    const diskConfig = {
      global: {},
      positions: {},
    };
    const oldKey = compositeKey(
      "pulsechain",
      "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      "50",
    );
    const mgr = mockPositionMgr();

    addManagedPosition(diskConfig, oldKey);
    const posBotState = createPerPositionBotState(diskConfig.global, {});
    posBotState.forceRebalance = true;
    getAllPositionBotStates().set(oldKey, posBotState);

    const keyRef = { current: oldKey };
    updatePositionState(keyRef, { activePositionId: "51" }, diskConfig, mgr);

    const newKey = compositeKey(
      "pulsechain",
      "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      "51",
    );
    const state = getAllPositionBotStates().get(newKey);
    assert.strictEqual(
      state.forceRebalance,
      false,
      "forceRebalance should be cleared",
    );
    assert.strictEqual(
      state.rebalancePaused,
      false,
      "rebalancePaused should be cleared",
    );

    // Cleanup
    getAllPositionBotStates().delete(newKey);
  });
});
