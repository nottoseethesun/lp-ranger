/**
 * @file test/handle-manage-pool-gate.test.js
 * @description End-to-end coverage for the one-position-per-pool gate as
 *   the operator meets it: a `POST /api/position/manage` for a second
 *   position in a pool that already has a running one.
 *
 *   `test/pool-already-managed.test.js` pins the decision itself. This
 *   file pins the wiring — that `handleManage` consults it, refuses
 *   before anything starts, and leaves nothing behind.
 *
 *   Helpers mirror `test/handle-manage-pool-state-err.test.js`, which
 *   duplicates them from `test/server-positions.test.js` on purpose so
 *   each file stays independently runnable.
 */

"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("assert");
const {
  createPositionRoutes,
  getAllPositionBotStates,
} = require("../src/server-positions");
const { compositeKey } = require("../src/bot-config-v2");

const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const A = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const B = "0x57fde0a71132198BBeC939B98976993d8D89D225";
const C = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab";
const POOL = { token0: A, token1: B, fee: 2500 };
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

// ── Helpers ────────────────────────────────────────────────────────────

function makeRes() {
  return { _status: null, _body: null };
}

/** ethers stub whose positions() always returns `pool`. */
function libFor(pool) {
  return {
    Contract: class {
      async positions() {
        return { token0: pool.token0, token1: pool.token1, fee: pool.fee };
      }
    },
  };
}

function makePositionMgr(started, overrides = {}) {
  return {
    runningCount: () => 0,
    count: () => 0,
    stopAll: async () => {},
    startPosition: async (key) => {
      started.push(key);
    },
    removePosition: async () => {},
    get: () => null,
    getAll: () => [],
    migrateKey: () => {},
    getRebalanceLock: () => ({ acquire: async () => () => {} }),
    getScanLock: () => ({ acquire: async () => () => {} }),
    /*- The real canonical builder's shape: lower-cased, pair-sorted,
     *  fee-suffixed.  A constant here would make every pool compare
     *  equal and the gate would look like it worked for the wrong
     *  reason. */
    poolKey: (chain, contract, wallet, t0, t1, fee) => {
      const x = String(t0).toLowerCase();
      const y = String(t1).toLowerCase();
      const pair = x < y ? `${x}-${y}` : `${y}-${x}`;
      return `${chain}.${contract}.${wallet}.${pair}.${fee}`.toLowerCase();
    },
    canRebalancePool: () => true,
    recordPoolRebalance: () => {},
    getSharedSigner: async () => ({
      provider: {},
      signer: { getAddress: async () => WALLET },
      address: WALLET,
    }),
    ...overrides,
  };
}

function makeRouteDeps({ pool, tokenId, started, diskConfig, mgrOverrides }) {
  return {
    diskConfig,
    positionMgr: makePositionMgr(started, mgrOverrides || {}),
    walletManager: {
      getAddress: () => WALLET,
      getStatus: () => ({ loaded: true, address: WALLET }),
    },
    getPrivateKey: () => "0xpk123",
    jsonResponse: (res, status, body) => {
      res._status = status;
      res._body = body;
    },
    readJsonBody: async () => ({ tokenId, contract: PM }),
    ethersLib: libFor(pool),
    readProvider: () => ({}),
  };
}

/** Seed a running bot state for `tokenId` holding `pool`. */
function seedRunning(tokenId, pool) {
  const key = compositeKey("pulsechain", WALLET, PM, tokenId);
  getAllPositionBotStates().set(key, {
    running: true,
    activePosition: { tokenId, ...pool },
  });
  return key;
}

async function manage(opts) {
  const started = [];
  const diskConfig = { global: {}, positions: {} };
  const routes = createPositionRoutes(
    makeRouteDeps({ ...opts, started, diskConfig }),
  );
  const res = makeRes();
  await routes["POST /api/position/manage"]({}, res);
  return { res, started, diskConfig };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("handleManage one-position-per-pool gate", () => {
  afterEach(() => getAllPositionBotStates().clear());

  it("refuses a second position in a managed pool with 409", async () => {
    const held = seedRunning("111", POOL);
    const { res, started } = await manage({ pool: POOL, tokenId: "222" });

    assert.strictEqual(res._status, 409);
    assert.strictEqual(res._body.error, "pool-already-managed");
    assert.strictEqual(res._body.ok, false);
    /*- Naming the holder is the point: an operator who has just been
     *  refused needs to know which position to stop. */
    assert.strictEqual(res._body.conflictTokenId, "111");
    assert.strictEqual(res._body.conflictKey, held);
    /*- Refused BEFORE anything starts — no bot loop, no disk entry. */
    assert.deepStrictEqual(started, []);
  });

  it("leaves no disk entry or in-memory state for the refused position", async () => {
    seedRunning("111", POOL);
    const { diskConfig } = await manage({ pool: POOL, tokenId: "222" });

    assert.deepStrictEqual(Object.keys(diskConfig.positions), []);
    const leaked = [...getAllPositionBotStates().keys()].filter((k) =>
      k.endsWith("-222"),
    );
    assert.deepStrictEqual(leaked, []);
  });

  it("allows a position in a different pool", async () => {
    seedRunning("111", POOL);
    const other = { token0: A, token1: C, fee: 2500 };
    const { res, started } = await manage({ pool: other, tokenId: "222" });

    assert.notStrictEqual(res._status, 409);
    assert.strictEqual(started.length, 1);
  });

  it("allows the same pair at a different fee tier", async () => {
    /*- A different fee tier is a different pool with its own liquidity,
     *  so P&L stays attributable and the rule does not apply. */
    seedRunning("111", POOL);
    const { res, started } = await manage({
      pool: { token0: A, token1: B, fee: 10000 },
      tokenId: "222",
    });

    assert.notStrictEqual(res._status, 409);
    assert.strictEqual(started.length, 1);
  });

  it("allows when the only position in the pool is STOPPED", async () => {
    /*- A stopped position keeps its config for history but does not hold
     *  the pool — this is how an operator hands a pool over. */
    getAllPositionBotStates().set(
      compositeKey("pulsechain", WALLET, PM, "111"),
      {
        running: false,
        activePosition: { tokenId: "111", ...POOL },
      },
    );
    const { res, started } = await manage({ pool: POOL, tokenId: "222" });

    assert.notStrictEqual(res._status, 409);
    assert.strictEqual(started.length, 1);
  });

  it("does not refuse a position against its own running state", async () => {
    /*- The rebalance path: a rebalance mints a new tokenId and migrates
     *  the key within the same pool.  Were selfKey not excluded, every
     *  rebalance would be refused by the position doing it. */
    seedRunning("111", POOL);
    const { res, started } = await manage({ pool: POOL, tokenId: "111" });

    assert.notStrictEqual(res._status, 409);
    assert.strictEqual(started.length, 1);
  });
});

describe("handleManage concurrent starts in one pool", () => {
  afterEach(() => getAllPositionBotStates().clear());

  it("refuses the second of two simultaneous starts in the same pool", async () => {
    /*- The window this closes: `state.running` is not set until the bot
     *  loop is up, which takes seconds of RPC work. A gate that reads
     *  only the running states is therefore open for that whole time,
     *  so two Manage requests for DIFFERENT tokenIds in one pool — the
     *  exact case the rule exists for — both find no conflict and both
     *  start. Neither is "already running" when the other is checked.
     *
     *  Both requests are launched before either is awaited, so they
     *  interleave at the on-chain pool read the way two HTTP requests
     *  would. */
    const started = [];
    const diskConfig = { global: {}, positions: {} };
    const mk = (tokenId) =>
      createPositionRoutes(
        makeRouteDeps({ pool: POOL, tokenId, started, diskConfig }),
      )["POST /api/position/manage"];

    const resA = makeRes();
    const resB = makeRes();
    /*- `startPosition` never resolves for the winner, standing in for a
     *  slow startup — the loser must still be refused meanwhile. */
    await Promise.all([mk("111")({}, resA), mk("222")({}, resB)]);

    const codes = [resA._status, resB._status].sort();
    assert.deepStrictEqual(
      codes,
      [200, 409],
      "exactly one start should win; got " + JSON.stringify(codes),
    );
    assert.strictEqual(
      started.length,
      1,
      "only one bot loop may start for a pool",
    );
    const refused = resA._status === 409 ? resA : resB;
    assert.strictEqual(refused._body.error, "pool-already-managed");
  });

  it("still allows two simultaneous starts in DIFFERENT pools", async () => {
    /*- The claim must be per pool, not a blanket single-flight. */
    const started = [];
    const diskConfig = { global: {}, positions: {} };
    const other = { token0: A, token1: C, fee: 2500 };
    const resA = makeRes();
    const resB = makeRes();
    await Promise.all([
      createPositionRoutes(
        makeRouteDeps({ pool: POOL, tokenId: "111", started, diskConfig }),
      )["POST /api/position/manage"]({}, resA),
      createPositionRoutes(
        makeRouteDeps({ pool: other, tokenId: "222", started, diskConfig }),
      )["POST /api/position/manage"]({}, resB),
    ]);
    assert.notStrictEqual(resA._status, 409);
    assert.notStrictEqual(resB._status, 409);
    assert.strictEqual(started.length, 2);
  });
});

describe("handleManage releases the pool claim on failure", () => {
  afterEach(() => getAllPositionBotStates().clear());

  /** Run manage twice in sequence against the same deps-maker. */
  async function twice(mkDeps) {
    const first = makeRes();
    const second = makeRes();
    await createPositionRoutes(mkDeps())["POST /api/position/manage"](
      {},
      first,
    );
    await createPositionRoutes(mkDeps())["POST /api/position/manage"](
      {},
      second,
    );
    return { first, second };
  }

  it("a non-numeric liquidity does not strand the pool claim", async () => {
    /*- `liquidity` is client-supplied and reaches BigInt(). If it
     *  throws, the throw escapes between the pool claim and the
     *  try/finally that releases it, and the pool stays claimed until
     *  the process restarts — every later Manage for it refused. */
    const started = [];
    const mk = () => ({
      ...makeRouteDeps({
        pool: POOL,
        tokenId: "111",
        started,
        diskConfig: { global: {}, positions: {} },
      }),
      readJsonBody: async () => ({
        tokenId: "111",
        contract: PM,
        liquidity: "not-a-number",
      }),
    });
    const { first, second } = await twice(mk);
    assert.notStrictEqual(first._status, 500);
    assert.notStrictEqual(
      second._status,
      409,
      "second attempt must not be blocked by a stranded claim",
    );
  });

  it("a failing shared signer does not strand the pool claim", async () => {
    const started = [];
    const mk = () =>
      makeRouteDeps({
        pool: POOL,
        tokenId: "111",
        started,
        diskConfig: { global: {}, positions: {} },
        mgrOverrides: {
          getSharedSigner: async () => {
            throw new Error("signer unavailable");
          },
        },
      });
    const { second } = await twice(mk);
    assert.notStrictEqual(
      second._status,
      409,
      "a signer failure must release the pool, not hold it forever",
    );
  });
});
