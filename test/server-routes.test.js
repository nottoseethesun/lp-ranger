/**
 * @file test/server-routes.test.js
 * @description Unit tests for the server's routes over the bot's
 *   operations, as test/_bot-route-adapters.js builds them
 *   (`createRouteHandlers`): the wallet import and reveal
 *   (src/server/server-routes.js), the wallet scan, details and lifetime
 *   (src/server/position-routes.js), and the token-symbol lookup; and
 *   that the map holds every handler the server mounts. The import's
 *   refusals while a move is under way, and its hold on every move, are
 *   tested in test/server-wallet-import-refusals.test.js, settings saves
 *   in test/server-routes-extra.test.js, the held stop in
 *   test/server-routes-stop.test.js, the start-up in
 *   test/server-auto-start.test.js, and the launch's key step in
 *   test/server-launch-key-step.test.js.
 */

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("assert");
const { createRouteHandlers } = require("./_bot-route-adapters");
const { compositeKey } = require("../src/lib/bot-config-v2");
const config = require("../src/lib/config");
const { CHAIN_NAME } = config;
const appPhase = require("../src/bot/app-phase");
const { createWalletInUse } = require("../src/server/wallet-in-use");
const { makeDeps, makeRes } = require("./helpers/route-handler-deps");
const { clearRequestOver } = require("./helpers/wallet-clear-request");

describe("server-routes createRouteHandlers", () => {
  // ── _handleWalletImport ───────────────────────────────────────────────────

  describe("_handleWalletImport", () => {
    afterEach(() => appPhase._resetAppPhaseForTests());

    it("imports wallet and responds with ok", async () => {
      let importedWith = null;
      let haltedAll = false;
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
          haltAll: () => {
            haltedAll = true;
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
      assert.ok(haltedAll);
    });

    it("keeps nothing of the previous wallet once its positions are halted", async () => {
      /*-
       *  The cached signer was built from the old wallet's key. Kept, it
       *  signed for the new wallet's positions, and every rebalance
       *  failed at the ownership check until a restart.
       */
      const order = [];
      const privateKeyRef = { current: "0xold" };
      const deps = makeDeps({
        privateKeyRef,
        readJsonBody: async () => ({ address: "0x2", password: "pw" }),
        positionMgr: {
          ...makeDeps().positionMgr,
          haltAll: () => order.push("halt"),
          resetSharedSigner: () => {
            order.push("forget signer");
            assert.equal(privateKeyRef.current, null, "old key gone first");
          },
        },
      });
      const res = makeRes();
      await createRouteHandlers(deps)._handleWalletImport({}, res);
      assert.deepEqual(order, ["halt", "forget signer"]);
      assert.equal(privateKeyRef.current, "0xpk_pw", "the new wallet's key");
    });

    it("leaves the wallet locked, not the old key in use, when the new one cannot be decrypted", async () => {
      const privateKeyRef = { current: "0xold" };
      const deps = makeDeps({
        privateKeyRef,
        readJsonBody: async () => ({ address: "0x2", password: "pw" }),
        walletManager: {
          ...makeDeps().walletManager,
          revealWallet: async () => {
            throw new Error("decrypt fail");
          },
        },
      });
      await createRouteHandlers(deps)._handleWalletImport({}, makeRes());
      assert.equal(privateKeyRef.current, null);
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

    describe("while the app is starting up or stopping", () => {
      /*-
       *  An import stops every position and starts the saved ones again
       *  under the new wallet, so it is refused while the start-up works
       *  through the list, and once nothing may start.
       */
      afterEach(() => appPhase._resetAppPhaseForTests());

      /** Import, recording whether the wallet changed or the positions were halted. */
      async function importRecorded() {
        const seen = { imported: false, halted: false };
        const base = makeDeps();
        const h = createRouteHandlers(
          makeDeps({
            walletManager: {
              ...base.walletManager,
              importWallet: async () => {
                seen.imported = true;
              },
            },
            positionMgr: {
              ...base.positionMgr,
              haltAll: () => {
                seen.halted = true;
              },
            },
          }),
        );
        const res = makeRes();
        await h._handleWalletImport({}, res);
        return { res, seen };
      }

      it("is refused during the start-up, changing nothing", async () => {
        appPhase.beginStartUp(2);
        const { res, seen } = await importRecorded();
        assert.strictEqual(res._status, 409);
        assert.match(res._body.error, /still starting/);
        assert.deepStrictEqual(seen, { imported: false, halted: false });
      });

      it("is refused once the app is stopping", async () => {
        appPhase.markStopping();
        const { res, seen } = await importRecorded();
        assert.strictEqual(res._status, 409);
        assert.match(res._body.error, /stopping/);
        assert.deepStrictEqual(seen, { imported: false, halted: false });
      });

      it("is refused while another import is under way", async () => {
        appPhase.beginWalletImport();
        const { res, seen } = await importRecorded();
        assert.strictEqual(res._status, 409);
        assert.match(res._body.error, /importing a wallet/);
        assert.deepStrictEqual(seen, { imported: false, halted: false });
      });
    });

    describe("holds the import as under way", () => {
      /*-
       *  From its first step until its closing start-up has finished,
       *  so a Manage meanwhile is refused and the dashboard reads
       *  Syncing; and however the import ends, so a failed one leaves
       *  nothing refused.
       */
      afterEach(() => appPhase._resetAppPhaseForTests());

      /** The route over a wallet store whose import runs `whileImporting`. */
      function importing(whileImporting) {
        const base = makeDeps();
        return createRouteHandlers(
          makeDeps({
            walletManager: {
              ...base.walletManager,
              importWallet: async () => whileImporting(),
            },
          }),
        );
      }

      it("from its first step, and not once it has ended", async () => {
        const seen = [];
        const h = importing(() => {
          seen.push(appPhase.walletImportUnderWay());
          seen.push(appPhase.refusalToStart());
        });
        const res = makeRes();
        await h._handleWalletImport({}, res);
        assert.strictEqual(res._status, 200);
        assert.strictEqual(seen[0], true, "under way while it imports");
        assert.match(seen[1], /importing a wallet/);
        assert.strictEqual(appPhase.walletImportUnderWay(), false);
        assert.strictEqual(appPhase.refusalToStart(), null);
      });

      it("until a failed import ends", async () => {
        const h = importing(() => {
          throw new Error("bad key");
        });
        await assert.rejects(h._handleWalletImport({}, makeRes()), /bad key/);
        assert.strictEqual(appPhase.walletImportUnderWay(), false);
      });

      it("through its own closing start-up, which still begins", async () => {
        /*-
         *  The start-up asks for the shared signer once it has begun, so
         *  the ask shows it began, and what was under way meanwhile.
         */
        const seen = [];
        const base = makeDeps();
        const h = createRouteHandlers(
          makeDeps({
            positionMgr: {
              ...base.positionMgr,
              getSharedSigner: async () => {
                seen.push({
                  importing: appPhase.walletImportUnderWay(),
                  startUp: appPhase.startUpProgress(),
                });
                throw new Error("no chain in this test");
              },
            },
          }),
        );
        const res = makeRes();
        await h._handleWalletImport({}, res);
        assert.strictEqual(res._status, 200);
        assert.deepStrictEqual(seen, [
          { importing: true, startUp: { done: 0, total: 0 } },
        ]);
        assert.strictEqual(appPhase.walletImportUnderWay(), false);
        assert.strictEqual(appPhase.startUpProgress(), null);
      });
    });
  });

  // ── _handleWalletReveal ───────────────────────────────────────────────────

  describe("_handleWalletReveal", () => {
    /*-
     *  The decrypt's answer names the wallet it opened
     *  (src/lib/wallet-manager.js `revealWallet`), and Reveal Key answers
     *  with that address.
     */
    it("reveals wallet with correct password", async () => {
      const deps = makeDeps({
        readJsonBody: async () => ({ password: "secret" }),
        walletManager: {
          revealWallet: async () => ({
            privateKey: "0xpk",
            mnemonic: "word1 word2",
            address: "0xAddr",
          }),
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

    it("refuses a Clear while it decrypts", async () => {
      // A Clear sent from another tab, on a later turn, during the decrypt.
      const walletInUse = createWalletInUse();
      const clearNow = clearRequestOver(walletInUse);
      const answers = [];
      const h = createRouteHandlers(
        makeDeps({
          walletInUse,
          readJsonBody: async () => ({ password: "secret" }),
          walletManager: {
            revealWallet: async () => {
              await new Promise((resolve) => setImmediate(resolve));
              answers.push(await clearNow());
              return { privateKey: "0xpk", mnemonic: null, address: "0xA" };
            },
            getStatus: () => ({ source: "key" }),
          },
        }),
      );
      await h._handleWalletReveal({}, makeRes());
      assert.strictEqual(answers[0].status, 409);
      assert.match(answers[0].body.error, /reveal its key/);
      assert.strictEqual((await clearNow()).status, 200, "taken once done");
    });

    it("answers a decrypt another wallet's import overtook 409, revealing nothing", async () => {
      /*-
       *  The decrypt was stale (the user's rule, 2026-11-27): the answer
       *  sets `walletReplaced`, which the dashboard takes quietly.
       */
      const h = createRouteHandlers(
        makeDeps({
          readJsonBody: async () => ({ password: "secret" }),
          walletManager: {
            revealWallet: async () => {
              throw Object.assign(new Error("The wallet changed"), {
                staleWallet: true,
              });
            },
            getStatus: () => ({ source: "key" }),
          },
        }),
      );
      const res = makeRes();
      await h._handleWalletReveal({}, res);
      assert.strictEqual(res._status, 409);
      assert.strictEqual(res._body.walletReplaced, true);
      assert.strictEqual(res._body.privateKey, undefined, "nothing revealed");
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

  // The held stop's route: test/server-routes-stop.test.js.

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
        "_handleStopWhenAllClear",
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
