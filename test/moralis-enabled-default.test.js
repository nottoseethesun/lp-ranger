"use strict";

/**
 * @file test/moralis-enabled-default.test.js
 * @description An operator's default for the "Use Moralis Key" switch
 *   decides whether the stored key is used, until a choice is saved.
 *
 *   bot-config-defaults.json ships `moralisEnabled: true`, and an
 *   operator's copy of that file may say false. Nothing read that
 *   default: with no choice saved in bot-config.json, the key was used at
 *   every unlock and after a save that cleared the choice, and the switch
 *   showed on. Now one rule (`moralisEnabledIn`, src/lib/server-moralis.js)
 *   answers for the unlock, the save and the status the switch reads.
 *
 *   The operator's copy here says false, so a server that ignored it
 *   would answer true. It is set, and the working directory moved to a
 *   scratch one, before anything under src/lib/ loads: the loader reads the
 *   override directory's path at load, and the saves and key files these
 *   cases reach are under the working directory, so the install's own
 *   are never touched.
 */

const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "moralis-default-"));
fs.writeFileSync(
  path.join(_USER_DIR, "bot-config-defaults.json"),
  JSON.stringify({ moralisEnabled: false }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
const _SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "moralis-default-cwd-"));
const _CWD = process.cwd();
process.chdir(_SCRATCH);
after(() => {
  process.chdir(_CWD);
  fs.rmSync(_USER_DIR, { recursive: true, force: true });
  fs.rmSync(_SCRATCH, { recursive: true, force: true });
});

const holder = require("../src/lib/api-key-holder");
const { moralisEnabledIn } = require("../src/lib/server-moralis");
const { createRouteHandlers } = require("../src/lib/server-routes");
const { createApiStatusHandler } = require("../src/lib/handle-api-status");
const { primaryRouteLabel } = require("../src/lib/rebalancer-swap");
const config = require("../src/lib/config");

/** The smallest set of route dependencies, with `global` as given. */
function routeDeps(global, body = {}) {
  return {
    diskConfig: { global, positions: {} },
    positionMgr: { getAll: () => [], get: () => null },
    privateKeyRef: { current: null },
    walletManager: {
      getStatus: () => ({ loaded: false }),
      getAddress: () => null,
      hasWallet: () => false,
    },
    jsonResponse: (res, status, b) => Object.assign(res, { status, body: b }),
    readJsonBody: async () => body,
    getAllPositionBotStates: () => new Map(),
    createPerPositionBotState: () => ({}),
    attachMultiPosDeps: () => {},
    updatePositionState: () => {},
  };
}

/** The `global` section `GET /api/status` answers with. */
async function statusGlobal(global) {
  let sent = null;
  await createApiStatusHandler({
    config,
    diskConfig: { global, positions: {} },
    positionMgr: {
      runningCount: () => 0,
      getAll: () => [],
      getPoolDailyCounts: () => ({}),
    },
    walletManager: { getAddress: () => "0xW" },
    routeHandlers: { getPositionScanStatus: () => null },
    buildStatusPositions: () => ({}),
    buildGasStatusPayload: async () => ({}),
    actualGasCostUsd: async () => 0,
    getLpProviderDisplayName: () => "",
    managedKeys: () => [],
    primaryRouteLabel,
    moralisEnabledIn,
    jsonResponse: (_res, _code, b) => {
      sent = b;
    },
  })({}, {});
  return sent.global;
}

describe("the Use Moralis Key default", () => {
  it("decides while no choice is saved, and a saved choice wins", () => {
    assert.equal(moralisEnabledIn({}), false);
    assert.equal(moralisEnabledIn(undefined), false);
    assert.equal(moralisEnabledIn({ moralisEnabled: true }), true);
    assert.equal(moralisEnabledIn({ moralisEnabled: false }), false);
  });

  describe("on unlock", () => {
    beforeEach(() => holder.setServiceEnabled("moralis", true));

    it("leaves the key unused when the default says off", async () => {
      await createRouteHandlers(routeDeps({}))._decryptApiKeys("pw");
      assert.equal(holder.isServiceEnabled("moralis"), false);
    });

    it("uses it when the saved choice says on", async () => {
      holder.setServiceEnabled("moralis", false);
      await createRouteHandlers(
        routeDeps({ moralisEnabled: true }),
      )._decryptApiKeys("pw");
      assert.equal(holder.isServiceEnabled("moralis"), true);
    });
  });

  describe("on a save", () => {
    it("falls back to the default when the choice is cleared", async () => {
      holder.setServiceEnabled("moralis", true);
      const deps = routeDeps(
        { moralisEnabled: true },
        { moralisEnabled: null },
      );
      const res = {};
      await createRouteHandlers(deps)._handleApiConfig({}, res);
      assert.equal(res.status, 200);
      assert.equal("moralisEnabled" in deps.diskConfig.global, false);
      assert.equal(holder.isServiceEnabled("moralis"), false);
    });

    it("applies the choice saved", async () => {
      holder.setServiceEnabled("moralis", false);
      const res = {};
      await createRouteHandlers(
        routeDeps({}, { moralisEnabled: true }),
      )._handleApiConfig({}, res);
      assert.equal(res.status, 200);
      assert.equal(holder.isServiceEnabled("moralis"), true);
    });
  });

  describe("in GET /api/status", () => {
    it("is published as the server applies it, so the switch shows it", async () => {
      assert.equal((await statusGlobal({})).moralisEnabled, false);
      assert.equal(
        (await statusGlobal({ moralisEnabled: true })).moralisEnabled,
        true,
      );
    });
  });
});
