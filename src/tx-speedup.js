/**
 * @file src/tx-speedup.js
 * @module txSpeedup
 * @description
 * What happens while a submitted transaction is waiting to confirm.
 *
 * A chain can hold a transaction pending indefinitely, and the bot holds
 * the rebalance lock until the nonce is settled one way or the other —
 * so "wait for the receipt" is not a strategy. `_waitOrSpeedUp` is that
 * strategy: wait, then outbid, then wait again, then free the nonce.
 *
 * Four phases, each logged:
 *   1. Wait up to `TX_SPEEDUP_SEC` for the original.
 *   2. Submit a replacement at the SAME nonce with bumped gas. Same
 *      nonce is the point — whichever confirms, the other is void, so
 *      the position can never end up with two of anything.
 *   3. Wait up to `TX_CANCEL_SEC` total for either to confirm.
 *   4. Cancel: a 0-value self-transfer at the stuck nonce, priced to
 *      beat both, then throw an error marked `cancelled` so the caller
 *      resumes polling rather than treating it as a hard failure.
 *
 * Lives apart from `src/send-transaction.js`, and the seam is a real
 * one: nothing here consults the RPC endpoint list or the failover
 * window. It is handed a transaction and a signer and works with those
 * alone.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const { _retrySend } = require("./tx-retry");

/** Default speed-up gas-price bump when chain config doesn't set one. */
const _DEFAULT_SPEEDUP_GAS_BUMP = 1.5;
/** Cancel TX is a 0-value self-transfer — exactly 21000 base gas. */
const _CANCEL_GAS_LIMIT = 21000n;

/**
 * Unwrap a NonceManager (or FailoverNonceManager) to the base signer.
 * Replacement and cancel TXs explicitly reuse a stuck nonce, so they
 * MUST bypass the NonceManager (which would otherwise overwrite the
 * nonce field with its own counter).
 */
function _baseSigner(signer) {
  return signer.signer ?? signer;
}

/** Re-sync NonceManager after a cancel so its counter matches chain state. */
function _resetNonce(signer) {
  if (typeof signer.reset === "function") signer.reset();
}

/** Extract gas cost in wei from a TX receipt. */
function _receiptGas(rcpt) {
  return (rcpt.gasUsed ?? 0n) * (rcpt.gasPrice ?? rcpt.effectiveGasPrice ?? 0n);
}

/**
 * Compute a cancel gas price that beats the stuck replacement TX.
 * Uses 2× the higher of current network gas or the stuck TX's gas.
 */
async function _cancelGasPrice(provider, stuckGas) {
  const fd = await provider.getFeeData();
  const cur = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
  const base = cur > stuckGas ? cur : stuckGas;
  return base * 2n;
}

/** Wrap tx.wait() to surface the receipt of a TRANSACTION_REPLACED event. */
function _tolerantWait(tx, label) {
  return tx.wait().catch((e) => {
    if (e.code === "TRANSACTION_REPLACED" && e.receipt) {
      log.info("[send-tx] %s: TX replaced, using replacement receipt", label);
      return e.receipt;
    }
    throw e;
  });
}

/** Promise that rejects after `ms` with the given sentinel message. */
function _timeout(ms, sentinel) {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(sentinel)), ms);
    t.unref?.();
  });
}

/** Coerce whatever Promise.race returned into a TransactionReceipt. */
function _extractReceipt(result) {
  if (result && result._type === "TransactionReceipt") return result;
  if (result && result.receipt) return result.receipt;
  return result;
}

/**
 * Submit a speed-up replacement at the same nonce with a bumped gas price.
 * Returns the replacement TransactionResponse, or null when the original
 * has already been mined (so there's nothing to replace).
 */
async function _submitSpeedUp(tx, signer, label) {
  const provider = signer.provider || signer;
  const fd = await provider.getFeeData();
  const curGas = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
  const origGas = tx.gasPrice ?? tx.maxFeePerGas ?? 0n;
  const bump = config.CHAIN?.speedUpGasBump ?? _DEFAULT_SPEEDUP_GAS_BUMP;
  const bumped = BigInt(
    Math.ceil(Number(curGas > origGas ? curGas : origGas) * bump),
  );
  log.info(
    "[send-tx] %s: speedup origGas=%s curGas=%s bumped=%s nonce=%d",
    label,
    String(origGas),
    String(curGas),
    String(bumped),
    tx.nonce,
  );
  try {
    const replacement = await _retrySend(
      () =>
        _baseSigner(signer).sendTransaction({
          type: config.TX_TYPE,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          nonce: tx.nonce,
          gasLimit: tx.gasLimit,
          gasPrice: bumped,
        }),
      "[send-tx] " + label + " speedup nonce=" + tx.nonce,
      { signer, retryingTxWithSameNonce: true },
    );
    log.info(
      "[send-tx] %s: replacement TX submitted, hash=%s nonce=%d",
      label,
      replacement.hash,
      replacement.nonce,
    );
    return replacement;
  } catch (sendErr) {
    log.error(
      "[send-tx] %s: speed-up send failed (nonce=%d): %s — waiting for original",
      label,
      tx.nonce,
      sendErr.message,
    );
    return null;
  }
}

/**
 * Cancel a stuck nonce with a 0-PLS self-transfer at a beat-everyone gas
 * price.  Throws an Error annotated with `cancelled: true` so the caller
 * can distinguish "TX cancelled, retry" from "TX failed, abort".
 */
async function _cancelStuckNonce(
  tx,
  signer,
  label,
  replacement,
  bumped,
  totalMin,
) {
  const provider = signer.provider || signer;
  log.error(
    "[send-tx] %s: TX STILL STUCK after %d min — cancelling nonce %d with 0-PLS self-transfer",
    label,
    totalMin,
    tx.nonce,
  );
  const cancelGas = await _cancelGasPrice(
    provider,
    replacement?.gasPrice ?? bumped ?? 0n,
  );
  const base = _baseSigner(signer);
  const addr = await base.getAddress();
  const cancelTx = await _retrySend(
    () =>
      base.sendTransaction({
        type: config.TX_TYPE,
        to: addr,
        value: 0,
        nonce: tx.nonce,
        gasPrice: cancelGas,
        gasLimit: _CANCEL_GAS_LIMIT,
      }),
    "[send-tx] " + label + " cancel nonce=" + tx.nonce,
    { signer: base, retryingTxWithSameNonce: true },
  );
  log.info(
    "[send-tx] %s: cancel TX submitted, hash=%s nonce=%d gasPrice=%s",
    label,
    cancelTx.hash,
    cancelTx.nonce,
    String(cancelGas),
  );
  const cancelReceipt = await cancelTx.wait();
  log.info(
    "[send-tx] %s: cancel TX confirmed in block %d — nonce %d is now free",
    label,
    cancelReceipt.blockNumber,
    tx.nonce,
  );
  _resetNonce(signer);
  const cancelErr = new Error(
    "Transaction cancelled after " +
      totalMin +
      " min (nonce " +
      tx.nonce +
      " freed via 0-PLS self-transfer)",
  );
  cancelErr.cancelled = true;
  cancelErr.cancelTxHash = cancelTx.hash;
  cancelErr.cancelGasCostWei = _receiptGas(cancelReceipt);
  throw cancelErr;
}

/**
 * Wait for a TX to confirm, automatically speeding it up after
 * TX_SPEEDUP_SEC and cancelling after TX_CANCEL_SEC.
 *
 * Four phases:
 *   1. wait up to TX_SPEEDUP_SEC for the original.
 *   2. submit a speed-up replacement at the same nonce + bumped gas.
 *   3. wait up to total TX_CANCEL_SEC for either to confirm.
 *   4. cancel the stuck nonce with a 0-PLS self-transfer.
 */
async function _waitOrSpeedUp(tx, signer, label) {
  /*- No literal fallbacks per feedback_one_literal_per_shipped_default:
   *  config.TX_SPEEDUP_SEC and TX_CANCEL_SEC are sourced from
   *  app-runtime.json via parsePositiveInt; always positive numbers. */
  const speedupMs = config.TX_SPEEDUP_SEC * 1000;
  const cancelMs = config.TX_CANCEL_SEC * 1000;
  const startTime = Date.now();

  /*- Phase 1: wait for confirmation, or fall through to speed-up. */
  try {
    const receipt = await Promise.race([
      _tolerantWait(tx, label),
      _timeout(speedupMs, "_SPEEDUP"),
    ]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_SPEEDUP") throw err;
  }

  /*- Phase 2: submit the speed-up replacement. */
  log.warn(
    "[send-tx] %s: TX %s not confirmed after %ds — speeding up",
    label,
    tx.hash,
    speedupMs / 1000,
  );
  const replacement = await _submitSpeedUp(tx, signer, label);
  if (!replacement) {
    /*- Speed-up send failed — fall back to waiting for the original.
        Common case: the original confirmed between phases 1 and 2,
        so the same-nonce replacement is rejected as "nonce too low". */
    return _extractReceipt(await _tolerantWait(tx, label));
  }

  /*- Phase 3: wait for either to confirm, or fall through to cancel. */
  const elapsed = Date.now() - startTime;
  const cancelIn = Math.max(10_000, cancelMs - elapsed);
  try {
    const receipt = await Promise.race([
      _tolerantWait(tx, label),
      _tolerantWait(replacement, label),
      _timeout(cancelIn, "_CANCEL"),
    ]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_CANCEL") throw err;
  }

  /*- Phase 4: cancel the stuck nonce. Always throws (cancelled or fail). */
  const totalMin = Math.round((Date.now() - startTime) / 60_000);
  try {
    await _cancelStuckNonce(
      tx,
      signer,
      label,
      replacement,
      replacement?.gasPrice ?? 0n,
      totalMin,
    );
    /*- Unreachable: _cancelStuckNonce always throws. */
    return null;
  } catch (cancelErr) {
    if (cancelErr.cancelled) throw cancelErr;
    log.error(
      "[send-tx] %s: cancel TX failed: %s — nonce %d may still be stuck",
      label,
      cancelErr.message,
      tx.nonce,
    );
    throw new Error("TX stuck and cancel failed: " + cancelErr.message, {
      cause: cancelErr,
    });
  }
}

module.exports = { _waitOrSpeedUp };
