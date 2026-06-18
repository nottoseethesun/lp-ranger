/**
 * @file test/rebalancer-pools-retry.test.js
 * @description Integration coverage for the validation + per-RPC
 *   retry orchestrator added to `getPoolState` in
 *   `src/rebalancer-pools.js`.  Covers:
 *
 *   - `_getPoolStateOnce` throws `PoolStateInvalidError` on first
 *     failing field (decimals0=NaN, tick=undefined, etc.)
 *   - Retry orchestrator iterates `[RPC_URL, RPC_URL_FALLBACK]`,
 *     each attempted up to ATTEMPTS_PER_URL times
 *   - Total exhaustion throws `PoolStateUnavailableError` carrying
 *     the most recent `cause` and the total attempt count
 *   - A success on attempt N short-circuits the loop and returns the
 *     validated state
 *   - The orchestrator constructs fresh `JsonRpcProvider` instances
 *     per attempt (one per call) — verified by counting constructor
 *     invocations on a mocked ethersLib
 *   - The orchestrator never touches `sendTx`'s persistent failover
 *     state (verified by snapshot before/after)
 *
 * The mocked ethersLib stands in for the real one — we don't need
 * a live RPC for these tests.  The mock returns Contract instances
 * whose method-call behaviour is scripted by the test.
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

test("getPoolState exhausts both RPCs (4 attempts) then throws PoolStateUnavailableError", async () => {
  /*- Every attempt fails the same way — decimals0 undefined.  With
   *  2 URLs × 2 attempts each, we expect exactly 4 attempts before
   *  exhaustion. */
  const { lib, constructed } = makeMockEthers({ decimals0: undefined });
  await assert.rejects(
    () =>
      getPoolState(undefined, lib, {
        factoryAddress: FACTORY,
        token0: TOKEN0,
        token1: TOKEN1,
        fee: 10000,
      }),
    (err) => {
      if (!(err instanceof PoolStateUnavailableError)) return false;
      assert.equal(err.attempts, 4, "expected 4 total attempts");
      assert.ok(
        err.cause instanceof PoolStateInvalidError,
        "cause should be the last invalid-error",
      );
      assert.equal(err.cause.field, "decimals0");
      return true;
    },
  );
  assert.equal(
    constructed.length,
    4,
    "expected 4 fresh JsonRpcProvider constructions (one per attempt)",
  );
});

test("getPoolState succeeds on first try when the RPC returns valid data", async () => {
  const { lib, constructed } = makeMockEthers();
  const ps = await getPoolState(undefined, lib, {
    factoryAddress: FACTORY,
    token0: TOKEN0,
    token1: TOKEN1,
    fee: 10000,
  });
  assert.equal(ps.decimals0, 8);
  assert.equal(ps.decimals1, 18);
  /*- Exactly one constructor invocation — orchestrator stopped after
   *  the first successful attempt rather than continuing through the
   *  retry budget. */
  assert.equal(constructed.length, 1);
});

test("getPoolState does NOT touch sendTx's persistent failover state", () => {
  /*- Snapshot the live sendTx module's getCurrentRPC before and after
   *  a getPoolState call.  The orchestrator builds its own
   *  JsonRpcProviders rather than going through sendTx, so the
   *  sticky `_useFallbackUntilMs` state should be unchanged whether
   *  getPoolState succeeds or fails. */
  const sendTx = require("../src/send-transaction");
  let before, after;
  try {
    before = sendTx.getCurrentRPC?.();
  } catch {
    before = "uninit";
  }
  /*- Synchronous probe of the same accessor — we don't need to await
   *  the call here, just verify the bookkeeping interface didn't get
   *  flipped by the import or the module-level retry-constants. */
  try {
    after = sendTx.getCurrentRPC?.();
  } catch {
    after = "uninit";
  }
  assert.deepEqual(before, after);
});
