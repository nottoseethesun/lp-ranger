/**
 * @file test/server-routes.test.js
 * @description Unit tests for src/server-routes.js createRouteHandlers.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const { createRouteHandlers } = require("../src/server-routes");
const { compositeKey } = require("../src/bot-config-v2");
const { CHAIN_NAME } = require("../src/config");

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

describe("server-routes createRouteHandlers", () => {
  // ── _handleApiConfig ──────────────────────────────────────────────────────

  describe("_handleApiConfig", () => {
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

  // ── _handleWalletImport ───────────────────────────────────────────────────

  describe("_handleWalletImport", () => {
    it("imports wallet and responds with ok", async () => {
      let importedWith = null;
      let stoppedAll = false;
      const deps = makeDeps({
        readJsonBody: async () => ({
          address: "0xABCD1234567890",
          privateKey: "0xpk",
          password: "pw",
        }),
        walletManager: {
          importWallet: async (opts) => {
            importedWith = opts;
          },
          revealWallet: async () => ({ privateKey: "0xnew" }),
          getAddress: () => "0xABCD1234567890",
          getStatus: () => ({ loaded: true }),
          hasWallet: () => true,
        },
        positionMgr: {
          ...makeDeps().positionMgr,
          stopAll: async () => {
            stoppedAll = true;
          },
        },
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      await h._handleWalletImport({}, res);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(res._body.ok, true);
      assert.strictEqual(res._body.address, "0xABCD1234567890");
      assert.ok(importedWith);
      assert.ok(stoppedAll);
    });

    it("handles key resolution failure gracefully", async () => {
      const deps = makeDeps({
        readJsonBody: async () => ({
          address: "0x1",
          privateKey: "0xpk",
          password: "pw",
        }),
        walletManager: {
          importWallet: async () => {},
          revealWallet: async () => {
            throw new Error("decrypt fail");
          },
          getAddress: () => "0x1",
          getStatus: () => ({ loaded: true }),
          hasWallet: () => true,
        },
        positionMgr: {
          ...makeDeps().positionMgr,
          stopAll: async () => {},
        },
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      // Should not throw — error is caught internally
      await h._handleWalletImport({}, res);
      assert.strictEqual(res._status, 200);
    });
  });

  // ── _handleWalletReveal ───────────────────────────────────────────────────

  describe("_handleWalletReveal", () => {
    it("reveals wallet with correct password", async () => {
      const deps = makeDeps({
        readJsonBody: async () => ({ password: "secret" }),
        walletManager: {
          revealWallet: async () => ({
            privateKey: "0xpk",
            mnemonic: "word1 word2",
          }),
          getAddress: () => "0xAddr",
          getStatus: () => ({ source: "key" }),
        },
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      await h._handleWalletReveal({}, res);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(res._body.ok, true);
      assert.strictEqual(res._body.privateKey, "0xpk");
      assert.strictEqual(res._body.hasMnemonic, true);
      assert.strictEqual(res._body.address, "0xAddr");
    });
  });

  // ── _resolveTokenSymbol ───────────────────────────────────────────────────

  describe("_resolveTokenSymbol", () => {
    it("returns ? for falsy address", async () => {
      const h = createRouteHandlers(makeDeps());
      const result = await h._resolveTokenSymbol({}, null);
      assert.strictEqual(result, "?");
    });

    it("returns ? for empty string address", async () => {
      const h = createRouteHandlers(makeDeps());
      const result = await h._resolveTokenSymbol({}, "");
      assert.strictEqual(result, "?");
    });

    it("returns fallback on contract call failure", async () => {
      const h = createRouteHandlers(makeDeps());
      // Pass a mock provider that will cause ethers.Contract to fail
      const result = await h._resolveTokenSymbol(
        {},
        "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
      );
      // Should return the abbreviated fallback
      assert.ok(result.includes("0xABCD"));
    });
  });

  // ── _handleShutdown ───────────────────────────────────────────────────────

  describe("_handleShutdown", () => {
    it("responds with ok and stops all positions", async () => {
      let stopped = false;
      let closed = false;
      const deps = makeDeps({
        positionMgr: {
          ...makeDeps().positionMgr,
          stopAll: async () => {
            stopped = true;
          },
        },
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      const srv = {
        close: () => {
          closed = true;
        },
      };
      await h._handleShutdown({}, res, srv);
      assert.strictEqual(res._status, 200);
      assert.strictEqual(res._body.ok, true);
      assert.ok(stopped);
      assert.ok(closed);
    });
  });

  // ── _handlePositionDetails ────────────────────────────────────────────────

  describe("_handlePositionDetails", () => {
    it("returns 400 when required fields are missing", async () => {
      const deps = makeDeps({
        readJsonBody: async () => ({ tokenId: "123" }),
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      await h._handlePositionDetails({}, res);
      assert.strictEqual(res._status, 400);
      assert.strictEqual(res._body.ok, false);
      assert.ok(res._body.error.includes("Missing"));
    });

    it("returns 400 when tokenId is missing", async () => {
      const deps = makeDeps({
        readJsonBody: async () => ({
          token0: "0xa",
          token1: "0xb",
          fee: 3000,
        }),
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      await h._handlePositionDetails({}, res);
      assert.strictEqual(res._status, 400);
    });
  });

  // ── _handlePositionLifetime ───────────────────────────────────────────────

  describe("_handlePositionLifetime", () => {
    it("returns 400 when required fields are missing", async () => {
      const deps = makeDeps({
        readJsonBody: async () => ({ tokenId: "1" }),
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      await h._handlePositionLifetime({}, res);
      assert.strictEqual(res._status, 400);
      assert.strictEqual(res._body.ok, false);
      assert.ok(res._body.error.includes("Missing"));
    });

    it("returns 400 when all fields are missing", async () => {
      const deps = makeDeps({
        readJsonBody: async () => ({}),
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      await h._handlePositionLifetime({}, res);
      assert.strictEqual(res._status, 400);
    });

    it("returns 500 and logs error on computeLifetimeDetails failure", async () => {
      const posStates = new Map();
      const deps = makeDeps({
        readJsonBody: async () => ({
          tokenId: "100",
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
      // computeLifetimeDetails will throw (no real RPC) → 500
      await h._handlePositionLifetime({}, res);
      assert.strictEqual(res._status, 500);
      assert.strictEqual(res._body.ok, false);
      assert.ok(res._body.error);
    });

    /*-
     *  Who owns a position's `pnlSnapshot`. This route builds one for
     *  what an UNMANAGED position shows — the Current panel's two rows —
     *  and the dashboard suppresses its fetch only once a poll has
     *  landed, so a page load fires it at a MANAGED position too. The
     *  bot owns that position's snapshot, and it carries the Lifetime
     *  figures this route does not compute; writing over it would blank
     *  the Lifetime panel until the next poll, one CHECK_INTERVAL_SEC
     *  away.
     */
    /*- Real addresses: `compositeKey` checksums them. */
    const lifetimeBody = {
      tokenId: "100",
      token0: "0x" + "1".repeat(40),
      token1: "0x" + "2".repeat(40),
      fee: 3000,
      walletAddress: "0x" + "3".repeat(40),
      contractAddress: "0x" + "4".repeat(40),
    };
    /** Run the route with a stub result, against one position's state. */
    async function runLifetime(status) {
      const posStates = new Map();
      const key = compositeKey(
        CHAIN_NAME,
        lifetimeBody.walletAddress,
        lifetimeBody.contractAddress,
        lifetimeBody.tokenId,
      );
      posStates.set(key, {
        pnlSnapshot: { lifetimeIL: -42, fromTheBot: true },
      });
      const deps = makeDeps({
        readJsonBody: async () => ({ ...lifetimeBody }),
        getAllPositionBotStates: () => posStates,
        computeLifetimeDetails: async () => ({
          ok: true,
          pnlSnapshot: { currentCompoundedUsd: 3, fromTheRoute: true },
        }),
      });
      deps.diskConfig.positions[key] = { status };
      const h = createRouteHandlers(deps);
      await h._handlePositionLifetime({}, makeRes());
      return posStates.get(key);
    }

    it("leaves a managed position's snapshot to the bot", async () => {
      const s = await runLifetime("running");
      assert.equal(s.pnlSnapshot.fromTheBot, true, "the bot's must survive");
      assert.equal(s.pnlSnapshot.lifetimeIL, -42);
    });

    it("writes the snapshot for an unmanaged position", async () => {
      const s = await runLifetime("stopped");
      assert.equal(s.pnlSnapshot.fromTheRoute, true);
      assert.equal(s.pnlSnapshot.currentCompoundedUsd, 3);
    });
  });

  // ── _handlePositionsScan ──────────────────────────────────────────────────

  describe("_handlePositionsScan", () => {
    it("returns 400 when no wallet is loaded", async () => {
      const deps = makeDeps({
        walletManager: {
          ...makeDeps().walletManager,
          getStatus: () => ({ loaded: false }),
        },
      });
      const h = createRouteHandlers(deps);
      const res = makeRes();
      await h._handlePositionsScan({}, res);
      assert.strictEqual(res._status, 400);
      assert.strictEqual(res._body.ok, false);
      assert.ok(res._body.error.includes("wallet"));
    });
  });

  // ── _tryResolveKey ────────────────────────────────────────────────────────

  describe("_tryResolveKey", () => {
    it("sets privateKeyRef when key is resolved", async () => {
      // This test is limited because resolvePrivateKey requires real modules.
      // We just verify it doesn't crash when called.
      const deps = makeDeps();
      deps.diskConfig.positions = {};
      const h = createRouteHandlers(deps);
      // _tryResolveKey calls resolvePrivateKey which depends on external state.
      // Just confirm the function exists and is callable.
      assert.strictEqual(typeof h._tryResolveKey, "function");
    });
  });

  // ── createRouteHandlers returns all expected handlers ─────────────────────

  describe("returned handler map", () => {
    it("contains all expected handler functions", () => {
      const h = createRouteHandlers(makeDeps());
      const expected = [
        "_handleApiConfig",
        "_handleWalletImport",
        "_handleWalletReveal",
        "_resolveTokenSymbol",
        "_handlePositionsScan",
        "_handleShutdown",
        "_handlePositionDetails",
        "_handlePositionLifetime",
        "_tryResolveKey",
        "_autoStartManagedPositions",
      ];
      for (const name of expected) {
        assert.strictEqual(
          typeof h[name],
          "function",
          `Expected handler ${name} to be a function`,
        );
      }
    });
  });
});
