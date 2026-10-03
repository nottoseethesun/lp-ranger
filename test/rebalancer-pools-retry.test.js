/**
 * @file test/rebalancer-pools-retry.test.js
 * @description Validation and retry coverage for `getPoolState` in
 *   `src/rebalancer-pools.js`.  Covers:
 *
 *   - `_getPoolStateOnce` throws `PoolStateInvalidError` on the first
 *     failing field (decimals0=NaN, tick=undefined, etc.)
 *   - A success on an early attempt returns the validated state
 *   - Spending the whole attempt budget throws
 *     `PoolStateUnavailableError`, carrying the most recent `cause` and
 *     the total attempt count
 *   - Every outcome is reported to the failover decider, which is what
 *     lets selection advance — the evidence being that it did
 *
 * Endpoints come from the app's failover rather than from anything
 * `getPoolState` keeps, so these tests stand that layer up with a
 * mocked ethersLib the way the app stands it up at boot.  Providers are
 * therefore built once per endpoint, not once per attempt, and the mock
 * returns Contract instances whose method behaviour each test scripts.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  _getPoolStateOnce,
  getPoolState,
  _setRetryDelayForTests,
  PoolStateInvalidError,
  PoolStateUnavailableError,
} = require("../src/rebalancer-pools");

/*- Shrink the inter-retry delay to zero so the exhaustion test (4
 *  attempts) completes in milliseconds rather than ~6 seconds. */
_setRetryDelayForTests(0);

/*- getPoolState takes its endpoints from the app's failover now, so a
 *  test has to stand that up rather than hand a provider in.  `init`
 *  keeps existing providers when the url list matches, which would
 *  silently reuse the previous case's mock, so each run resets first.
 *
 *  buildProvider tolerates this mock: with no `Network.from` it takes
 *  the plain `new JsonRpcProvider(url)` branch, and both of its patches
 *  return early on a stub with no `send` or `getFeeData`. */
function withMockRpc(lib, fn) {
  const sendTx = require("../src/send-transaction");
  const { RPC_URLS } = require("../src/config");
  sendTx._resetForTests();
  sendTx.init({ urls: [...RPC_URLS] }, lib);
  return (async () => fn())().finally(() => sendTx._resetForTests());
}

const FACTORY = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const TOKEN0 = "0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b";
const TOKEN1 = "0xAEbcD0F8f69ECF9587e292bdfc4d731c1abedB68";
const POOL = "0x3d3fF0F4FD039f8d94effA935678128072B72f6B";
const ZERO = "0x0000000000000000000000000000000000000000";

/*- Build a minimal mocked ethersLib whose `Contract` ctor returns an
 *  object with the methods getPoolState's chain calls.  Defaults
 *  produce a valid pool state for the (TOKEN0, TOKEN1) pair;
 *  `responses` overrides are checked with `in` (not `??`) so the
 *  caller can explicitly set a field to `undefined` / `null` and have
 *  THAT value flow through, rather than silently falling back to the
 *  default. */
function makeMockEthers(responses = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(responses, k);
  const constructed = []; // tracks each `new JsonRpcProvider(url)`
  function Contract(address) {
    /*- Each contract has methods that decide what to return based on
     *  the constructor address — factory contracts return pool / fee
     *  info, token contracts return decimals, pool contract returns
     *  slot0. */
    return {
      getPool: async () => (has("poolAddress") ? responses.poolAddress : POOL),
      feeAmountTickSpacing: async () =>
        has("tickSpacing") ? responses.tickSpacing : 200,
      decimals: async () => {
        if (address === TOKEN0 && has("decimals0")) return responses.decimals0;
        if (address === TOKEN1 && has("decimals1")) return responses.decimals1;
        if (address === TOKEN0) return 8;
        if (address === TOKEN1) return 18;
        return 18;
      },
      slot0: async () => ({
        sqrtPriceX96: has("sqrtPriceX96")
          ? responses.sqrtPriceX96
          : 79228162514264337593543950336n,
        tick: has("tick") ? responses.tick : 310280,
      }),
    };
  }
  function JsonRpcProvider(url) {
    constructed.push(url);
  }
  return {
    lib: { Contract, JsonRpcProvider, ZeroAddress: ZERO },
    constructed,
  };
}

// ── _getPoolStateOnce: validation throws ────────────────────────────────────

test("_getPoolStateOnce returns validated state on a good RPC response", async () => {
  const { lib } = makeMockEthers();
  const ps = await _getPoolStateOnce(
    {}, // provider — irrelevant (Contract mock doesn't use it)
    lib,
    {
      factoryAddress: FACTORY,
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 10000,
      _rpcUrl: "http://primary",
    },
  );
  assert.equal(ps.decimals0, 8);
  assert.equal(ps.decimals1, 18);
  assert.equal(ps.tickSpacing, 200);
  assert.equal(ps.tick, 310280);
  assert.equal(ps.poolAddress, POOL);
  assert.ok(ps.price > 0);
  assert.ok(typeof ps.sqrtPriceX96 === "bigint");
});

test("_getPoolStateOnce throws PoolStateInvalidError when decimals0 is undefined", async () => {
  const { lib } = makeMockEthers({ decimals0: undefined });
  await assert.rejects(
    () =>
      _getPoolStateOnce({}, lib, {
        factoryAddress: FACTORY,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 10000,
        _rpcUrl: "http://primary",
      }),
    (err) =>
      err instanceof PoolStateInvalidError &&
      err.field === "decimals0" &&
      err.rpcUrl === "http://primary",
  );
});

test("_getPoolStateOnce rejects decimals out of [0, 77]", async () => {
  const cases = [
    { decimals0: -1, field: "decimals0" },
    { decimals0: 78, field: "decimals0" },
    { decimals0: 18.5, field: "decimals0" },
    { decimals1: NaN, field: "decimals1" },
  ];
  for (const c of cases) {
    const { lib } = makeMockEthers(c);
    await assert.rejects(
      () =>
        _getPoolStateOnce({}, lib, {
          factoryAddress: FACTORY,
          token0: TOKEN0,
          token1: TOKEN1,
          fee: 10000,
          _rpcUrl: "http://x",
        }),
      (err) => err instanceof PoolStateInvalidError && err.field === c.field,
      `expected throw for ${JSON.stringify(c)}`,
    );
  }
});

test("_getPoolStateOnce rejects null / non-string / empty / no-0x / ZeroAddress poolAddress", async () => {
  /*- Validator is intentionally relaxed (datatype + not-null + starts
   *  with 0x + not ZeroAddress) so that test sentinels like
   *  `0xPOOL…` pass.  These cases are the ones that SHOULD still be
   *  rejected. */
  const cases = [
    { poolAddress: ZERO },
    { poolAddress: null },
    { poolAddress: undefined },
    { poolAddress: "" },
    { poolAddress: "not-an-address" }, // missing 0x prefix
  ];
  for (const c of cases) {
    const { lib } = makeMockEthers(c);
    await assert.rejects(
      () =>
        _getPoolStateOnce({}, lib, {
          factoryAddress: FACTORY,
          token0: TOKEN0,
          token1: TOKEN1,
          fee: 10000,
          _rpcUrl: "http://x",
        }),
      (err) =>
        err instanceof PoolStateInvalidError && err.field === "poolAddress",
      `case ${JSON.stringify(c)}`,
    );
  }
});

test("_getPoolStateOnce rejects sqrtPriceX96 = 0n / null / non-bigint-ish", async () => {
  for (const bad of [0n, null, undefined, "garbage"]) {
    const { lib } = makeMockEthers({ sqrtPriceX96: bad });
    await assert.rejects(
      () =>
        _getPoolStateOnce({}, lib, {
          factoryAddress: FACTORY,
          token0: TOKEN0,
          token1: TOKEN1,
          fee: 10000,
          _rpcUrl: "http://x",
        }),
      (err) =>
        err instanceof PoolStateInvalidError && err.field === "sqrtPriceX96",
    );
  }
});

test("_getPoolStateOnce rejects non-integer tick", async () => {
  const { lib } = makeMockEthers({ tick: undefined });
  await assert.rejects(
    () =>
      _getPoolStateOnce({}, lib, {
        factoryAddress: FACTORY,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 10000,
        _rpcUrl: "http://x",
      }),
    (err) => err instanceof PoolStateInvalidError && err.field === "tick",
  );
});

// ── Retry orchestrator ──────────────────────────────────────────────────────

test("getPoolState exhausts every RPC then throws PoolStateUnavailableError", async () => {
  /*- Every attempt fails the same way — decimals0 undefined.  The
   *  expected count is derived from the configured endpoint list rather
   *  than pinned: the contract is "try every RPC twice", and hard-coding
   *  the product means the test fails for the wrong reason the next time
   *  an endpoint is added. */
  const expectedAttempts = require("../src/config").RPC_URLS.length * 2;
  const { lib, constructed } = makeMockEthers({ decimals0: undefined });
  await withMockRpc(lib, () =>
    assert.rejects(
      () =>
        getPoolState(lib, {
          factoryAddress: FACTORY,
          token0: TOKEN0,
          token1: TOKEN1,
          fee: 10000,
        }),
      (err) => {
        if (!(err instanceof PoolStateUnavailableError)) return false;
        assert.equal(
          err.attempts,
          expectedAttempts,
          `expected ${expectedAttempts} attempts (one per RPC x 2)`,
        );
        assert.ok(
          err.cause instanceof PoolStateInvalidError,
          "cause should be the last invalid-error",
        );
        assert.equal(err.cause.field, "decimals0");
        return true;
      },
    ),
  );
  /*- One provider per endpoint, built once when failover was set up —
   *  not one per attempt.  Attempts now reuse the app's providers, which
   *  is the whole point of reading through its selection. */
  assert.equal(
    constructed.length,
    require("../src/config").RPC_URLS.length,
    "one provider per endpoint, built once",
  );
});

test("getPoolState succeeds on first try when the RPC returns valid data", async () => {
  const { lib } = makeMockEthers();
  const ps = await withMockRpc(lib, () =>
    getPoolState(lib, {
      factoryAddress: FACTORY,
      token0: TOKEN0,
      token1: TOKEN1,
      fee: 10000,
    }),
  );
  assert.equal(ps.decimals0, 8);
  assert.equal(ps.decimals1, 18);
  /*- Nothing to assert about provider construction any more: they are
   *  the app's, built once up front.  That the budget was not spent is
   *  the exhaustion case's job above. */
});

test("getPoolState reports what it sees to the decider", async () => {
  /*- Replaces a rule that said the opposite — that pool state must
   *  never touch shared failover state.  It had to stay silent while
   *  one report was the same act as retiring an endpoint for the whole
   *  process: this walk produces up to six failures per call, across
   *  ten positions.  A rate decides now, so the most frequent read in
   *  the bot can say what it sees. */
  const decider = require("../src/rpc-out-of-service");
  const sendTx = require("../src/send-transaction");
  const { RPC_URLS } = require("../src/config");
  decider._resetForTests();
  try {
    const { lib } = makeMockEthers({ tick: undefined });
    let endedOn = null;
    await withMockRpc(lib, async () => {
      await assert.rejects(() =>
        getPoolState(lib, {
          factoryAddress: FACTORY,
          token0: TOKEN0,
          token1: TOKEN1,
          fee: 10000,
        }),
      );
      /*- Read before `withMockRpc` tears the list down. */
      endedOn = sendTx.getCurrentRPCUrl();
    });
    /*- Selection moving IS the proof the reports landed, and is a
     *  stronger claim than asking the decider directly: engaging a
     *  failover clears the samples for the endpoint it leaves, so
     *  `decideIfCurrentRPCIsOutOfService` reads false for every
     *  endpoint already walked past.  What survives as evidence is
     *  that the walk ended somewhere other than where it started —
     *  which only a crossed failure rate can cause. */
    assert.notEqual(
      endedOn,
      RPC_URLS[0],
      "failures were reported, the rate crossed, and selection advanced",
    );
    assert.ok(
      RPC_URLS.includes(endedOn),
      "and it advanced within the configured list",
    );
  } finally {
    decider._resetForTests();
  }
});
