/**
 * @file test/rebalancer-aggregator.test.js
 * @description Unit tests for pure helpers in rebalancer-aggregator.js:
 *   _gasLimit, _baseSigner, and _getGasPrice.
 *
 * The gas-cost helper's cases moved to test/receipt-gas.test.js with the
 * function itself, which is now `receiptGasWei` in src/receipt-gas.js and
 * shared by every path that records a charge.
 *
 * `_handleSwapError` is covered by test/aggregator-nonce-settlement.test.js,
 * which drives all three of its answers rather than the one revert case that
 * used to live here — it is a decision about nonce ownership, not a pure
 * helper, and its outcomes only make sense beside each other.
 *
 * The chain's gas limit multiple and its gas for a quote that names none
 * are an operator's own here, 1.25 and 280000, not the 2 and 300000 that
 * ship, so a figure written into the code fails.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/test-temp-folders");
const SHIPPED_CHAINS = require("../app-config/app-defaults-for-user-configurable/chains.json");

const SETTINGS_DIR = makeTestTempFolder("aggregator-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "chains.json"),
  JSON.stringify(
    Object.fromEntries(
      Object.keys(SHIPPED_CHAINS).map((chain) => [
        chain,
        {
          gasLimitMultiplier: 1.25,
          aggregator: { gasUnitsWhenQuoteOmitsGas: 280000 },
        },
      ]),
    ),
  ),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  _gasLimit,
  _baseSigner,
  _getGasPrice,
} = require("../src/rebalancer-aggregator");

// ── _gasLimit ───────────────────────────────────────────────────────

describe("_gasLimit", () => {
  it("applies chain multiplier to quote.gas", () => {
    assert.equal(_gasLimit({ gas: 150000 }), 187500n);
  });

  it("uses estimatedGas when gas is missing", () => {
    assert.equal(_gasLimit({ estimatedGas: 200000 }), 250000n);
  });

  it("uses the chain's gasUnitsWhenQuoteOmitsGas when the quote names no gas", () => {
    assert.equal(_gasLimit({}), 350000n);
  });

  it("handles string gas values", () => {
    assert.equal(_gasLimit({ gas: "100000" }), 125000n);
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
