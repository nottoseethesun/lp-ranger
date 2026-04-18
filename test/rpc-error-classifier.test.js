"use strict";
/**
 * @file test/rpc-error-classifier.test.js
 * @description Unit tests for src/rpc-error-classifier.js — verifies
 * that real-world ethers/RPC error shapes land in the correct bucket
 * and that the inner-message extractor walks nested error wrappers.
 */

const { describe, it } = require("node:test");
const assert = require("assert");

const {
  classifyRpcError,
  innerErrorMessage,
  getBuckets,
} = require("../src/rpc-error-classifier");

describe("classifyRpcError — terminal-nonce-unused", () => {
  it("'queued sub-pool is full' → terminal-nonce-unused", () => {
    const err = new Error(
      'could not coalesce error (error={ "code": -32000, "message": "INTERNAL_ERROR: queued sub-pool is full" })',
    );
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-unused");
  });

  it("'txpool is full' → terminal-nonce-unused", () => {
    const err = new Error("txpool is full");
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-unused");
  });

  it("'insufficient funds' → terminal-nonce-unused", () => {
    const err = new Error("insufficient funds for gas * price + value");
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-unused");
  });

  it("ethers INSUFFICIENT_FUNDS code → terminal-nonce-unused", () => {
    const err = Object.assign(new Error("something"), {
      code: "INSUFFICIENT_FUNDS",
    });
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-unused");
  });

  it("ethers CALL_EXCEPTION code → terminal-nonce-unused", () => {
    const err = Object.assign(new Error("reverted"), {
      code: "CALL_EXCEPTION",
    });
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-unused");
  });

  it("'execution reverted' message → terminal-nonce-unused", () => {
    const err = new Error("execution reverted: STF");
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-unused");
  });
});

describe("classifyRpcError — terminal-nonce-consumed", () => {
  it("'nonce too low' → terminal-nonce-consumed", () => {
    const err = new Error("nonce too low");
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-consumed");
  });

  it("'replacement transaction underpriced' → terminal-nonce-consumed", () => {
    const err = new Error("replacement transaction underpriced");
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-consumed");
  });

  it("'already known' → terminal-nonce-consumed", () => {
    const err = new Error("already known");
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-consumed");
  });

  it("ethers NONCE_EXPIRED code → terminal-nonce-consumed", () => {
    const err = Object.assign(new Error("x"), { code: "NONCE_EXPIRED" });
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-consumed");
  });

  it("classifies nonce-consumed before nonce-unused when both substrings match", () => {
    // "insufficient funds" (nonce-unused) should lose to "nonce too low".
    const err = new Error("nonce too low — insufficient funds");
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-consumed");
  });
});

describe("classifyRpcError — transient", () => {
  it("'ETIMEDOUT' → transient", () => {
    const err = new Error("ETIMEDOUT");
    assert.strictEqual(classifyRpcError(err), "transient");
  });

  it("'ECONNRESET' → transient", () => {
    const err = new Error("ECONNRESET");
    assert.strictEqual(classifyRpcError(err), "transient");
  });

  it("'socket hang up' → transient", () => {
    const err = new Error("socket hang up");
    assert.strictEqual(classifyRpcError(err), "transient");
  });

  it("'rate limit' → transient", () => {
    const err = new Error("rate limit exceeded");
    assert.strictEqual(classifyRpcError(err), "transient");
  });

  it("'503 service unavailable' → transient", () => {
    const err = new Error("503 service unavailable");
    assert.strictEqual(classifyRpcError(err), "transient");
  });

  it("ethers TIMEOUT code → transient", () => {
    const err = Object.assign(new Error("x"), { code: "TIMEOUT" });
    assert.strictEqual(classifyRpcError(err), "transient");
  });

  it("generic 'could not coalesce error' without known inner → transient", () => {
    const err = new Error("could not coalesce error");
    assert.strictEqual(classifyRpcError(err), "transient");
  });
});

describe("classifyRpcError — unknown", () => {
  it("undefined → unknown", () => {
    assert.strictEqual(classifyRpcError(undefined), "unknown");
  });

  it("null → unknown", () => {
    assert.strictEqual(classifyRpcError(null), "unknown");
  });

  it("unrecognised message → unknown", () => {
    assert.strictEqual(
      classifyRpcError(new Error("some novel error")),
      "unknown",
    );
  });
});

describe("innerErrorMessage", () => {
  it("returns err.message for plain Error", () => {
    assert.strictEqual(innerErrorMessage(new Error("boom")), "boom");
  });

  it("prefers err.info.error.message over err.message", () => {
    const err = Object.assign(new Error("wrapper"), {
      info: { error: { message: "queued sub-pool is full" } },
    });
    assert.strictEqual(innerErrorMessage(err), "queued sub-pool is full");
  });

  it("uses err.shortMessage when info.error is missing", () => {
    const err = Object.assign(new Error("wrapper"), {
      shortMessage: "insufficient funds",
    });
    assert.strictEqual(innerErrorMessage(err), "insufficient funds");
  });

  it("handles null/undefined gracefully", () => {
    assert.strictEqual(innerErrorMessage(null), "");
    assert.strictEqual(innerErrorMessage(undefined), "");
  });

  it("classifier reaches nested error via innerErrorMessage", () => {
    // Real-world ethers shape — classifier must see the inner node msg.
    const err = Object.assign(new Error("could not coalesce error"), {
      info: {
        error: {
          code: -32000,
          message: "INTERNAL_ERROR: queued sub-pool is full",
        },
      },
    });
    assert.strictEqual(classifyRpcError(err), "terminal-nonce-unused");
  });
});

describe("getBuckets", () => {
  it("returns the three buckets with non-empty substring lists", () => {
    const b = getBuckets();
    assert.ok(b.transient.messageSubstrings.length > 0);
    assert.ok(b.terminalNonceUnused.messageSubstrings.length > 0);
    assert.ok(b.terminalNonceConsumed.messageSubstrings.length > 0);
  });

  it("all substrings are lowercase", () => {
    const b = getBuckets();
    for (const bucket of [
      b.transient,
      b.terminalNonceUnused,
      b.terminalNonceConsumed,
    ]) {
      for (const s of bucket.messageSubstrings) {
        assert.strictEqual(
          s,
          s.toLowerCase(),
          `substring "${s}" must be lowercase`,
        );
      }
    }
  });
});
