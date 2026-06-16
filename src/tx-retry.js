/**
 * @file tx-retry.js
 * @module tx-retry
 * @description
 * Universal TX submission helper with classifier-driven retry logic.
 * Used by every TX submission path in the project — rebalance, compound,
 * aggregator swap, router fallback, speedup/cancel — so nonce-drift
 * recovery applies universally.
 *
 * No module-level state: the optional `retryingTxWithSameNonce` flag is
 * a per-call parameter, never a global.
 */

"use strict";

const { log } = require("./log");
const {
  classifyRpcError,
  innerErrorMessage,
} = require("./rpc-error-classifier");

/** Maximum TX send retries for transient RPC errors. */
const _RETRY_MAX = 3;
/** Base delay between retries (ms). Multiplied by attempt number: 30s, 60s, 90s. */
const _RETRY_BASE_DELAY_MS = 30_000;

/**
 * Reset the NonceManager so the next TX picks up the correct chain-state
 * nonce.  Required after a terminal-nonce-unused rejection because
 * ethers v6's NonceManager increments `#delta` before broadcasting
 * (see node_modules/ethers/.../signer-noncemanager.js line 60).  When
 * broadcast fails, the delta is wrong until we reset.
 * @param {*} signer
 */
function _resetSignerNonce(signer) {
  if (signer && typeof signer.reset === "function") signer.reset();
}

/**
 * Best-effort extraction of the nonce that was rejected, so logs show
 * which slot collided with chain state.  Ethers buries the original
 * request in different places depending on the error path.
 * @param {*} err
 * @returns {number|undefined}
 */
function _rejectedNonce(err) {
  return err?.transaction?.nonce ?? err?.tx?.nonce ?? err?.info?.nonce;
}

/** Format " nonce=N" suffix when known, else empty. */
function _nonceSuffix(err) {
  const n = _rejectedNonce(err);
  return n !== undefined ? " nonce=" + n : "";
}

/**
 * Log the verbatim inner node error message so distinct mempool rejection
 * reasons (`queued sub-pool is full` vs `replacement transaction
 * underpriced` vs `txpool is full`) are easy to distinguish in the log.
 * Includes the rejected nonce when it can be recovered from the error.
 * @param {string} label
 * @param {string} bucket
 * @param {*}      err
 */
function _logTerminalError(label, bucket, err) {
  log.error(
    "%s: terminal RPC error (%s)%s — %s",
    label,
    bucket,
    _nonceSuffix(err),
    innerErrorMessage(err),
  );
}

/**
 * Match the exact "nonce too low" signal — chain has advanced past our
 * local NonceManager counter.  Distinct from other terminal-nonce-consumed
 * cases ("already known", "replacement underpriced") which would loop
 * forever or aren't relevant to this code path.
 *
 * Cause: local NonceManager `#delta` drifted behind chain after a
 * connectivity gap, external wallet activity, or a successful-but-
 * lost-receipt TX.
 *
 * Recovery: reset the NonceManager (forces a fresh
 * `getTransactionCount(addr, "pending")` on next send) and retry once.
 * @param {*} err
 * @returns {boolean}
 */
function _isNonceTooLow(err) {
  if (!err) return false;
  if (err.code === "NONCE_EXPIRED") return true;
  const msg = innerErrorMessage(err).toLowerCase();
  return (
    msg.includes("nonce too low") || msg.includes("nonce has already been used")
  );
}

/**
 * Handle a "terminal-nonce-consumed" or "unknown" error.  Returns
 * `"recover"` if the caller should reset the NonceManager and retry once
 * (one-shot recovery for local nonce drift), otherwise throws.
 * @param {object} ctx
 * @param {string} ctx.label
 * @param {string} ctx.bucket
 * @param {*}      ctx.err
 * @param {boolean} ctx.sameNonce
 * @param {boolean} ctx.recoveryUsed
 * @param {*}      ctx.signer
 * @returns {"recover"}  Always returns "recover" or throws.
 */
function _handleConsumed(ctx) {
  const { label, bucket, err, sameNonce, recoveryUsed, signer } = ctx;
  // Same-nonce retry path: caller explicitly reused a nonce.
  // "nonce too low" means the original mined → success was already
  // achieved.  Do NOT reset the NonceManager here.
  if (sameNonce && _isNonceTooLow(err)) {
    log.info(
      "%s: same-nonce replacement got 'nonce too low'%s —" +
        " original TX likely mined; not recovering. Inner: %s",
      label,
      _nonceSuffix(err),
      innerErrorMessage(err),
    );
    throw err;
  }
  if (!recoveryUsed && _isNonceTooLow(err)) {
    const n = _rejectedNonce(err);
    const nStr = n !== undefined ? " (rejected nonce=" + n + ")" : "";
    log.warn(
      "%s: nonce too low%s — the local NonceManager singleton instance" +
        " drifted behind the blockchain. Resetting NonceManager and" +
        " retrying once. Inner: %s",
      label,
      nStr,
      innerErrorMessage(err),
    );
    _resetSignerNonce(signer);
    return "recover";
  }
  _logTerminalError(label, bucket, err);
  throw err;
}

/** Sleep wrapper that allows the timer to be unref'd in production. */
function _sleep(ms, useUnref) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (useUnref) t.unref?.();
  });
}

/**
 * Wrap a TX-submitting function with classifier-driven retry logic.
 *
 * Behaviour per classification (see src/rpc-error-classifier.js):
 *   - "transient":               sleep, reset NonceManager, retry.
 *   - "terminal-nonce-unused":   reset NonceManager, log verbatim inner
 *                                message, throw (no retry).
 *   - "terminal-nonce-consumed":
 *       * If the error is exactly "nonce too low" / NONCE_EXPIRED AND
 *         `retryingTxWithSameNonce` is false: reset NonceManager and
 *         retry once (one-shot recovery for local nonce drift).
 *       * If `retryingTxWithSameNonce` is true: do NOT recover.  The
 *         caller deliberately reused a nonce (speedup/cancel TX), so
 *         "nonce too low" means the original TX mined — the objective
 *         was already achieved.  Throw and let the caller fall through
 *         to its success path (e.g. waiting for the original receipt).
 *       * Otherwise: log + throw without resetting.
 *   - "unknown":                 safe default — treat as
 *                                terminal-nonce-consumed.
 *
 * @param {Function} fn       Async function that submits a TX.
 * @param {string}   label    Full log prefix (used verbatim).
 * @param {object}   [opts]
 * @param {*}        [opts.signer]              Signer/NonceManager to reset on failure.
 * @param {number}   [opts.baseDelayMs]         Override retry backoff base (tests).
 * @param {boolean}  [opts.retryingTxWithSameNonce=false]
 *                   When true, the caller is sending a replacement TX at
 *                   an explicitly chosen nonce (speedup/cancel).
 *                   Suppresses nonce-too-low recovery — see JSDoc above.
 * @returns {Promise<*>}      The TX response from `fn()`.
 */
async function _retrySend(fn, label, opts = {}) {
  // Back-compat: older callers passed the base delay as the third
  // positional arg (a number).  Preserve that calling convention.
  const opt = typeof opts === "number" ? { baseDelayMs: opts } : opts || {};
  const baseMs = opt.baseDelayMs ?? _RETRY_BASE_DELAY_MS;
  const signer = opt.signer;
  const sameNonce = opt.retryingTxWithSameNonce === true;
  let recoveryUsed = false;

  for (let attempt = 0; attempt <= _RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const bucket = classifyRpcError(err);
      if (bucket === "terminal-nonce-unused") {
        _logTerminalError(label, bucket, err);
        _resetSignerNonce(signer);
        throw err;
      }
      if (bucket === "terminal-nonce-consumed" || bucket === "unknown") {
        _handleConsumed({
          label,
          bucket,
          err,
          sameNonce,
          recoveryUsed,
          signer,
        });
        // _handleConsumed returned "recover" — do NOT consume the retry
        // budget; recovery is orthogonal to transient retries.
        recoveryUsed = true;
        attempt--;
        continue;
      }
      // Transient — retry with backoff after resetting nonce so the
      // next attempt signs at the correct chain-state nonce.
      if (attempt === _RETRY_MAX) {
        _logTerminalError(label, "transient-exhausted", err);
        _resetSignerNonce(signer);
        throw err;
      }
      const delay = baseMs * (attempt + 1);
      log.warn(
        "%s: transient RPC error%s — retrying in %ds (%d/%d): %s",
        label,
        _nonceSuffix(err),
        delay / 1000,
        attempt + 1,
        _RETRY_MAX,
        innerErrorMessage(err),
      );
      _resetSignerNonce(signer);
      await _sleep(delay, baseMs >= _RETRY_BASE_DELAY_MS);
    }
  }
}

module.exports = {
  _retrySend,
  _resetSignerNonce,
  _isNonceTooLow,
  _rejectedNonce,
};
