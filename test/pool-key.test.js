"use strict";

/**
 * @file test/pool-key.test.js
 * @description Tests for `src/pool-key.js`, the one definition of
 *   "these two positions are in the same pool".
 *
 *   The point of the module is that BOTH tiers decide with it — the
 *   server when it accepts or refuses a Manage request, the dashboard
 *   when it offers or withholds the button. So the tests pin the
 *   normalisation itself, that the server's scoped key is built from
 *   it, and that the file stays importable from the browser bundle.
 */

require("global-jsdom/register");

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { poolPairKey, poolKey } = require("../src/pool-key");
const { createPositionManager } = require("../src/position-manager");

const A = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const B = "0x57fde0a71132198BBeC939B98976993d8D89D225";
const C = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab";

let _poolKeyOf;
let _poolHeldBy;
before(async () => {
  const mod = await import("../public/dashboard-manage-ui.js");
  _poolKeyOf = mod._poolKeyOf;
  _poolHeldBy = mod._poolHeldBy;
});

test("token order does not change the key", () => {
  assert.equal(poolPairKey(A, B, 2500), poolPairKey(B, A, 2500));
});

test("address casing does not change the key", () => {
  assert.equal(
    poolPairKey(A, B, 2500),
    poolPairKey(A.toLowerCase(), B.toUpperCase(), 2500),
  );
});

test("a different pair or fee tier is a different pool", () => {
  assert.notEqual(poolPairKey(A, B, 2500), poolPairKey(A, C, 2500));
  assert.notEqual(poolPairKey(A, B, 2500), poolPairKey(A, B, 10000));
});

test("numeric and string fee agree", () => {
  assert.equal(poolPairKey(A, B, 2500), poolPairKey(A, B, "2500"));
});

test("the server's scoped key is built from this one", () => {
  /*- The whole reason the module exists. If `poolKey` ever stops
   *  delegating, the two tiers can disagree about what one pool is
   *  while every other test stays green. */
  const pm = createPositionManager({ rebalanceLock: null });
  const scoped = pm.poolKey("pulsechain", "0xCC05", "0xWALLET", A, B, 2500);
  assert.equal(
    scoped.endsWith(poolPairKey(A, B, 2500)),
    true,
    "scoped key must end with the shared pair key: " + scoped,
  );
  /*- And the scoping is lower-cased too, so one wallet written two
   *  ways is one scope. */
  assert.equal(
    scoped,
    pm.poolKey("PulseChain", "0xcc05", "0xwallet", B, A, 2500),
  );
});

test("the module stays importable from the browser bundle", () => {
  /*- It is dependency-free on purpose: esbuild bundles it into
   *  public/dist/bundle.js, and a single `require` of anything
   *  Node-only would break that build. Guarding the constraint here
   *  rather than waiting for a build failure, because the failure
   *  would surface as a broken dashboard, not a failing test. */
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "pool-key.js"),
    "utf8",
  );
  const requires = src.match(/\brequire\s*\(/g) || [];
  assert.deepEqual(requires, [], "src/pool-key.js must import nothing");
  const imports = src.match(/^\s*import\s/gm) || [];
  assert.deepEqual(imports, [], "src/pool-key.js must import nothing");
});

// ── Cross-tier agreement ─────────────────────────────────────────────

test("the key the server publishes equals the key the client builds", () => {
  /*- `attachPoolKeys` (src/server-positions.js) stamps `poolKey` onto
   *  every managed entry in GET /api/status, and `_poolHeldBy` compares
   *  the active position's client-built key against it. If the two
   *  spellings ever diverge, nothing throws — the comparison simply
   *  never matches, and the "pool already managed" gate goes quiet with
   *  every other test still green. This pins the agreement. */
  const CHAIN = "pulsechain";
  const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
  const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";

  /*- Exactly the call attachPoolKeys makes. */
  const serverSide = poolKey(CHAIN, PM, WALLET, A, B, 2500);

  /*- Exactly what _poolKeyOf receives from posStore: note the client
   *  reads the pair in whatever order the scan returned it. */
  const clientSide = _poolKeyOf({
    walletAddress: WALLET,
    contractAddress: PM,
    token0: B,
    token1: A,
    fee: 2500,
  });

  assert.equal(clientSide, serverSide);
});

test("_poolHeldBy finds the running position holding the active pool", () => {
  const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
  const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
  const active = {
    tokenId: "222",
    walletAddress: WALLET,
    contractAddress: PM,
    token0: A,
    token1: B,
    fee: 2500,
  };
  const states = {
    "pulsechain-w-c-111": {
      running: true,
      poolKey: poolKey("pulsechain", PM, WALLET, A, B, 2500),
      activePosition: { tokenId: "111" },
    },
  };
  assert.equal(_poolHeldBy(active, states), "111");
});

test("_poolHeldBy ignores a stopped position and a different pool", () => {
  const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
  const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
  const active = {
    tokenId: "222",
    walletAddress: WALLET,
    contractAddress: PM,
    token0: A,
    token1: B,
    fee: 2500,
  };
  const stopped = {
    running: false,
    poolKey: poolKey("pulsechain", PM, WALLET, A, B, 2500),
    activePosition: { tokenId: "111" },
  };
  const otherPool = {
    running: true,
    poolKey: poolKey("pulsechain", PM, WALLET, A, C, 2500),
    activePosition: { tokenId: "333" },
  };
  assert.equal(_poolHeldBy(active, { a: stopped, b: otherPool }), null);
});

test("_poolHeldBy does not report the active position against itself", () => {
  /*- A managed position holds its own pool. Reporting it would replace
   *  its "Stop Managing" button with a disabled "Manage". */
  const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
  const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
  const active = {
    tokenId: "111",
    walletAddress: WALLET,
    contractAddress: PM,
    token0: A,
    token1: B,
    fee: 2500,
  };
  const states = {
    k: {
      running: true,
      poolKey: poolKey("pulsechain", PM, WALLET, A, B, 2500),
      activePosition: { tokenId: "111" },
    },
  };
  assert.equal(_poolHeldBy(active, states), null);
});

test("_poolHeldBy is inert when the server published no key", () => {
  /*- attachPoolKeys skips entries without activePosition or wallet, so
   *  poolKey can be absent. Absent must not match. */
  const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
  const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
  const active = {
    tokenId: "222",
    walletAddress: WALLET,
    contractAddress: PM,
    token0: A,
    token1: B,
    fee: 2500,
  };
  const states = { k: { running: true, activePosition: { tokenId: "111" } } };
  assert.equal(_poolHeldBy(active, states), null);
});
