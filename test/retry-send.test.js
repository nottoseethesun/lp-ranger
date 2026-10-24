"use strict";
/**
 * @file test/retry-send.test.js
 * @description Unit tests for `_retrySend` in src/lib/tx-retry.js — covers the
 * three classifier buckets (transient, terminal-nonce-unused,
 * terminal-nonce-consumed), NonceManager reset behaviour, the
 * `retryingTxWithSameNonce` opt for explicit-nonce replacements, and the
 * retry count, which is app-runtime.json's `tx.sendRetries`: five here,
 * an operator's own, not the three that ship, so a count written into
 * the code fails.
 */

const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const SETTINGS_DIR = makeTestTempFolder("retry-send-settings");
fs.writeFileSync(
  path.join(SETTINGS_DIR, "app-runtime.json"),
  JSON.stringify({ tx: { sendRetries: 5 } }),
);
process.env.LP_RANGER_USER_CONFIG_DIR = SETTINGS_DIR;

const { describe, it } = require("node:test");
const assert = require("assert");

const { _retrySend } = require("../src/lib/tx-retry");

describe("_retrySend", () => {
  it("returns immediately on success", async () => {
    const result = await _retrySend(() => Promise.resolve("ok"), "test");
    assert.strictEqual(result, "ok");
  });

  it("throws immediately for terminal-nonce-consumed errors that are not nonce-too-low", async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        _retrySend(() => {
          attempts++;
          return Promise.reject(
            new Error("replacement transaction underpriced"),
          );
        }, "test"),
      { message: "replacement transaction underpriced" },
    );
    assert.strictEqual(attempts, 1, "must not retry on a consumed nonce");
  });

  it("recovers from nonce-too-low by resetting NonceManager and retrying once", async () => {
    let resets = 0;
    const signer = {
      reset: () => {
        resets++;
      },
    };
    let attempts = 0;
    const result = await _retrySend(
      () => {
        attempts++;
        if (attempts === 1)
          return Promise.reject(
            new Error("INTERNAL_ERROR: nonce too low (have 948, want 950)"),
          );
        return Promise.resolve("ok");
      },
      "test",
      { baseDelayMs: 10, signer },
    );
    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 2, "should retry exactly once after reset");
    assert.strictEqual(resets, 1, "should reset NonceManager once");
  });

  it("recovers via NONCE_EXPIRED ethers code", async () => {
    let resets = 0;
    const signer = {
      reset: () => {
        resets++;
      },
    };
    let attempts = 0;
    const result = await _retrySend(
      () => {
        attempts++;
        if (attempts === 1) {
          const e = new Error("nonce expired");
          e.code = "NONCE_EXPIRED";
          return Promise.reject(e);
        }
        return Promise.resolve("ok");
      },
      "test",
      { baseDelayMs: 10, signer },
    );
    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 2);
    assert.strictEqual(resets, 1);
  });

  it("does not loop on persistent nonce-too-low — recovery is one-shot", async () => {
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
            return Promise.reject(new Error("nonce too low"));
          },
          "test",
          { baseDelayMs: 10, signer },
        ),
      { message: /nonce too low/ },
    );
    assert.strictEqual(
      attempts,
      2,
      "1 original + 1 recovery retry, then give up",
    );
    assert.strictEqual(resets, 1, "exactly one reset for the recovery");
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
    // The original send, then each of the five retries.
    assert.strictEqual(attempts, 6);
    // A reset before each retry, and one more on giving up.
    assert.strictEqual(resets, 6);
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

  it("retryingTxWithSameNonce=true: nonce-too-low throws immediately without reset or retry", async () => {
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
            return Promise.reject(new Error("nonce too low"));
          },
          "[rebalance] mint speedup nonce=948",
          { baseDelayMs: 10, signer, retryingTxWithSameNonce: true },
        ),
      { message: /nonce too low/ },
    );
    assert.strictEqual(
      attempts,
      1,
      "same-nonce path must not retry — original mined",
    );
    assert.strictEqual(
      resets,
      0,
      "same-nonce path must not reset NonceManager",
    );
  });

  it("retryingTxWithSameNonce=true: NONCE_EXPIRED throws immediately without reset", async () => {
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
            const e = new Error("nonce expired");
            e.code = "NONCE_EXPIRED";
            return Promise.reject(e);
          },
          "[rebalance] mint cancel nonce=948",
          { baseDelayMs: 10, signer, retryingTxWithSameNonce: true },
        ),
      { code: "NONCE_EXPIRED" },
    );
    assert.strictEqual(attempts, 1);
    assert.strictEqual(resets, 0);
  });

  it("retryingTxWithSameNonce=true: still retries transient errors", async () => {
    // Same-nonce only suppresses nonce-too-low recovery; transient
    // errors (network glitches) on a same-nonce send should still retry.
    let attempts = 0;
    const result = await _retrySend(
      () => {
        attempts++;
        if (attempts < 2) return Promise.reject(new Error("ECONNRESET"));
        return Promise.resolve("ok");
      },
      "[rebalance] cancel nonce=948",
      { baseDelayMs: 10, retryingTxWithSameNonce: true },
    );
    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 2);
  });
});
