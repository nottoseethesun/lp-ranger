/**
 * @file test/server-reload-position.test.js
 * @description Tests for the POST /api/position/reload handler.
 * Covers the on-chain-derived-keys clear-list invariant and the
 * in-progress guard that rejects reloads racing an in-flight
 * rebalance or compound on the SAME position.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  createReloadPositionHandler,
  _resetBotState,
  _checkInProgress,
} = require("../src/lib/server-reload-position");
const { CHAIN_DERIVED_POSITION_KEYS } = require("../src/lib/bot-config-keys");
const {
  markStopping,
  _resetAppPhaseForTests,
} = require("../src/lib/app-phase");
const epochCache = require("../src/lib/epoch-cache");
const config = require("../src/lib/config");
const { eventCachePath } = require("../src/lib/cache-store");

/*- Every test that hits `loadConfig`/`saveConfig` (bot-config-v2) needs
 *  the config file to live in a tmp dir so real user state is never
 *  touched.  We override the module-level path via require.cache tricks.
 *  In practice bot-config-v2 reads a fixed path; for these tests we
 *  focus on paths that don't hit the config file directly. */

// ── Utilities ───────────────────────────────────────────────────────

function _mockPosition() {
  return {
    tokenId: "161973",
    token0: "0x0000000000000000000000000000000000000A11",
    token1: "0x0000000000000000000000000000000000000A12",
    fee: 10000,
  };
}

function _mockKey() {
  return (
    "pulsechain-" +
    "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A-" +
    "0xCC05bf10CE7b70C3F72D6D5A4d3f1c7a1d0000e0-" +
    "161973"
  );
}

/*- Minimal positionMgr shape needed by both the handler AND
 *  resolveLiveKey.  `get(key)` is the fast-path used by resolveLiveKey;
 *  `getPosition(key)` is our own fallback when the bot state is
 *  absent.  Both return the mock position so the handler always
 *  resolves to a valid pool identity in tests. */
function _mockPositionMgr(overrides) {
  return {
    get: () => ({ key: _mockKey() }),
    getPosition: () => _mockPosition(),
    getAll: () => [],
    ...overrides,
  };
}

function _mockDeps(overrides) {
  const responses = [];
  const deps = {
    jsonResponse: (_res, code, body) => responses.push({ code, body }),
    readJsonBody: async () => overrides?.body || { positionKey: _mockKey() },
    getAllPositionBotStates: () => overrides?.states || new Map(),
    positionMgr: overrides?.positionMgr || _mockPositionMgr(),
    walletManager: {
      getAddress: () => "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A",
    },
    /*- Shared in-memory disk config — the handler mutates it in place
     *  so the bot loop's `readConfigValue` sees the clears immediately.
     *  Overridable so tests can seed / assert against the object. */
    diskConfig: overrides?.diskConfig || { global: {}, positions: {} },
  };
  return { deps, responses };
}

// ── Handler shape ───────────────────────────────────────────────────

describe("createReloadPositionHandler", () => {
  it("returns a function", () => {
    const { deps } = _mockDeps();
    const h = createReloadPositionHandler(deps);
    assert.strictEqual(typeof h, "function");
  });
});

// ── Bad-request paths ───────────────────────────────────────────────

describe("POST /api/position/reload — validation", () => {
  it("rejects missing positionKey with 400", async () => {
    const { deps, responses } = _mockDeps({ body: {} });
    const h = createReloadPositionHandler(deps);
    await h({}, {});
    assert.strictEqual(responses[0].code, 400);
    assert.strictEqual(responses[0].body.ok, false);
    assert.match(responses[0].body.error, /positionKey/);
  });

  it("rejects invalid positionKey format with 400", async () => {
    const { deps, responses } = _mockDeps({
      body: { positionKey: "not-a-composite-key" },
    });
    const h = createReloadPositionHandler(deps);
    await h({}, {});
    assert.strictEqual(responses[0].code, 400);
  });
});

// ── In-progress guard (409) ─────────────────────────────────────────

describe("POST /api/position/reload — in-progress guard", () => {
  it("returns 409 scan-in-progress when state._scanRunning", async () => {
    const key = _mockKey();
    const state = {
      activePosition: _mockPosition(),
      _scanRunning: true,
    };
    const states = new Map([[key, state]]);
    const { deps, responses } = _mockDeps({ states });
    const h = createReloadPositionHandler(deps);
    await h({}, {});
    assert.strictEqual(responses[0].code, 409);
    assert.strictEqual(responses[0].body.error, "scan-in-progress");
    assert.match(responses[0].body.message, /already running/);
  });

  it("returns 409 server-stopping once the server holds a stop", async () => {
    /*-
     *  The held stop waits for the scans running (src/lib/stop-when-all-clear.js):
     *  a Reload's scan started then would be cut off, or hold the stop.
     */
    const key = _mockKey();
    const states = new Map([[key, { activePosition: _mockPosition() }]]);
    const { deps, responses } = _mockDeps({ states });
    markStopping();
    try {
      await createReloadPositionHandler(deps)({}, {});
    } finally {
      _resetAppPhaseForTests();
    }
    assert.strictEqual(responses[0].code, 409);
    assert.strictEqual(responses[0].body.error, "server-stopping");
    assert.match(responses[0].body.message, /server is stopping/);
  });

  /*-
   *  A coin move counts from the poll's first gate, before the Guard, the
   *  gas check and the wait for the rebalance lock, after which the move
   *  raises rebalanceInProgress or compoundInProgress; and while a
   *  Rebalance Now or Compound Now waits to be made (src/lib/scan-state.js).
   */
  const COIN_MOVE_WORDS =
    "A coin move (rebalance or compound) for this position has already started. Try again once it's complete.";
  const moveStates = {
    "a poll decides or makes a rebalance or compound": { _moveInitiations: 1 },
    "a Rebalance Now waits to be made": { forceRebalance: true },
    "a Compound Now waits to be made": { forceCompound: true },
  };
  for (const [when, flags] of Object.entries(moveStates)) {
    it(`returns 409 coin-move-under-way while ${when}`, async () => {
      const key = _mockKey();
      const state = { activePosition: _mockPosition(), ...flags };
      const states = new Map([[key, state]]);
      const { deps, responses } = _mockDeps({ states });
      await createReloadPositionHandler(deps)({}, {});
      assert.strictEqual(responses[0].code, 409);
      assert.strictEqual(responses[0].body.ok, false);
      assert.strictEqual(responses[0].body.error, "coin-move-under-way");
      assert.strictEqual(responses[0].body.message, COIN_MOVE_WORDS);
      assert.strictEqual(state._needsFullRescan, undefined, "nothing reset");
    });
  }

  it("lets a reset through when no coin move is under way", () => {
    assert.strictEqual(_checkInProgress({}), null);
    /*- The residual cleanup's rebalance is an automatic move, decided at
     *  each poll; while the throttle holds it back it is not under way. */
    assert.strictEqual(
      _checkInProgress({
        forceRebalance: true,
        residualCleanupInProgress: true,
      }),
      null,
    );
  });
});

// ── Clear-list invariant ────────────────────────────────────────────

describe("CHAIN_DERIVED_POSITION_KEYS", () => {
  it("covers every on-chain-derived key documented in engineering.md", () => {
    /*- The clear-list is the invariant the reload flow depends on:
     *  every value that could survive a reload and re-corrupt the
     *  fresh scan must be here.  Guarded so future additions to the
     *  disk config get a matching test-failure. */
    /*-
     *  Not `compoundHistory`: the rebuild replaces it whole, keeping the
     *  trigger and the Activity Log figures the bot recorded live in it,
     *  so it needs the old list in place until then.
     */
    const expected = [
      "compoundedAmount0",
      "compoundedAmount1",
      "nftCompoundedAmountsByTokenId",
      "nftGasWeiByTokenId",
      "hodlBaseline",
      "lifetimeHodlAmounts",
      "totalLifetimeDepositUsd",
      /*-
       *  Travels with the deposit total. Left behind, it would mislabel
       *  the freshly rebuilt deposit as fallback-priced.
       */
      "depositUsedFallback",
    ];
    assert.deepStrictEqual(
      [...CHAIN_DERIVED_POSITION_KEYS].sort(),
      expected.sort(),
    );
  });
});

// ── _resetBotState ──────────────────────────────────────────────────

describe("_resetBotState", () => {
  it("clears every on-chain-derived field but the compound list, and stamps _needsFullRescan", () => {
    const state = {
      _catastrophicScanError: { message: "boom" },
      _lifetimeScanError: "prior err",
      _lifetimeScanErrorAt: 12345,
      _needsFullRescan: false,
      lifetimeScanComplete: true,
      rebalanceScanComplete: true,
      totalLifetimeDepositUsd: 999.99,
      depositUsedFallback: true,
      compoundHistory: [{ tokenId: "1" }],
      compoundedAmount0: 100,
      compoundedAmount1: 50,
      nftCompoundedAmountsByTokenId: { 1: { amount0: 42, amount1: 0 } },
      nftGasWeiByTokenId: { 1: "abc" },
      hodlBaseline: { mintDate: "2026-01-01" },
      lifetimeHodlAmounts: { amount0: 1, amount1: 2 },
      /*- Fields that should NOT be touched (settings, not on-chain-derived). */
      slippagePctToken0: 0.75,
      autoCompoundEnabled: true,
    };
    _resetBotState(state);
    assert.strictEqual(state._catastrophicScanError, null);
    assert.strictEqual(state._lifetimeScanError, null);
    assert.strictEqual(state._lifetimeScanErrorAt, null);
    assert.strictEqual(state._needsFullRescan, true);
    /*- Raised alongside it, and not the same request. "Recompute the saved
     *  figures" is what a rebalance also asks for; "re-value them at fresh
     *  prices" is what only a repair asks for. One stored figure reads the
     *  second — the first deposit's leftover, written once and returned
     *  ever after — so Reload has to raise it or that figure is the one
     *  thing a reload leaves alone. */
    assert.strictEqual(
      state._needsPriceRevalue,
      true,
      "Reload must ask for fresh prices, not only a recompute",
    );
    assert.strictEqual(state.lifetimeScanComplete, false);
    assert.strictEqual(state.rebalanceScanComplete, false);
    assert.strictEqual(state.totalLifetimeDepositUsd, 0);
    assert.strictEqual(state.depositUsedFallback, false);
    /*-
     *  Kept for the rebuild to replace, so a compound's Auto or Manual
     *  and its Activity Log figures survive the reload.
     */
    assert.deepStrictEqual(state.compoundHistory, [{ tokenId: "1" }]);
    /*- Null, not zero: `hasCompoundedTotal` reads these by presence, so a
     *  zero would claim the chain was classified and found nothing —
     *  the opposite of what a reload asks for. */
    assert.strictEqual(state.compoundedAmount0, null);
    assert.strictEqual(state.compoundedAmount1, null);
    assert.deepStrictEqual(state.nftCompoundedAmountsByTokenId, {});
    assert.deepStrictEqual(state.nftGasWeiByTokenId, {});
    assert.strictEqual(state.hodlBaseline, null);
    assert.strictEqual(state.lifetimeHodlAmounts, null);
    /*- Settings preserved. */
    assert.strictEqual(state.slippagePctToken0, 0.75);
    assert.strictEqual(state.autoCompoundEnabled, true);
  });

  it("drops the deposit count's interim count and the wallet reading it compared", () => {
    /*-
     *  Both describe the results the reload clears. With them gone, the
     *  first poll after the rebuild counts the deposits since the current
     *  NFT's mint again, as a first poll after a start does.
     */
    const state = {
      _depositOverlay: { through: 400, entries: [{ txHash: "0xa" }] },
      _depositWalletSeen: { raw0: 1n, raw1: 2n },
    };
    _resetBotState(state);
    assert.strictEqual(state._depositOverlay, null);
    assert.strictEqual(state._depositWalletSeen, null);
  });
});

// ── Any chain ───────────────────────────────────────────────────────

describe("POST /api/position/reload — on a chain other than PulseChain", () => {
  it("clears the epoch-cache entry the bot wrote, keyed by that chain", async () => {
    /*-
     *  The cache file is redirected so the operator's is never touched,
     *  and the active chain is switched for this case alone. The entry
     *  is written the way the bot's own persist path writes it, with no
     *  chain of its own: the epoch cache supplies the active one.
     */
    const cachePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "lp-ranger-reload-")),
      "pnl-epochs-cache.json",
    );
    epochCache._setCachePath(cachePath);
    const wallet = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
    const pos = _mockPosition();
    const savedChain = config.CHAIN_NAME;
    config.CHAIN_NAME = "pulsechain-testnet";
    try {
      const key = `pulsechain-testnet-${wallet}-${config.POSITION_MANAGER}-${pos.tokenId}`;
      const written = {
        contract: config.POSITION_MANAGER,
        wallet,
        token0: pos.token0,
        token1: pos.token1,
        fee: pos.fee,
      };
      epochCache.setCachedEpochs(written, {
        closedEpochs: [{ id: 1 }],
        liveEpoch: null,
      });
      const onDisk = Object.keys(JSON.parse(fs.readFileSync(cachePath)));
      assert.deepStrictEqual(
        onDisk.map((k) => k.split(".")[0]),
        ["pulsechain-testnet"],
        "the entry is keyed by the active chain",
      );
      const { deps, responses } = _mockDeps({
        body: { positionKey: key },
        states: new Map([[key, { activePosition: pos }]]),
        positionMgr: _mockPositionMgr({ get: (k) => ({ key: k }) }),
      });
      await createReloadPositionHandler(deps)({}, {});
      assert.strictEqual(responses[0].code, 200, JSON.stringify(responses));
      assert.strictEqual(epochCache.getCachedEpochs(written), null);
    } finally {
      /*-
       *  Reload also empties the pool's event cache, which leaves an
       *  empty file for this made-up pool under tmp/.
       */
      fs.rmSync(
        eventCachePath(pos, config.CHAIN_NAME, config.POSITION_MANAGER, wallet),
        { force: true },
      );
      config.CHAIN_NAME = savedChain;
    }
  });
});

// Guard tmp-dir cleanup — swallow any leftover fixtures.
process.on("exit", () => {
  try {
    const base = path.join(os.tmpdir(), "lp-ranger-reload-");
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith("lp-ranger-reload-")) {
        fs.rmSync(path.join(os.tmpdir(), name), {
          recursive: true,
          force: true,
        });
      }
    }
    void base;
  } catch {
    /* ignore */
  }
});
