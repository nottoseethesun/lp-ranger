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
const config = require("./config");
const {
  classifyRpcError,
  innerErrorMessage,
} = require("./rpc-error-classifier");
const { heldTransaction } = require("./held-transaction");

/*-
 *  How often a transient failure is retried, and the delay the waits
 *  are multiples of: `tx.sendRetries` and `tx.sendRetryBaseDelayMs` in
 *  app-runtime.json, checked at startup by `src/config.js`.
 */
const _RETRY_MAX = config.TX_SEND_RETRIES;
const _RETRY_BASE_DELAY_MS = config.TX_SEND_RETRY_BASE_DELAY_MS;

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
 * local NonceManager counter.  Distinct from the other terminal-nonce-
 * consumed case, "replacement underpriced", which would loop forever.
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

/**
 * Take an "already known" answer as the submission it is.
 *
 * The endpoint holds this exact transaction already: an earlier attempt
 * arrived though its reply was lost. So the transaction is recovered
 * from the request and handed back as submitted, and the caller waits on
 * it, speeding it up and cancelling it on the usual schedule. When it
 * cannot be recovered, the answer is logged and thrown as a terminal
 * error, since nothing the caller holds can be waited on.
 *
 * @param {*} err  The error carrying the endpoint's answer.
 * @param {string} label  Full log prefix.
 * @param {object} opts  `_retrySend`'s options, for `heldProviders`.
 * @returns {Promise<object>} The transaction the endpoint holds.
 * @throws {*} `err`, when the transaction cannot be recovered.
 */
async function _heldOrThrow(err, label, opts) {
  const providers =
    typeof opts.heldProviders === "function" ? opts.heldProviders() : null;
  const held = await heldTransaction(err, providers);
  if (held === null) {
    _logTerminalError(label, "already-known, not recoverable", err);
    throw err;
  }
  log.info(
    "%s: the endpoint already holds this transaction, hash= %s nonce=%d — waiting on it",
    label,
    held.hash,
    held.nonce,
  );
  return held;
}

/** Sleep wrapper that allows the timer to be unref'd in production. */
function _sleep(ms, useUnref) {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    if (useUnref) t.unref?.();
  });
}

/**
 * Submit a transaction with classifier-driven retry logic, and say when
 * the transaction handed back was first submitted.
 *
 * That time is what the speed-up and the cancel are timed from, so it
 * has to be the time the transaction has really been waiting. A
 * transaction accepted on a retry was submitted when that attempt
 * began: the attempts before it failed, and the waits between them are
 * not time it spent pending. A transaction an endpoint answers "already
 * known" reached it on an earlier attempt whose reply was lost, so it is
 * timed from the first attempt, and one already pending past the
 * speed-up time is sped up at once.
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
 *   - "already-known":           the endpoint holds this exact
 *                                transaction already. Recover it from
 *                                the request and return it as
 *                                submitted, so the caller waits on it.
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
 * @param {Function} [opts.heldProviders]  `() => ({wait, read})`, called
 *                   only when an endpoint answers "already known": `wait`
 *                   is the provider the recovered transaction is waited
 *                   on through, `read` the one the current block is read
 *                   from. Without it that answer stays a terminal error.
 * @returns {Promise<{tx: *, submittedAt: number}>}  The TX response from
 *   `fn()`, or the transaction an endpoint said it already holds, and
 *   when it was first submitted, in epoch milliseconds.
 */
async function _retrySendTimed(fn, label, opts = {}) {
  const baseMs = opts.baseDelayMs ?? _RETRY_BASE_DELAY_MS;
  const signer = opts.signer;
  const sameNonce = opts.retryingTxWithSameNonce === true;
  const firstAttemptAt = Date.now();
  let recoveryUsed = false;

  for (let attempt = 0; attempt <= _RETRY_MAX; attempt++) {
    const attemptAt = Date.now();
    try {
      const tx = await fn();
      return { tx, submittedAt: attemptAt };
    } catch (err) {
      const bucket = classifyRpcError(err);
      if (bucket === "already-known") {
        const held = await _heldOrThrow(err, label, opts);
        return { tx: held, submittedAt: firstAttemptAt };
      }
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

/**
 * `_retrySendTimed`, for a caller that waits on the transaction by
 * another clock or by none: the speed-up and the cancel themselves.
 *
 * @param {Function} fn     Async function that submits a TX.
 * @param {string}   label  Full log prefix (used verbatim).
 * @param {object}   [opts] As `_retrySendTimed` takes them.
 * @returns {Promise<*>}  The TX response from `fn()`, or the transaction
 *   an endpoint said it already holds.
 */
async function _retrySend(fn, label, opts = {}) {
  const { tx } = await _retrySendTimed(fn, label, opts);
  return tx;
}

module.exports = {
  _retrySend,
  _retrySendTimed,
  _resetSignerNonce,
  _isNonceTooLow,
  _rejectedNonce,
};
