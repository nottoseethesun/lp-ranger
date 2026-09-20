/**
 * @file test/bot-recorder-heal.test.js
 * @description Tests for `_ensureTokenDecimals` — the lifetime scan's on-chain
 *   decimals heal step (resolves through `getPoolState`, honoring the
 *   operator's manual override + force). Verifies: heal writes missing
 *   decimals; a valid incremental scan short-circuits; a full rescan always
 *   re-resolves (Reload); a force override wins over a chain read; both tokens
 *   force-overridden skips the chain read; a non-force override is used as a
 *   fallback when getPoolState fails on decimals; an incomplete override
 *   retires; RPC exhaustion / non-decimals defects are transient (never
 *   retire). `getPoolState` is injected; the real `pool-state-validate` error
 *   classes drive the failure paths — no chain.
 * Run with: npm test
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { _ensureTokenDecimals } = require("../src/bot-recorder-decimals-heal");
const {
  PoolStateInvalidError,
  PoolStateUnavailableError,
} = require("../src/pool-state-validate");

/*- A fake getPoolState that records its calls and returns preset pool state
 *  or throws a preset error, standing in for the real on-chain reader. */
function makeGetState(behavior) {
  const calls = [];
  const fn = async (_provider, _ethersLib, opts) => {
    calls.push(opts);
    return typeof behavior === "function" ? behavior() : behavior;
  };
  fn.calls = calls;
  return fn;
}

describe("_ensureTokenDecimals", () => {
  it("resolves and writes missing decimals on an incremental scan", async () => {
    const pos = { token0: "0xA", token1: "0xB", fee: 3000 };
    const getState = makeGetState({ decimals0: 18, decimals1: 8 });
    const r = await _ensureTokenDecimals(pos, false, {}, getState);
    assert.equal(r.ok, true);
    assert.equal(r.resolved, true);
    assert.equal(r.source, "chain");
    assert.equal(pos.decimals0, 18);
    assert.equal(pos.decimals1, 8);
    assert.equal(getState.calls.length, 1);
  });

  it("short-circuits (no on-chain read) when decimals are already valid", async () => {
    const pos = {
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      decimals0: 18,
      decimals1: 8,
    };
    const getState = makeGetState({ decimals0: 1, decimals1: 1 });
    const r = await _ensureTokenDecimals(pos, false, {}, getState);
    assert.equal(r.ok, true);
    assert.equal(r.resolved, undefined);
    assert.equal(getState.calls.length, 0);
    assert.equal(pos.decimals0, 18);
  });

  it("re-resolves on a full rescan even when decimals look valid (Reload)", async () => {
    const pos = {
      token0: "0xA",
      token1: "0xB",
      fee: 3000,
      decimals0: 18,
      decimals1: 8,
    };
    const getState = makeGetState({ decimals0: 6, decimals1: 6 });
    const r = await _ensureTokenDecimals(pos, true, {}, getState);
    assert.equal(r.resolved, true);
    assert.equal(getState.calls.length, 1);
    assert.equal(pos.decimals0, 6);
    assert.equal(pos.decimals1, 6);
  });

  it("lets a force override win over a good on-chain read", async () => {
    const pos = { token0: "0xA", token1: "0xB", fee: 3000 };
    const getState = makeGetState({ decimals0: 18, decimals1: 8 });
    const r = await _ensureTokenDecimals(
      pos,
      false,
      { d1: 9, force1: true },
      getState,
    );
    assert.equal(r.resolved, true);
    assert.equal(pos.decimals0, 18); // token0 from chain
    assert.equal(pos.decimals1, 9); // token1 forced
    assert.equal(getState.calls.length, 1);
  });

  it("skips the on-chain read when both tokens are force-overridden", async () => {
    const pos = { token0: "0xA", token1: "0xB", fee: 3000 };
    const getState = makeGetState({ decimals0: 18, decimals1: 8 });
    const r = await _ensureTokenDecimals(
      pos,
      false,
      { d0: 9, force0: true, d1: 6, force1: true },
      getState,
    );
    assert.equal(r.resolved, true);
    assert.equal(r.source, "force");
    assert.equal(getState.calls.length, 0);
    assert.equal(pos.decimals0, 9);
    assert.equal(pos.decimals1, 6);
  });

  it("uses a non-force override as a fallback when getPoolState fails on decimals", async () => {
    const pos = { token0: "0xA", token1: "0xB", fee: 3000 };
    const getState = makeGetState(() => {
      throw new PoolStateInvalidError("decimals0", undefined, "https://rpc");
    });
    const r = await _ensureTokenDecimals(
      pos,
      false,
      { d0: 9, d1: 6 },
      getState,
    );
    assert.equal(r.resolved, true);
    assert.equal(r.source, "override");
    assert.equal(pos.decimals0, 9);
    assert.equal(pos.decimals1, 6);
  });

  it("retires when getPoolState fails on decimals and the override is incomplete", async () => {
    const pos = { token0: "0xA", token1: "0xB", fee: 3000 };
    const getState = makeGetState(() => {
      throw new PoolStateInvalidError("decimals0", undefined, "https://rpc");
    });
    const r = await _ensureTokenDecimals(pos, false, { d0: 9 }, getState);
    assert.equal(r.retire, true);
    assert.match(r.reason, /unreadable\/invalid on-chain/);
    assert.match(r.reason, /Pool Details/);
    assert.ok(r.err instanceof PoolStateInvalidError);
    assert.equal(pos.decimals0, undefined);
  });

  it("treats RPC exhaustion as transient (retry, not retire)", async () => {
    const pos = { token0: "0xA", token1: "0xB", fee: 3000 };
    const getState = makeGetState(() => {
      throw new PoolStateUnavailableError(4, new Error("timeout"));
    });
    const r = await _ensureTokenDecimals(pos, false, {}, getState);
    assert.equal(r.transient, true);
    assert.equal(r.retire, undefined);
    assert.equal(pos.decimals0, undefined);
  });

  it("treats a non-decimals pool-state defect as transient, not retire", async () => {
    const pos = { token0: "0xA", token1: "0xB", fee: 3000 };
    const getState = makeGetState(() => {
      throw new PoolStateInvalidError("price", 0, "https://rpc");
    });
    const r = await _ensureTokenDecimals(pos, false, {}, getState);
    assert.equal(r.transient, true);
    assert.equal(r.retire, undefined);
  });
});
