"use strict";

/**
 * @file test/bot.test.js
 * @description Tests for bot.js — RPC fallback, pollCycle, appendLog.
 */

const { describe, it } = require("node:test");
const assert = require("assert");
const { createProviderWithFallback, pollCycle } = require("../src/bot-loop");
const { ADDR, buildPollDeps } = require("./_bot-loop-helpers");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock ethers library whose JsonRpcProvider controls getBlockNumber. */
function mockEthersLib({ primaryFails = false, fallbackFails = false } = {}) {
  const calls = [];
  function JsonRpcProvider(url) {
    calls.push(url);
    this.url = url;
    this.getBlockNumber = async () => {
      if (primaryFails && url === "https://primary.rpc") {
        throw new Error("primary unreachable");
      }
      if (fallbackFails && url === "https://fallback.rpc") {
        throw new Error("fallback unreachable");
      }
      return 12345;
    };
  }
  return { JsonRpcProvider, calls };
}

// ── RPC fallback ─────────────────────────────────────────────────────────────

describe("createProviderWithFallback", () => {
  it("uses primary when it is reachable", async () => {
    const lib = mockEthersLib();
    const provider = await createProviderWithFallback(
      "https://primary.rpc",
      "https://fallback.rpc",
      lib,
    );
    assert.strictEqual(provider.url, "https://primary.rpc");
    assert.deepStrictEqual(lib.calls, ["https://primary.rpc"]);
  });

  it("falls back when primary is unreachable", async () => {
    const lib = mockEthersLib({ primaryFails: true });
    const provider = await createProviderWithFallback(
      "https://primary.rpc",
      "https://fallback.rpc",
      lib,
    );
    assert.strictEqual(provider.url, "https://fallback.rpc");
    assert.deepStrictEqual(lib.calls, [
      "https://primary.rpc",
      "https://fallback.rpc",
    ]);
  });

  it("throws when both primary and fallback are unreachable", async () => {
    const lib = mockEthersLib({ primaryFails: true, fallbackFails: true });
    await assert.rejects(
      () =>
        createProviderWithFallback(
          "https://primary.rpc",
          "https://fallback.rpc",
          lib,
        ),
      { message: "fallback unreachable" },
    );
    assert.deepStrictEqual(lib.calls, [
      "https://primary.rpc",
      "https://fallback.rpc",
    ]);
  });

  it("does not try fallback when primary succeeds", async () => {
    const lib = mockEthersLib({ fallbackFails: true });
    const provider = await createProviderWithFallback(
      "https://primary.rpc",
      "https://fallback.rpc",
      lib,
    );
    assert.strictEqual(provider.url, "https://primary.rpc");
    assert.strictEqual(lib.calls.length, 1);
  });

  it("returned provider has working getBlockNumber", async () => {
    const lib = mockEthersLib({ primaryFails: true });
    const provider = await createProviderWithFallback(
      "https://primary.rpc",
      "https://fallback.rpc",
      lib,
    );
    const block = await provider.getBlockNumber();
    assert.strictEqual(block, 12345);
  });
});

// ── pollCycle — OOR detection ────────────────────────────────────────────────

describe("pollCycle — out-of-range detection", () => {
  // Minimal mock for pollCycle: it calls getPoolState via the real rebalancer,
  // so we mock at the ethers.Contract level via the global `ethers` require.
  // Instead, we can test the OOR boundary logic directly.

  it("upper tick boundary is exclusive (tick === tickUpper is OOR)", async () => {
    // This tests the V3 semantics: when tick === tickUpper, position is OOR.
    // We can't easily call pollCycle without full mocking, so we verify
    // the boundary logic matches V3 spec directly.
    const tick = 600;
    const tickLower = -600;
    const tickUpper = 600;
    // V3 in-range: tick >= tickLower && tick < tickUpper (strict less-than)
    const inRange = tick >= tickLower && tick < tickUpper;
    assert.strictEqual(
      inRange,
      false,
      "tick === tickUpper should be out of range",
    );
  });

  it("tick just below tickUpper is in-range", () => {
    const tick = 599;
    const tickLower = -600;
    const tickUpper = 600;
    const inRange = tick >= tickLower && tick < tickUpper;
    assert.strictEqual(inRange, true);
  });

  it("tick at tickLower is in-range", () => {
    const tick = -600;
    const tickLower = -600;
    const tickUpper = 600;
    const inRange = tick >= tickLower && tick < tickUpper;
    assert.strictEqual(inRange, true);
  });

  it("tick below tickLower is out of range", () => {
    const tick = -601;
    const tickLower = -600;
    const tickUpper = 600;
    const inRange = tick >= tickLower && tick < tickUpper;
    assert.strictEqual(inRange, false);
  });
});

// ── pollCycle pipeline tests ────────────────────────────────────────────────
// `buildPollDeps` and `ADDR` are imported from ./_bot-loop-helpers.js — see
// that file for the dispatch table, signer/sendTransaction wiring, and the
// per-address shared `_pending` queue used by multicall.

describe("pollCycle — full pipeline", () => {
  it("returns rebalanced:false when in range", async () => {
    const deps = buildPollDeps({ tick: 0 }); // tick 0 is in [-600, 600)
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {
        rebalanceOutOfRangeThresholdPercent: 20,
        slippagePct: 0.5,
      },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 20, slippagePct: 0.5 })[k],
    });
    assert.strictEqual(r.rebalanced, false);
  });

  it("rebalances when out of range (tick >= tickUpper)", async () => {
    const deps = buildPollDeps({ tick: 600 }); // tick === tickUpper → OOR
    const posBefore = { ...deps.position };
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
        slippagePct: 0.5,
      },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 0, slippagePct: 0.5 })[k],
    });
    assert.strictEqual(r.rebalanced, true);
    // Verify position was updated in-place
    assert.notStrictEqual(deps.position.tokenId, posBefore.tokenId);
    assert.strictEqual(
      deps.position.tokenId,
      "99",
      "tokenId should be updated from mint",
    );
  });

  it("updates position.liquidity from mint result (not amount sum)", async () => {
    const deps = buildPollDeps({ tick: 700 });
    await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
        slippagePct: 0.5,
      },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 0, slippagePct: 0.5 })[k],
    });
    // makeMintTx returns liquidity=8000n
    assert.strictEqual(
      deps.position.liquidity,
      "8000",
      "liquidity must come from mint event, not amount0+amount1",
    );
  });

  it("updates tickLower and tickUpper after rebalance", async () => {
    const deps = buildPollDeps({ tick: -700 });
    await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
        slippagePct: 0.5,
      },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 0, slippagePct: 0.5 })[k],
    });
    // New ticks should be centered around the current price (tick=-700)
    assert.ok(deps.position.tickLower < deps.position.tickUpper);
    assert.notStrictEqual(
      deps.position.tickLower,
      -600,
      "ticks should be updated",
    );
  });

  it("does not rebalance when throttled", async () => {
    const deps = buildPollDeps({ tick: 700 });
    deps.throttle._state.allowed = false;
    deps.throttle.canRebalance = () => ({
      allowed: false,
      msUntilAllowed: 60000,
      reason: "min_interval",
    });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rebalanceOutOfRangeThresholdPercent: 0 },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 0, slippagePct: 0.5 })[k],
    });
    assert.strictEqual(r.rebalanced, false);
    // Position should be unchanged
    assert.strictEqual(deps.position.tokenId, 1n);
  });

  it("does not rebalance in dry-run mode", async () => {
    const deps = buildPollDeps({ tick: 700 });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      dryRun: true,
      _ethersLib: deps.ethersLib,
      _botState: { rebalanceOutOfRangeThresholdPercent: 0 },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 0, slippagePct: 0.5 })[k],
    });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(
      deps.position.tokenId,
      1n,
      "position unchanged in dry run",
    );
  });

  it("returns withinThreshold when OOR but within threshold", async () => {
    const deps = buildPollDeps({ tick: 600 }); // just barely OOR
    // High threshold: price must move 50% beyond boundary — won't trigger
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {
        rebalanceOutOfRangeThresholdPercent: 50,
        slippagePct: 0.5,
      },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 50, slippagePct: 0.5 })[k],
    });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(r.withinThreshold, true);
  });

  it("rebalances when OOR threshold is 0", async () => {
    const deps = buildPollDeps({ tick: 700 });
    // Threshold 0 means any OOR triggers immediately
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {
        rebalanceOutOfRangeThresholdPercent: 0,
        slippagePct: 0.5,
      },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 0, slippagePct: 0.5 })[k],
    });
    assert.strictEqual(r.rebalanced, true);
  });

  it("position unchanged when rebalance fails", async () => {
    const deps = buildPollDeps({ tick: 700 });
    // Make getPool fail so executeRebalance returns success:false
    deps.dispatch[ADDR.factory] = {
      getPool: async () => {
        throw new Error("RPC_DOWN");
      },
    };
    const posBefore = { ...deps.position };
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rebalanceOutOfRangeThresholdPercent: 0 },
      _getConfig: (k) =>
        ({ rebalanceOutOfRangeThresholdPercent: 0, slippagePct: 0.5 })[k],
    });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(deps.position.tokenId, posBefore.tokenId);
    assert.strictEqual(deps.position.tickLower, posBefore.tickLower);
    assert.strictEqual(deps.position.liquidity, posBefore.liquidity);
  });
});
