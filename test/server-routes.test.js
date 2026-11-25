/**
 * @file test/server-routes.test.js
 * @description Unit tests for the server's routes over the bot's
 *   operations, as test/_bot-route-adapters.js builds them
 *   (`createRouteHandlers`): the wallet import and reveal and the
 *   launch's key step (src/server/server-routes.js), the wallet scan,
 *   details and lifetime
 *   (src/server/position-routes.js), and the token-symbol lookup; and
 *   that the map holds every handler the server mounts. Settings saves
 *   are tested in test/server-routes-extra.test.js, the held stop in
 *   test/server-routes-stop.test.js, and the start-up in
 *   test/server-auto-start.test.js.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const { createRouteHandlers } = require("./_bot-route-adapters");
const { compositeKey } = require("../src/lib/bot-config-v2");
const config = require("../src/lib/config");
const { CHAIN_NAME } = config;
const appPhase = require("../src/bot/app-phase");
const { makeDeps, makeRes } = require("./helpers/route-handler-deps");

describe("server-routes createRouteHandlers", () => {
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

    it("keeps nothing of the previous wallet once its positions stop", async () => {
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
          stopAll: async () => order.push("stop"),
          resetSharedSigner: () => {
            order.push("forget signer");
            assert.equal(privateKeyRef.current, null, "old key gone first");
          },
        },
      });
      const res = makeRes();
      await createRouteHandlers(deps)._handleWalletImport({}, res);
      assert.deepEqual(order, ["stop", "forget signer"]);
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

      /** Import, recording whether the wallet changed or a stop came. */
      async function importRecorded() {
        const seen = { imported: false, stopped: false };
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
              stopAll: async () => {
                seen.stopped = true;
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
        assert.deepStrictEqual(seen, { imported: false, stopped: false });
      });

      it("is refused once the app is stopping", async () => {
        appPhase.markStopping();
        const { res, seen } = await importRecorded();
        assert.strictEqual(res._status, 409);
        assert.match(res._body.error, /stopping/);
        assert.deepStrictEqual(seen, { imported: false, stopped: false });
      });

      it("is refused while another import is under way", async () => {
        appPhase.beginWalletImport();
        const { res, seen } = await importRecorded();
        assert.strictEqual(res._status, 409);
        assert.match(res._body.error, /importing a wallet/);
        assert.deepStrictEqual(seen, { imported: false, stopped: false });
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

  // ── _tryResolveKey ────────────────────────────────────────────────────────

  describe("_tryResolveKey", () => {
    /*-
     *  The launch's key step picks the key from PRIVATE_KEY, then the
     *  wallet unlocked by WALLET_PASSWORD or the terminal prompt
     *  (src/server/server-routes.js). These cases set no PRIVATE_KEY and
     *  hand it a WALLET_PASSWORD of their own. It stands aside, asked
     *  before the decrypt and after it, while a wallet import is under
     *  way, which takes its own wallet's key and starts that wallet's
     *  positions, and once the bot holds a key, which came from the
     *  dashboard while the terminal prompt waited.
     */
    let savedKey;
    beforeEach(() => {
      savedKey = config.PRIVATE_KEY;
      config.PRIVATE_KEY = null;
    });
    afterEach(() => {
      config.PRIVATE_KEY = savedKey;
      appPhase._resetAppPhaseForTests();
    });

    /**
     * The key step over a wallet whose decrypt runs `duringDecrypt` (with
     * the key the bot holds) and then answers, or refuses the password
     * when `wrongPassword`; it counts decrypts, and records the key each
     * start-up asked the shared signer to be built from.
     */
    function keyStep({ duringDecrypt = () => {}, wrongPassword = false } = {}) {
      const seen = { revealed: 0, signers: [] };
      const privateKeyRef = { current: null };
      const base = makeDeps();
      const h = createRouteHandlers(
        makeDeps({
          privateKeyRef,
          envWalletPassword: () => "pw",
          walletManager: {
            ...base.walletManager,
            revealWallet: async () => {
              seen.revealed++;
              duringDecrypt(privateKeyRef);
              if (wrongPassword) throw new Error("Wrong password");
              return { privateKey: "0xold" };
            },
          },
          positionMgr: {
            ...base.positionMgr,
            getSharedSigner: async ({ privateKey }) => {
              seen.signers.push(privateKey);
              throw new Error("no chain in this test");
            },
          },
        }),
      );
      return { run: () => h._tryResolveKey(), seen, privateKeyRef };
    }

    it("takes the key and starts the saved positions", async () => {
      const k = keyStep();
      await k.run();
      assert.strictEqual(k.seen.revealed, 1);
      assert.strictEqual(k.privateKeyRef.current, "0xold");
      assert.deepStrictEqual(k.seen.signers, ["0xold"], "the start-up began");
    });

    it("stands aside while a wallet import is under way, decrypting nothing", async () => {
      const k = keyStep();
      appPhase.beginWalletImport();
      await k.run();
      assert.strictEqual(k.seen.revealed, 0);
      assert.strictEqual(k.privateKeyRef.current, null);
      assert.deepStrictEqual(k.seen.signers, []);
    });

    it("stands aside when a wallet import begins during the decrypt", async () => {
      const k = keyStep({ duringDecrypt: () => appPhase.beginWalletImport() });
      await k.run();
      assert.strictEqual(k.seen.revealed, 1);
      assert.strictEqual(
        k.privateKeyRef.current,
        null,
        "the old key not taken",
      );
      assert.deepStrictEqual(k.seen.signers, []);
    });

    it("does nothing once the wallet is unlocked, trying no password", async () => {
      /*-
       *  A dashboard import while the prompt waited loads a wallet the
       *  password typed may not open. Tried, its refusal stopped the
       *  server.
       */
      const k = keyStep({ wrongPassword: true });
      k.privateKeyRef.current = "0xdash";
      await k.run();
      assert.strictEqual(k.seen.revealed, 0);
      assert.strictEqual(k.privateKeyRef.current, "0xdash");
      assert.deepStrictEqual(k.seen.signers, [], "no second start-up");
    });

    it("does nothing when the wallet is unlocked during the decrypt", async () => {
      const k = keyStep({
        duringDecrypt: (ref) => {
          ref.current = "0xdash";
        },
      });
      await k.run();
      assert.strictEqual(k.seen.revealed, 1);
      assert.strictEqual(k.privateKeyRef.current, "0xdash", "its key kept");
      assert.deepStrictEqual(k.seen.signers, [], "no second start-up");
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
