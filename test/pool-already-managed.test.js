"use strict";

/**
 * @file test/pool-already-managed.test.js
 * @description Tests for the one-active-position-per-pool decision in
 *   `src/lib/pool-already-managed.js`.
 *
 *   The rule exists for attribution: two positions open in the same pool
 *   hold indistinguishable tokens in the same wallet, so gains moving
 *   between them cannot be assigned to either, and residual coins cannot
 *   be allocated. These tests pin the decision itself; `handleManage`
 *   and auto-start are the two callers that act on it.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");
const ethers = require("ethers");
const { captureWarnings } = require("./helpers/capture-warnings");

const {
  poolKeyOf,
  findPoolConflict,
  rejectIfPoolManaged,
  poolHoldersForStartUp,
  readPoolOfPosition,
} = require("../src/lib/pool-already-managed");
const { PM_ABI } = require("../src/lib/pm-abi");

const A = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const B = "0x57fde0a71132198BBeC939B98976993d8D89D225";
const C = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab";
const WALLET = "0x1111111111111111111111111111111111111111";

/*- The app's canonical pool-key builder, bound to a fixed
 *  chain/contract/wallet the way the server binds it.  Taken from the
 *  real module so these tests break if that rule ever changes, rather
 *  than passing against a private copy. */
const { createPositionManager } = require("../src/lib/position-manager");
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

  /** ethers stub whose positions() returns the given pool, open. */
  function libFor(pool) {
    return {
      Contract: class {
        async positions() {
          if (pool === null) throw new Error("rpc down");
          return { ...pool, liquidity: 5000n };
        }
      },
    };
  }

  function harness({ pool, states, selfKey }) {
    const sent = [];
    const logged = [];
    const claimed = [];
    return {
      sent,
      logged,
      claimed,
      args: {
        claimPool: (pk) => claimed.push(pk),
        res: {},
        jsonResponse: (_res, status, payload) => sent.push({ status, payload }),
        log: (...a) => logged.push(a),
        key: selfKey ?? "chain-w-c-999",
        tokenId: "999",
        chain: "pulsechain",
        wallet: WALLET,
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
  });

  it("logs what it refused and why, then what the operator can do", async () => {
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    const h = harness({ pool: POOL, states });
    await rejectIfPoolManaged(h.args);
    const lines = h.logged.map((a) => format(...a));
    assert.equal(lines.length, 2);
    // The position as a move's log names it: chain, wallet, NFT, coins, fee.
    assert.match(
      lines[0],
      /Manage refused: pulsechain 0x1111.* #999 .*\/.* 0\.25%: /,
    );
    assert.match(lines[0], /NFT #111 .* is already managed in this pool/);
    assert.match(lines[0], /one active position per pool/);
    assert.match(
      lines[1],
      /To manage NFT #999 .* instead, stop managing NFT #111 .* first/,
    );
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

  it("refuses, claiming nothing, when the pool cannot be read", async () => {
    /*-
     *  One active position per pool, with no exception: a pool that
     *  cannot be read cannot be shown free, and the position managing
     *  it here is in the very pool the read would have named. The code
     *  is the one the dashboard shows as "click Manage again".
     */
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    const h = harness({ pool: null, states });
    const warned = captureWarnings();
    let refused;
    try {
      refused = await rejectIfPoolManaged(h.args);
    } finally {
      warned.restore();
    }
    assert.equal(refused, true);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].status, 503);
    assert.equal(h.sent[0].payload.error, "pool-info-unavailable");
    assert.match(h.sent[0].payload.message, /pool of NFT #999/);
    assert.equal(h.sent[0].payload.positionKey, "chain-w-c-999");
    assert.deepEqual(h.claimed, []);
    // The chain's own error, then what was refused, then what to do.
    assert.match(
      warned.lines.join("\n"),
      /Could not read the pool of NFT #999 .* from the chain: rpc down/,
    );
    const lines = h.logged.map((a) => format(...a));
    assert.match(
      lines[0],
      /Manage refused: pulsechain 0x1111.* #999 .*: its pool could not be read/,
    );
    assert.match(
      lines[1],
      /Nothing was started for NFT #999 .*; click Manage again/,
    );
  });

  it("claims the pool it lets through", async () => {
    const h = harness({ pool: POOL, states: new Map() });
    assert.equal(await rejectIfPoolManaged(h.args), false);
    assert.deepEqual(h.claimed, [poolKeyFn(A, B, 2500)]);
  });
});

describe("rejectIfPoolManaged() for a re-open", () => {
  /*-
   *  A closed position's Manage re-opens it, minting a new position in
   *  its pool, so it is refused while the wallet holds an open one there.
   */
  const POOL = { token0: A, token1: B, fee: 2500 };

  /**
   * The gate over a position with `liquidity`, in a wallet whose open
   * position in the pool, if any, `openInPool` answers.
   */
  function reopen({ liquidity, open = null, states = new Map() }) {
    const sent = [];
    const asked = [];
    const logged = [];
    const args = {
      res: {},
      jsonResponse: (_res, status, payload) => sent.push({ status, payload }),
      log: (...a) => logged.push(format(...a)),
      key: "chain-w-c-999",
      tokenId: "999",
      chain: "pulsechain",
      wallet: WALLET,
      positionManager: "0xPM",
      botStates: states,
      provider: {},
      ethersLib: {
        Contract: class {
          async positions() {
            return { ...POOL, liquidity };
          }
        },
      },
      poolKeyFn,
      openInPool: async (pool) => {
        asked.push(pool);
        return open;
      },
    };
    return { args, sent, asked, logged };
  }

  it("refuses to re-open a closed position while the wallet holds an open one in its pool", async () => {
    const g = reopen({ liquidity: 0n, open: "222" });
    assert.equal(await rejectIfPoolManaged(g.args), true);
    assert.equal(g.sent[0].status, 409);
    assert.equal(g.sent[0].payload.error, "pool-has-open-position");
    assert.equal(g.sent[0].payload.openTokenId, "222");
    assert.equal(g.sent[0].payload.positionKey, "chain-w-c-999");
    // What was refused and why, then what the operator can do.
    assert.equal(g.logged.length, 2);
    assert.match(
      g.logged[0],
      /Manage refused: pulsechain .* #999 .*: NFT #999 is closed/,
    );
    assert.match(
      g.logged[0],
      /where the wallet already holds open position NFT #222 /,
    );
    assert.match(g.logged[1], /Manage NFT #222 .* instead, or close it first/);
  });

  it("re-opens a closed position whose pool holds no open one", async () => {
    const g = reopen({ liquidity: 0n, open: null });
    assert.equal(await rejectIfPoolManaged(g.args), false);
    assert.equal(g.sent.length, 0);
  });

  it("does not ask about open positions when the position is itself open", async () => {
    const g = reopen({ liquidity: 5000n, open: "222" });
    assert.equal(await rejectIfPoolManaged(g.args), false);
    assert.equal(g.asked.length, 0);
  });

  it("names the managed position, when one holds the pool", async () => {
    const states = new Map([["chain-w-c-111", running("111", A, B, 2500)]]);
    const g = reopen({ liquidity: 0n, open: "111", states });
    assert.equal(await rejectIfPoolManaged(g.args), true);
    assert.equal(g.sent[0].payload.error, "pool-already-managed");
    assert.equal(g.sent[0].payload.conflictTokenId, "111");
  });
});

describe("poolHoldersForStartUp()", () => {
  /*-
   *  Each pool keeps one of the positions saved as managed: its open one,
   *  wherever it stands in the list, else the first listed. The answer
   *  names, for each other saved position in that pool, the one kept.
   */
  const pool = (liquidity, tokens = [A, B], fee = 2500) => ({
    token0: tokens[0],
    token1: tokens[1],
    fee,
    liquidity,
  });
  const saved = (tokenId, p) => ({
    key: `chain-w-c-${tokenId}`,
    tokenId,
    pool: p,
    poolKey: poolKeyOf(p, poolKeyFn),
  });
  const decide = (...listed) =>
    Object.fromEntries(poolHoldersForStartUp(listed));

  it("keeps a pool for its open position, wherever it stands in the list", () => {
    assert.deepEqual(decide(saved("111", pool(0n)), saved("222", pool(5n))), {
      "chain-w-c-111": "222",
    });
  });

  it("keeps a pool with no open position for the first listed", () => {
    assert.deepEqual(decide(saved("111", pool(0n)), saved("222", pool(0n))), {
      "chain-w-c-222": "111",
    });
  });

  it("keeps a pool with two open positions for the first listed", () => {
    assert.deepEqual(decide(saved("111", pool(7n)), saved("222", pool(5n))), {
      "chain-w-c-222": "111",
    });
  });

  it("keeps every position alone in its pool", () => {
    assert.deepEqual(
      decide(
        saved("111", pool(5n)),
        saved("222", pool(5n, [A, C])),
        saved("333", pool(5n, [A, B], 10000)),
      ),
      {},
    );
  });

  it("matches a pool regardless of the order the tokens come back in", () => {
    assert.deepEqual(
      decide(saved("111", pool(5n)), saved("222", pool(0n, [B, A]))),
      { "chain-w-c-222": "111" },
    );
  });
});

describe("readPoolOfPosition() with the real ethers decoder", () => {
  /*-
   *  The pool and liquidity are read by name from the position manager's
   *  answer. Through ethers itself rather than a stand-in, since a
   *  stand-in that hands back named fields passes whatever interface the
   *  module declares, and an interface with unnamed outputs leaves every
   *  name undefined, so no pool would ever be recognised.
   */
  it("reads the pool and its liquidity from an answer ethers decodes", async () => {
    const iface = new ethers.Interface(PM_ABI);
    const answer = iface.encodeFunctionResult("positions", [
      0n,
      ethers.ZeroAddress,
      A,
      B,
      2500n,
      -100n,
      100n,
      5000n,
      0n,
      0n,
      0n,
      0n,
    ]);
    const pool = await readPoolOfPosition({
      provider: { call: async () => answer },
      ethersLib: ethers,
      positionManager: "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      tokenId: "111",
    });
    assert.deepEqual(pool, {
      token0: A,
      token1: B,
      fee: 2500,
      liquidity: 5000n,
    });
  });
});
