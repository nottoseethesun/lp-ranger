/**
 * @file test/rebalancer-aggregator.test.js
 * @description Unit tests for pure helpers in rebalancer-aggregator.js:
 *   _gasCost, _gasLimit, _baseSigner, _getGasPrice, and _handleSwapError.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  _gasCost,
  _gasLimit,
  _baseSigner,
  _getGasPrice,
  _handleSwapError,
} = require("../src/rebalancer-aggregator");

// ── _gasCost ────────────────────────────────────────────────────────

describe("_gasCost", () => {
  it("computes gas cost from receipt", () => {
    const r = { gasUsed: 21000n, gasPrice: 50000000000n };
    assert.strictEqual(_gasCost(r), 21000n * 50000000000n);
  });

  it("uses effectiveGasPrice when gasPrice is missing", () => {
    const r = { gasUsed: 100n, effectiveGasPrice: 200n };
    assert.strictEqual(_gasCost(r), 100n * 200n);
  });

  it("returns 0n when gasUsed is missing", () => {
    assert.strictEqual(_gasCost({}), 0n);
  });

  it("returns 0n for empty receipt fields", () => {
    const r = { gasUsed: 0n, gasPrice: 0n };
    assert.strictEqual(_gasCost(r), 0n);
  });

  it("prefers gasPrice over effectiveGasPrice", () => {
    const r = { gasUsed: 10n, gasPrice: 5n, effectiveGasPrice: 3n };
    assert.strictEqual(_gasCost(r), 50n);
  });
});

// ── _gasLimit ───────────────────────────────────────────────────────

describe("_gasLimit", () => {
  it("applies chain multiplier to quote.gas", () => {
    const gl = _gasLimit({ gas: 150000 });
    // Default gasLimitMultiplier is 2 from chains.json
    assert.ok(gl > 150000n);
    assert.ok(typeof gl === "bigint");
  });

  it("uses estimatedGas when gas is missing", () => {
    const gl = _gasLimit({ estimatedGas: 200000 });
    assert.ok(gl >= 200000n);
  });

  it("falls back to 300000 when no gas field", () => {
    const gl = _gasLimit({});
    // 300000 * multiplier
    assert.ok(gl >= 300000n);
  });

  it("handles string gas values", () => {
    const gl = _gasLimit({ gas: "100000" });
    assert.ok(gl >= 100000n);
  });
});

// ── _baseSigner ─────────────────────────────────────────────────────

describe("_baseSigner", () => {
  it("unwraps NonceManager (signer.signer)", () => {
    const inner = { getAddress: () => "0x1" };
    const nm = { signer: inner };
    assert.strictEqual(_baseSigner(nm), inner);
  });

  it("returns signer itself when no inner signer", () => {
    const signer = { getAddress: () => "0x2" };
    assert.strictEqual(_baseSigner(signer), signer);
  });

  it("returns signer when signer.signer is undefined", () => {
    const s = {};
    assert.strictEqual(_baseSigner(s), s);
  });
});

// ── _getGasPrice ────────────────────────────────────────────────────

describe("_getGasPrice", () => {
  it("returns gasPrice from fee data", async () => {
    const provider = {
      getFeeData: async () => ({ gasPrice: 100n, maxFeePerGas: 200n }),
    };
    const gp = await _getGasPrice(provider);
    assert.strictEqual(gp, 100n);
  });

  it("falls back to maxFeePerGas when gasPrice is null", async () => {
    const provider = {
      getFeeData: async () => ({ gasPrice: null, maxFeePerGas: 300n }),
    };
    const gp = await _getGasPrice(provider);
    assert.strictEqual(gp, 300n);
  });

  it("returns 0n when both are null", async () => {
    const provider = {
      getFeeData: async () => ({ gasPrice: null, maxFeePerGas: null }),
    };
    const gp = await _getGasPrice(provider);
    assert.strictEqual(gp, 0n);
  });
});

// ── _handleSwapError ────────────────────────────────────────────────

describe("_handleSwapError", () => {
  it("returns 0n for on-chain revert (non-timeout)", async () => {
    const err = { message: "CALL_EXCEPTION", code: "CALL_EXCEPTION" };
    const gas = await _handleSwapError(err, {}, {}, 0, 5000, "TKA", "TKB", 0n);
    assert.strictEqual(gas, 0n);
  });
});

// ── _fetchQuote error path (via swapViaAggregator) ──────────────────

describe("swapViaAggregator — API error handling", () => {
  const { swapViaAggregator } = require("../src/rebalancer-aggregator");

  it("throws with parsed validation error from API", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        reason: "Validation Failed",
        validationErrors: [
          { field: "sellToken", reason: "Could not find token" },
        ],
      }),
    });
    try {
      await assert.rejects(
        () =>
          swapViaAggregator(
            { getAddress: async () => "0xAddr" },
            { Contract: class {} },
            {
              tokenIn: "0xA",
              tokenOut: "0xB",
              amountIn: 1000n,
              slippagePct: 0.5,
              recipient: "0xR",
            },
            async () => {},
          ),
        (err) =>
          err.message.includes("Aggregator API: HTTP 400") &&
          err.message.includes("Validation Failed") &&
          err.message.includes("sellToken"),
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("throws with balance/allowance issues from API", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        reason: "Insufficient balance",
        issues: {
          balance: { actual: "0", expected: "1000" },
          allowance: { actual: "0", spender: "0xSpender" },
        },
      }),
    });
    try {
      await assert.rejects(
        () =>
          swapViaAggregator(
            { getAddress: async () => "0xAddr" },
            { Contract: class {} },
            {
              tokenIn: "0xA",
              tokenOut: "0xB",
              amountIn: 1000n,
              slippagePct: 0.5,
              recipient: "0xR",
            },
            async () => {},
          ),
        (err) =>
          err.message.includes("balance") && err.message.includes("allowance"),
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("handles non-JSON error response", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });
    try {
      await assert.rejects(
        () =>
          swapViaAggregator(
            { getAddress: async () => "0xAddr" },
            { Contract: class {} },
            {
              tokenIn: "0xA",
              tokenOut: "0xB",
              amountIn: 1000n,
              slippagePct: 0.5,
              recipient: "0xR",
            },
            async () => {},
          ),
        (err) => err.message.includes("HTTP 500"),
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
