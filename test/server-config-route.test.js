/**
 * @file test/server-config-route.test.js
 * @description Unit tests for `POST /api/config` in src/server-routes.js.
 *
 * Split out of test/server-routes.test.js at the 500-line cap when the
 * route grew a value check. The route is the one place a setting an
 * operator typed becomes config on disk, so what is pinned here is what
 * it refuses, what it clears, and — for a refusal — that nothing at all
 * is applied: no global assign, no position slot created, no paused bot
 * loop freed.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { createRouteHandlers } = require("../src/server-routes");

/** Build a minimal deps object with stubs for createRouteHandlers. */
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
describe("POST /api/config", () => {
  it("applies global keys from body", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({ triggerType: "oor" }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.ok, true);
    assert.strictEqual(res._body.applied.triggerType, "oor");
    assert.strictEqual(deps.diskConfig.global.triggerType, "oor");
  });

  it("refuses a checkIntervalSec that cannot serve as a timer delay", async () => {
    /*- The one settable key that becomes a `setTimeout` delay. The
     *  poll cycle re-reads it every pass, so a bad value lands on a
     *  RUNNING bot — and past what a timer holds it does not poll
     *  slowly, it polls with no gap at all. 400 rather than a clamp,
     *  so the dashboard can say what was wrong instead of saving a
     *  different number than the one entered. */
    for (const bad of [0, -5, "abc", 1.5, 99_999_999]) {
      const deps = makeDeps({
        readJsonBody: async () => ({
          positionKey: "pulsechain-0x1-0x2-100",
          checkIntervalSec: bad,
        }),
      });
      deps.diskConfig.positions = {
        "pulsechain-0x1-0x2-100": { status: "running" },
      };
      const h = createRouteHandlers(deps);
      const res = makeRes();
      await h._handleApiConfig({}, res);
      assert.strictEqual(res._status, 400, `${String(bad)} must be refused`);
      assert.strictEqual(res._body.ok, false);
      /*- The message names the setting the way the dashboard labels
       *  it, so the operator reads the same words they typed into;
       *  `invalidValueForKey` carries the config key for the code. */
      assert.match(res._body.error, /Check Interval/);
      assert.strictEqual(res._body.invalidValueForKey, "checkIntervalSec");
      assert.strictEqual(
        deps.diskConfig.positions["pulsechain-0x1-0x2-100"].checkIntervalSec,
        undefined,
        "and nothing is written",
      );
    }
  });

  it("clears a GLOBAL key sent as null rather than storing the null", async () => {
    /*- `null` means "clear this setting", and the per-position patch
     *  has always been swept for it. Global keys reach that case now
     *  that an empty Bot Settings field is sent as null — Max Gas Fee
     *  and Approval Multiple are both global — and assigning it would
     *  leave a literal `null` in bot-config.json instead of letting
     *  the shipped default stand. */
    const deps = makeDeps({
      readJsonBody: async () => ({ gasFeePct: null }),
    });
    deps.diskConfig.global.gasFeePct = 7;
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.ok(
      !("gasFeePct" in deps.diskConfig.global),
      "the key is removed, not set to null",
    );
  });

  it("accepts a checkIntervalSec inside the bounds", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({
        positionKey: "pulsechain-0x1-0x2-100",
        checkIntervalSec: 600,
      }),
    });
    deps.diskConfig.positions = {
      "pulsechain-0x1-0x2-100": { status: "running" },
    };
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied.checkIntervalSec, 600);
  });

  it("applies position keys to specific positionKey", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({
        positionKey: "pulsechain-0x1-0x2-100",
        slippagePct: 2.0,
      }),
    });
    deps.diskConfig.positions = {
      "pulsechain-0x1-0x2-100": { status: "running" },
    };
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied.slippagePct, 2.0);
  });

  it("lazy-creates the position slot when absent (Save-before-Manage)", async () => {
    // No pre-existing positions entry — the user is editing settings
    // on an unmanaged position before clicking Manage.
    const pk = "pulsechain-0x1-0x2-200";
    const deps = makeDeps({
      readJsonBody: async () => ({
        positionKey: pk,
        slippagePct: 0.5,
        rebalanceOutOfRangeThresholdPercent: 3,
      }),
    });
    assert.strictEqual(deps.diskConfig.positions[pk], undefined);
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied.slippagePct, 0.5);
    assert.strictEqual(
      res._body.applied.rebalanceOutOfRangeThresholdPercent,
      3,
    );
    // Slot now exists with the user's values, no status flipped yet.
    const slot = deps.diskConfig.positions[pk];
    assert.ok(slot, "position slot should have been lazy-created");
    assert.strictEqual(slot.slippagePct, 0.5);
    assert.strictEqual(slot.rebalanceOutOfRangeThresholdPercent, 3);
    assert.strictEqual(
      slot.status,
      undefined,
      "Save alone must NOT flip status to running — that is Manage's job",
    );
  });

  it("rejects position keys without positionKey", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({ slippagePct: 3.0 }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 400);
    assert.ok(res._body.error.includes("positionKey"));
  });

  it("rejects malformed positionKey", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({
        slippagePct: 1.5,
        positionKey: "bad-key",
      }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 400);
    assert.ok(res._body.error.includes("positionKey"));
  });

  it("clears rebalancePaused when slippagePct changes", async () => {
    // slippagePct is a POSITION_KEY — changing it should clear
    // rebalance pause so the bot retries with the new slippage.
    const pk = "pulsechain-0xAb5-0xCd9-42";
    const posStates = new Map();
    posStates.set(pk, {
      rebalancePaused: true,
      rebalanceError: "err",
    });
    const deps = makeDeps({
      readJsonBody: async () => ({
        slippagePct: 1.5,
        positionKey: pk,
      }),
      getAllPositionBotStates: () => posStates,
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(posStates.get(pk).rebalancePaused, false);
    assert.strictEqual(posStates.get(pk).rebalanceError, null);
  });

  it("ignores unknown keys", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({ PRIVATE_KEY: "hack", PORT: 9999 }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.deepStrictEqual(res._body.applied, {});
  });
});
