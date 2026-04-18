"use strict";
/**
 * @file test/retry-send.test.js
 * @description Unit tests for `_retrySend` in src/rebalancer-pools.js —
 * covers the three classifier buckets (transient, terminal-nonce-unused,
 * terminal-nonce-consumed), NonceManager reset behaviour, and back-compat
 * with the legacy numeric third-arg calling convention.
 */

const { describe, it } = require("node:test");
const assert = require("assert");

const { _retrySend } = require("../src/rebalancer-pools");

describe("_retrySend", () => {
  it("returns immediately on success", async () => {
    const result = await _retrySend(() => Promise.resolve("ok"), "test");
    assert.strictEqual(result, "ok");
  });

  it("throws immediately for terminal-nonce-consumed errors", async () => {
    await assert.rejects(
      () =>
        _retrySend(() => Promise.reject(new Error("nonce too low")), "test"),
      { message: "nonce too low" },
    );
  });

  it("throws immediately for terminal-nonce-unused errors and resets nonce", async () => {
    let resets = 0;
    const signer = {
      reset: () => {
        resets++;
      },
    };
    let attempts = 0;
    await assert.rejects(
      () =>
        _retrySend(
          () => {
            attempts++;
            return Promise.reject(
              new Error("INTERNAL_ERROR: queued sub-pool is full"),
            );
          },
          "test",
          { baseDelayMs: 10, signer },
        ),
      { message: /queued sub-pool is full/ },
    );
    assert.strictEqual(
      attempts,
      1,
      "should not retry on terminal-nonce-unused",
    );
    assert.strictEqual(resets, 1, "should reset nonce once");
  });

  it("retries transient errors and succeeds", async () => {
    let attempts = 0;
    const result = await _retrySend(
      () => {
        attempts++;
        if (attempts < 2)
          return Promise.reject(new Error("ETIMEDOUT: socket timeout"));
        return Promise.resolve("recovered");
      },
      "test",
      { baseDelayMs: 10 },
    );
    assert.strictEqual(result, "recovered");
    assert.strictEqual(attempts, 2);
  });

  it("resets nonce before every transient retry", async () => {
    let resets = 0;
    const signer = {
      reset: () => {
        resets++;
      },
    };
    let attempts = 0;
    await _retrySend(
      () => {
        attempts++;
        if (attempts < 3) return Promise.reject(new Error("rate limit hit"));
        return Promise.resolve("ok");
      },
      "test",
      { baseDelayMs: 10, signer },
    );
    assert.strictEqual(attempts, 3);
    assert.strictEqual(resets, 2, "reset before each of the two retries");
  });

  it("exhausts retries for persistent transient errors", async () => {
    let attempts = 0;
    let resets = 0;
    const signer = {
      reset: () => {
        resets++;
      },
    };
    await assert.rejects(
      () =>
        _retrySend(
          () => {
            attempts++;
            return Promise.reject(new Error("ECONNRESET"));
          },
          "test",
          { baseDelayMs: 10, signer },
        ),
      { message: /ECONNRESET/ },
    );
    assert.strictEqual(attempts, 4); // 1 original + 3 retries
    assert.strictEqual(resets, 4); // reset before each retry + final exhaustion reset
  });

  it("accepts legacy numeric third arg (baseDelayMs) for back-compat", async () => {
    let attempts = 0;
    const result = await _retrySend(
      () => {
        attempts++;
        if (attempts < 2) return Promise.reject(new Error("socket hang up"));
        return Promise.resolve("ok");
      },
      "test",
      10, // legacy calling convention
    );
    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 2);
  });

  it("treats unknown errors as terminal (no retry, no reset)", async () => {
    let resets = 0;
    const signer = {
      reset: () => {
        resets++;
      },
    };
    let attempts = 0;
    await assert.rejects(
      () =>
        _retrySend(
          () => {
            attempts++;
            return Promise.reject(new Error("some novel error we don't know"));
          },
          "test",
          { baseDelayMs: 10, signer },
        ),
      { message: /some novel error/ },
    );
    assert.strictEqual(attempts, 1, "unknown errors should not retry");
    assert.strictEqual(resets, 0, "unknown errors should NOT reset nonce");
  });
});
