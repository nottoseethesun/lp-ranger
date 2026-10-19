/**
 * @file test/server-config-route.test.js
 * @description Unit tests for `POST /api/config`, built by
 * src/server-config-route.js and served by src/server-routes.js.
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
const { checkIlGuard } = require("../src/il-guard");
const { ilSnapshot } = require("./helpers/il-snapshot");

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
      readJsonBody: async () => ({ gasFeePct: 2 }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.ok, true);
    assert.strictEqual(res._body.applied.gasFeePct, 2);
    assert.strictEqual(deps.diskConfig.global.gasFeePct, 2);
  });

  it("no longer saves the retired triggerType or gasStrategy", async () => {
    /*-
     *  Neither is a setting any more, so neither is applied, and a
     *  gasStrategy sent without a position key is not refused for the
     *  missing key: it is not a position setting either.
     */
    const deps = makeDeps({
      readJsonBody: async () => ({ triggerType: "oor", gasStrategy: "auto" }),
    });
    const res = makeRes();
    await createRouteHandlers(deps)._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.deepStrictEqual(res._body.applied, {});
    assert.strictEqual(deps.diskConfig.global.triggerType, undefined);
    assert.strictEqual(deps.diskConfig.global.gasStrategy, undefined);
  });

  it("stores no Check Interval for a position", async () => {
    /*-
     *  How often the bot checks is one global setting, in
     *  bot-config-defaults.json or `.env`, and no position has its own.
     *  A request naming one for a position saves nothing for it.
     */
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
    assert.deepStrictEqual(res._body.applied, {});
    assert.strictEqual(
      deps.diskConfig.positions["pulsechain-0x1-0x2-100"].checkIntervalSec,
      undefined,
    );
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

  it("applies position keys to specific positionKey", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({
        positionKey: "pulsechain-0x1-0x2-100",
        slippagePctToken0: 2.0,
      }),
    });
    deps.diskConfig.positions = {
      "pulsechain-0x1-0x2-100": { status: "running" },
    };
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied.slippagePctToken0, 2.0);
  });

  it("lazy-creates the position slot when absent (Save-before-Manage)", async () => {
    // No pre-existing positions entry — the user is editing settings
    // on an unmanaged position before clicking Manage.
    const pk = "pulsechain-0x1-0x2-200";
    const deps = makeDeps({
      readJsonBody: async () => ({
        positionKey: pk,
        slippagePctToken0: 0.5,
        rebalanceOutOfRangeThresholdPercent: 3,
      }),
    });
    assert.strictEqual(deps.diskConfig.positions[pk], undefined);
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(res._body.applied.slippagePctToken0, 0.5);
    assert.strictEqual(
      res._body.applied.rebalanceOutOfRangeThresholdPercent,
      3,
    );
    // Slot now exists with the user's values, no status flipped yet.
    const slot = deps.diskConfig.positions[pk];
    assert.ok(slot, "position slot should have been lazy-created");
    assert.strictEqual(slot.slippagePctToken0, 0.5);
    assert.strictEqual(slot.rebalanceOutOfRangeThresholdPercent, 3);
    assert.strictEqual(
      slot.status,
      undefined,
      "Save alone must NOT flip status to running — that is Manage's job",
    );
  });

  it("rejects position keys without positionKey", async () => {
    const deps = makeDeps({
      readJsonBody: async () => ({ slippagePctToken0: 3.0 }),
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
        slippagePctToken0: 1.5,
        positionKey: "bad-key",
      }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 400);
    assert.ok(res._body.error.includes("positionKey"));
  });

  it("refuses a positionKey on a chain this server does not run, saving nothing", async () => {
    /*-
     *  A tab left open across a restart onto another chain still builds
     *  its keys on the old one. Saved, such a slot would be read by no
     *  bot, while the dashboard reported the setting saved.
     */
    const deps = makeDeps({
      readJsonBody: async () => ({
        slippagePctToken0: 1.5,
        positionKey: "pulsechain-testnet-0x1-0x2-100",
      }),
    });
    const h = createRouteHandlers(deps);
    const res = makeRes();
    await h._handleApiConfig({}, res);
    assert.strictEqual(res._status, 400);
    assert.match(res._body.error, /names chain "pulsechain-testnet"/);
    assert.strictEqual(
      deps.diskConfig.positions["pulsechain-testnet-0x1-0x2-100"],
      undefined,
    );
  });

  it("clears rebalancePaused when a per-token slippage changes", async () => {
    /*- Either Slippage row frees a position the swap-cost gate paused,
     *  so the bot retries with the new figure. This keyed on the single
     *  `slippagePct` until that key was retired, by which time no saver
     *  had sent it since the row became two — the promise in CLAUDE.md
     *  that changing Slippage un-pauses was quietly false. */
    const pk = "pulsechain-0xAb5-0xCd9-42";
    const posStates = new Map();
    posStates.set(pk, {
      rebalancePaused: true,
      rebalanceError: "err",
    });
    const deps = makeDeps({
      readJsonBody: async () => ({
        slippagePctToken0: 1.5,
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

  it("leaves another position's pause alone", async () => {
    /*-
     *  Another position's pause has its own cause, a volatile market or
     *  a failed re-open among them, and this position's slippage does
     *  nothing to answer it. Freed, it would rebalance again, or its
     *  pending retire would be cancelled.
     */
    const pk = "pulsechain-0xAb5-0xCd9-42";
    const other = "pulsechain-0xAb5-0xCd9-77";
    const posStates = new Map([
      [pk, { rebalancePaused: true, rebalanceError: "err" }],
      [other, { rebalancePaused: true, rebalanceError: "volatile" }],
    ]);
    const deps = makeDeps({
      readJsonBody: async () => ({ slippagePctToken1: 2, positionKey: pk }),
      getAllPositionBotStates: () => posStates,
    });
    const res = makeRes();
    await createRouteHandlers(deps)._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(posStates.get(pk).rebalancePaused, false);
    assert.strictEqual(posStates.get(other).rebalancePaused, true);
    assert.strictEqual(posStates.get(other).rebalanceError, "volatile");
  });

  it("lifts the Impermanent Loss Guard's retry wait when the Guard changes", async () => {
    /*-
     *  A rejection under the old value started a wait of up to a week,
     *  and the setting was not read again until it ended.
     */
    const pk = "pulsechain-0xAb5-0xCd9-42";
    const other = "pulsechain-0xAb5-0xCd9-77";
    const posStates = new Map([
      [pk, { _ilGuardRejectedAt: Date.now(), _ilGuardRejectCount: 3 }],
      [other, { _ilGuardRejectedAt: 1234, _ilGuardRejectCount: 2 }],
    ]);
    const deps = makeDeps({
      readJsonBody: async () => ({
        impermanentLossGuardPct: 40,
        positionKey: pk,
      }),
      getAllPositionBotStates: () => posStates,
    });
    const res = makeRes();
    await createRouteHandlers(deps)._handleApiConfig({}, res);
    assert.strictEqual(res._status, 200);
    assert.strictEqual(posStates.get(pk)._ilGuardRejectedAt, 0);
    // A rejection on the new value starts the wait at its first rung.
    assert.strictEqual(posStates.get(pk)._ilGuardRejectCount, 0);
    // Another position's wait has its own rejection behind it.
    assert.strictEqual(posStates.get(other)._ilGuardRejectedAt, 1234);
    assert.strictEqual(posStates.get(other)._ilGuardRejectCount, 2);
  });

  it("decides on a saved Guard value at the very next check", async () => {
    /*-
     *  The whole contract: rejected at 15%, the position waits; a save of
     *  40% lets the next check through, rather than one up to a week on.
     */
    const pk = "pulsechain-0xAb5-0xCd9-42";
    let saved = 15;
    const st = {};
    const guardDeps = {
      _botState: st,
      _getConfig: (k) => (k === "impermanentLossGuardPct" ? saved : undefined),
      position: { tokenId: 42 },
      updateBotState: () => {},
    };
    // 30% below holding the coins the NFT was minted with.
    const snap = ilSnapshot(700, 1000);
    const check = () => checkIlGuard(guardDeps, false, snap, () => ({}));
    const first = check();
    assert.strictEqual(first?.ilGuardRejected, true, "rejected at 15%");
    assert.notStrictEqual(first?.ilGuardCoolingDown, true);
    saved = 40;
    assert.strictEqual(check()?.ilGuardCoolingDown, true, "waits before Save");
    const deps = makeDeps({
      readJsonBody: async () => ({
        impermanentLossGuardPct: saved,
        positionKey: pk,
      }),
      getAllPositionBotStates: () => new Map([[pk, st]]),
    });
    await createRouteHandlers(deps)._handleApiConfig({}, makeRes());
    assert.strictEqual(check(), null, "lets the rebalance through at 40%");
  });

  it("a request refused for its key frees no pause and applies no global key", async () => {
    // Every refusal comes before the first change, the key's included.
    const pk = "pulsechain-0xAb5-0xCd9-42";
    const posStates = new Map([
      [pk, { rebalancePaused: true, rebalanceError: "err" }],
    ]);
    const deps = makeDeps({
      readJsonBody: async () => ({
        gasFeePct: 2,
        slippagePctToken0: 1.5,
        positionKey: "pulsechain-testnet-0x1-0x2-100",
      }),
      getAllPositionBotStates: () => posStates,
    });
    const res = makeRes();
    await createRouteHandlers(deps)._handleApiConfig({}, res);
    assert.strictEqual(res._status, 400);
    assert.strictEqual(deps.diskConfig.global.gasFeePct, undefined);
    assert.strictEqual(posStates.get(pk).rebalancePaused, true);
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
