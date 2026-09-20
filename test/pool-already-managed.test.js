"use strict";

/**
 * @file test/pool-already-managed.test.js
 * @description Tests for the one-active-position-per-pool decision in
 *   `src/pool-already-managed.js`.
 *
 *   The rule exists for attribution: two positions open in the same pool
 *   hold indistinguishable tokens in the same wallet, so gains moving
 *   between them cannot be assigned to either, and residual coins cannot
 *   be allocated. These tests pin the decision itself; `handleManage`
 *   and auto-start are the two callers that act on it.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  poolKeyOf,
  findPoolConflict,
  rejectIfPoolManaged,
  claimPoolForBoot,
} = require("../src/pool-already-managed");

const A = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const B = "0x57fde0a71132198BBeC939B98976993d8D89D225";
const C = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab";

/*- The app's canonical pool-key builder, bound to a fixed
 *  chain/contract/wallet the way the server binds it.  Taken from the
 *  real module so these tests break if that rule ever changes, rather
 *  than passing against a private copy. */
const { createPositionManager } = require("../src/position-manager");
const _pm = createPositionManager({ rebalanceLock: null });
const poolKeyFn = (t0, t1, fee) =>
  _pm.poolKey("pulsechain", "0xCC05", "0xW", t0, t1, fee);

/** Bot state shaped as `server-positions.js` builds it. */
function running(tokenId, token0, token1, fee) {
  return { running: true, activePosition: { tokenId, token0, token1, fee } };
}

describe("poolKeyOf()", () => {
  it("is case-insensitive on addresses", () => {
    assert.equal(
      poolKeyOf({ token0: A, token1: B, fee: 2500 }, poolKeyFn),
      poolKeyOf(
        {
          token0: A.toLowerCase(),
          token1: B.toLowerCase(),
          fee: 2500,
        },
        poolKeyFn,
      ),
    );
  });

  it("matches regardless of token order", () => {
    /*- The pool is the same whichever way round the caller holds the
     *  pair.  Relying on the caller's ordering would make the gate miss
     *  half its cases without failing visibly. */
    assert.equal(
      poolKeyOf({ token0: A, token1: B, fee: 2500 }, poolKeyFn),
      poolKeyOf({ token0: B, token1: A, fee: 2500 }, poolKeyFn),
    );
  });

  it("treats a different fee tier as a different pool", () => {
    assert.notEqual(
      poolKeyOf({ token0: A, token1: B, fee: 2500 }, poolKeyFn),
      poolKeyOf({ token0: A, token1: B, fee: 10000 }, poolKeyFn),
    );
  });

  it("accepts fee as a number or a string", () => {
    assert.equal(
      poolKeyOf({ token0: A, token1: B, fee: 2500 }, poolKeyFn),
      poolKeyOf({ token0: A, token1: B, fee: "2500" }, poolKeyFn),
    );
  });

  it("returns null for an incomplete identity", () => {
    /*- Two partial identities must never compare equal, which returning
     *  a shared sentinel string would allow. */
    assert.equal(poolKeyOf(null, poolKeyFn), null);
    assert.equal(poolKeyOf(undefined, poolKeyFn), null);
    assert.equal(poolKeyOf({}, poolKeyFn), null);
    assert.equal(poolKeyOf({ token0: A, fee: 2500 }, poolKeyFn), null);
    assert.equal(poolKeyOf({ token0: A, token1: B }, poolKeyFn), null);
    assert.equal(poolKeyOf({ token0: A, token1: B, fee: "" }, poolKeyFn), null);
  });
});

describe("findPoolConflict()", () => {
  const pool = { token0: A, token1: B, fee: 2500 };

  it("finds a running position in the same pool", () => {
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    const hit = findPoolConflict({ pool, botStates: states, poolKeyFn });
    assert.equal(hit.key, "chain-w-c-111");
    assert.equal(hit.tokenId, "111");
  });

  it("allows a pool with no running position", () => {
    assert.equal(
      findPoolConflict({ pool, botStates: new Map(), poolKeyFn }),
      null,
    );
  });

  it("ignores a STOPPED position in the same pool", () => {
    /*- A stopped position keeps its config for history. It does not hold
     *  the pool, so it must not block a different one being started. */
    const states = new Map([
      [
        "chain-w-c-111",
        { running: false, activePosition: { tokenId: "111", ...pool } },
      ],
    ]);
    assert.equal(
      findPoolConflict({ pool, botStates: states, poolKeyFn }),
      null,
    );
  });

  it("allows a different pool", () => {
    const states = new Map([["chain-w-c-111", running("111", A, C, 2500)]]);
    assert.equal(
      findPoolConflict({ pool, botStates: states, poolKeyFn }),
      null,
    );
  });

  it("allows the same pair at a different fee tier", () => {
    const states = new Map([["chain-w-c-111", running("111", A, B, 10000)]]);
    assert.equal(
      findPoolConflict({ pool, botStates: states, poolKeyFn }),
      null,
    );
  });

  it("excludes selfKey, so a rebalance cannot reject itself", () => {
    /*- A rebalance mints a new tokenId and migrates the key within the
     *  same pool. Without the exclusion the position would be rejected
     *  against its own running state, breaking every rebalance. */
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    assert.equal(
      findPoolConflict({
        pool,
        botStates: states,
        selfKey: "chain-w-c-111",
        poolKeyFn,
      }),
      null,
    );
  });

  it("accepts a plain object as well as a Map", () => {
    const states = { "chain-w-c-111": running("111", A, B, 2500) };
    assert.equal(
      findPoolConflict({ pool, botStates: states, poolKeyFn }).tokenId,
      "111",
    );
  });

  it("tolerates null states and missing activePosition", () => {
    const states = new Map([
      ["a", null],
      ["b", { running: true }],
      ["c", { running: true, activePosition: null }],
      ["d", running("222", A, B, 2500)],
    ]);
    assert.equal(
      findPoolConflict({ pool, botStates: states, poolKeyFn }).tokenId,
      "222",
    );
  });

  it("returns null when the incoming pool is not fully identified", () => {
    /*- Better to allow and let the normal path fail loudly than to
     *  reject on an identity we could not read. */
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    assert.equal(
      findPoolConflict({ pool: { token0: A }, botStates: states, poolKeyFn }),
      null,
    );
  });
});

describe("rejectIfPoolManaged()", () => {
  const POOL = { token0: A, token1: B, fee: 2500 };

  /** ethers stub whose positions() returns the given pool. */
  function libFor(pool) {
    return {
      Contract: class {
        async positions() {
          if (pool === null) throw new Error("rpc down");
          return { token0: pool.token0, token1: pool.token1, fee: pool.fee };
        }
      },
    };
  }

  function harness({ pool, states, selfKey }) {
    const sent = [];
    const logged = [];
    return {
      sent,
      logged,
      args: {
        res: {},
        jsonResponse: (_res, status, payload) => sent.push({ status, payload }),
        log: (...a) => logged.push(a),
        key: selfKey ?? "chain-w-c-999",
        tokenId: "999",
        positionManager: "0xPM",
        botStates: states,
        provider: {},
        ethersLib: libFor(pool),
        poolKeyFn,
      },
    };
  }

  it("refuses with 409 and names the position holding the pool", async () => {
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    const h = harness({ pool: POOL, states });
    assert.equal(await rejectIfPoolManaged(h.args), true);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].status, 409);
    assert.equal(h.sent[0].payload.error, "pool-already-managed");
    assert.equal(h.sent[0].payload.conflictTokenId, "111");
    assert.equal(h.sent[0].payload.conflictKey, "chain-w-c-111");
    assert.equal(h.logged.length, 1);
  });

  it("allows when the pool has no running position", async () => {
    const h = harness({ pool: POOL, states: new Map() });
    assert.equal(await rejectIfPoolManaged(h.args), false);
    assert.equal(h.sent.length, 0);
  });

  it("allows when the only position in the pool is stopped", async () => {
    const states = new Map([
      [
        "chain-w-c-111",
        { running: false, activePosition: { tokenId: "111", ...POOL } },
      ],
    ]);
    const h = harness({ pool: POOL, states });
    assert.equal(await rejectIfPoolManaged(h.args), false);
  });

  it("does not reject a position against itself (rebalance path)", async () => {
    /*- A rebalance mints a new tokenId and migrates the key within the
     *  same pool.  Were selfKey not excluded, every rebalance would be
     *  refused by its own running state. */
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    const h = harness({ pool: POOL, states, selfKey: "chain-w-c-111" });
    assert.equal(await rejectIfPoolManaged(h.args), false);
    assert.equal(h.sent.length, 0);
  });

  it("allows when the pool read fails, rather than refusing on unknown", async () => {
    /*- Refusing to manage because one RPC read hiccuped is worse than
     *  the duplicate this gate prevents: the duplicate is visible and
     *  the operator can stop one, whereas a spurious refusal blocks a
     *  legitimate action with no recourse.  The normal detection path
     *  fails loudly a moment later if the NFT really is unreadable. */
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    const h = harness({ pool: null, states });
    assert.equal(await rejectIfPoolManaged(h.args), false);
    assert.equal(h.sent.length, 0);
  });
});

describe("claimPoolForBoot()", () => {
  const POOL = { token0: A, token1: B, fee: 2500 };

  /** ethers stub returning a per-tokenId pool, or throwing for null. */
  function libFor(byToken) {
    return {
      Contract: class {
        async positions(id) {
          const p = byToken[String(id)];
          if (!p) throw new Error("rpc down");
          return { token0: p.token0, token1: p.token1, fee: p.fee };
        }
      },
    };
  }

  function boot(byToken) {
    const claimedPools = new Map();
    const logged = [];
    return {
      claimedPools,
      logged,
      claim: (tokenId) =>
        claimPoolForBoot({
          claimedPools,
          tokenId,
          provider: {},
          ethersLib: libFor(byToken),
          positionManager: "0xPM",
          poolKeyFn,
          log: (...a) => logged.push(a),
        }),
    };
  }

  it("starts the first position in a pool and skips the second", async () => {
    /*- The pre-existing-violation case: a config written before the rule
     *  was enforced holds two running positions in one pool. */
    const b = boot({ 111: POOL, 222: POOL });
    assert.equal(await b.claim("111"), true);
    assert.equal(await b.claim("222"), false);
  });

  it("names the winner when it skips, so the log is actionable", async () => {
    const b = boot({ 111: POOL, 222: POOL });
    await b.claim("111");
    await b.claim("222");
    assert.equal(b.logged.length, 1);
    const line = b.logged[0].join(" ");
    assert.match(line, /111/);
    assert.match(line, /222/);
  });

  it("starts every position when each is in its own pool", async () => {
    const b = boot({
      111: POOL,
      222: { token0: A, token1: C, fee: 2500 },
      333: { token0: A, token1: B, fee: 10000 },
    });
    assert.equal(await b.claim("111"), true);
    assert.equal(await b.claim("222"), true);
    assert.equal(await b.claim("333"), true);
    assert.equal(b.logged.length, 0);
  });

  it("starts a position whose pool cannot be read, and claims nothing", async () => {
    /*- An unreadable pool must neither block a later position nor be
     *  blocked by one: it is unknown, not conflicting.  Ownership was
     *  already verified by this point, so the NFT does exist. */
    const b = boot({ 222: POOL });
    assert.equal(await b.claim("111"), true);
    assert.equal(b.claimedPools.size, 0);
    assert.equal(await b.claim("222"), true);
  });

  it("matches a pool regardless of the order the tokens come back in", async () => {
    const b = boot({ 111: POOL, 222: { token0: B, token1: A, fee: 2500 } });
    assert.equal(await b.claim("111"), true);
    assert.equal(await b.claim("222"), false);
  });

  it("cannot persist anything — it takes no config dependency", () => {
    /*- Structural proof of "skip, not stop": the saved status is the
     *  operator's, and this function has no way to reach it.  If a
     *  config or save dependency is ever added here, this fails and the
     *  reasoning above gets re-read. */
    const params = claimPoolForBoot.toString();
    assert.equal(
      /saveConfig|diskConfig|removeManagedPosition/.test(params),
      false,
    );
  });
});
