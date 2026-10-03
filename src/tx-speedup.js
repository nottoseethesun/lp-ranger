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
const { receiptGasWei } = require("./receipt-gas");

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

/**
 * Wait for a transaction's receipt, surfacing the receipt of a
 * TRANSACTION_REPLACED event and surviving the endpoint going down.
 *
 * `tx.wait()` polls the provider the transaction object was built with
 * and never asks which endpoint is current, so an endpoint that fails
 * mid-wait took the whole move down with it — including moves whose
 * transaction had already been mined. On Production 2026-09-30 the
 * failover moved off a failing endpoint three seconds before a compound
 * died on a 502 from the endpoint it had just left; the fee collection
 * was on chain, and the fees were stranded in the wallet.
 *
 * `onWaitError` is how that is repaired without this module learning
 * about endpoints. It is handed the error and decides: re-throw when
 * the transaction is what failed, or return a receipt obtained some
 * other way when the endpoint is. It is optional so that a caller with
 * no way to reach another endpoint still gets the plain `tx.wait()`
 * behaviour; the one production caller always supplies it.
 *
 * @param {object} tx        The transaction to wait on.
 * @param {string} label     Log label.
 * @param {Function} [onWaitError]  `(err, tx, label, budget) => Promise<receipt>`.
 * @param {{deadlineMs: number, signal?: AbortSignal}} [budget]
 *   How long the phase will still be interested, and the signal it
 *   raises when it stops being.
 * @returns {Promise<object>} The receipt.
 */
function _tolerantWait(tx, label, onWaitError, budget) {
  return tx.wait().catch((e) => {
    if (e.code === "TRANSACTION_REPLACED" && e.receipt) {
      log.info("[send-tx] %s: TX replaced, using replacement receipt", label);
      return e.receipt;
    }
    if (!onWaitError) throw e;
    return onWaitError(e, tx, label, budget);
  });
}

/** Promise that rejects after `ms` with the given sentinel message. */
function _timeout(ms, sentinel) {
  let done;
  let handle;
  const promise = new Promise((resolve, reject) => {
    done = resolve;
    /*- Deliberately NOT unref'd. This timer is what defines a phase,
     *  and a phase only exists while a transaction is in flight and the
     *  rebalance lock is held — work the process should stay alive to
     *  finish rather than drain out from under. Shutdown is not at risk:
     *  `server.js` force-exits three seconds after SIGINT or SIGTERM
     *  regardless of what is pending.
     *
     *  It was unref'd before, which is why nothing could test these
     *  phases: with every timer here unref'd, a test process has
     *  nothing holding the loop open and drains before the first phase
     *  elapses, leaving promises unsettled. */
    handle = setTimeout(() => reject(new Error(sentinel)), ms);
  });
  /*- Called once the race it belongs to has settled. Clearing the timer
   *  alone would leave this promise pending for the life of the
   *  process — the losing branch of a race still holding something —
   *  so it is also resolved. Nothing observes that value: the race has
   *  already chosen by the time this runs. */
  promise.cancel = () => {
    clearTimeout(handle);
    done();
  };
  return promise;
}

/**
 * One phase of the wait: its timeout, the budget it hands to a re-ask,
 * and the one call that ends both.
 *
 * A phase is a `Promise.race`, and a race abandons its losers rather
 * than stopping them — so without this, a timed-out phase leaves its
 * timer armed and its receipt poll running against an endpoint, both
 * for as long as their own deadlines allow, while the move has already
 * gone on to the next phase. `done()` in a `finally` is what makes
 * "this phase is over" mean the phase is actually over.
 *
 * @param {number} ms       How long the phase waits.
 * @param {string} sentinel Message its timeout rejects with.
 * @returns {{timer: Promise, budget: {deadlineMs: number, signal: AbortSignal},
 *   done: () => void}}
 */
function _phase(ms, sentinel) {
  const controller = new AbortController();
  const timer = _timeout(ms, sentinel);
  return {
    timer,
    budget: { deadlineMs: ms, signal: controller.signal },
    done: () => {
      timer.cancel();
      controller.abort();
    },
  };
}

/**
 * Keep an abandoned racer's rejection from going unhandled.
 *
 * `Promise.race` abandons its losers without stopping them. An
 * abandoned receipt wait rejects as soon as the phase's `done()` aborts
 * its signal, because the re-ask rethrows the error that started it —
 * and by then the race has settled, so nothing is listening.
 *
 * That matters more than an untidy warning. The process-wide guard in
 * `server-error-guard.js` treats an unhandled rejection as fatal and
 * calls `process.exit(1)` unless its code is `TIMEOUT`,
 * `NETWORK_ERROR` or `SERVER_ERROR`. A re-ask is entered for every
 * failover-eligible error, which also includes a refused connection, an
 * unresolvable host and the 4xx answers that describe an endpoint —
 * none of them on that list. So the endpoint dying at the moment a
 * phase ends could stop the bot mid-move, and in phase 3 a loser is not
 * a coincidence: only one of the two transactions can ever mine.
 *
 * Absorbed rather than logged, because the rejection carries nothing
 * the phase has not already acted on by moving past it.
 *
 * @param {Promise} p  A racer whose loss is expected.
 * @returns {Promise}  The same promise, for the race to use.
 */
function _settled(p) {
  p.catch(() => {});
  return p;
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
  cancelErr.cancelGasCostWei = receiptGasWei(cancelReceipt);
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
async function _waitOrSpeedUp(tx, signer, label, onWaitError) {
  /*- No literal fallbacks per feedback_one_literal_per_shipped_default:
   *  config.TX_SPEEDUP_SEC and TX_CANCEL_SEC are sourced from
   *  app-runtime.json via parsePositiveInt; always positive numbers. */
  const speedupMs = config.TX_SPEEDUP_SEC * 1000;
  const cancelMs = config.TX_CANCEL_SEC * 1000;
  const startTime = Date.now();

  /*- Phase 1: wait for confirmation, or fall through to speed-up.
   *
   *  Each phase hands down its own remaining budget AND a signal. The
   *  budget stops a re-ask outliving the phase that started it; the
   *  signal stops it outliving the RACE that started it, which is
   *  sooner and matters more. A `Promise.race` abandons its losers
   *  without stopping them, and a loser here is a poll against an
   *  endpoint, released one at a time through a queue everything else
   *  shares. */
  const speedupPhase = _phase(speedupMs, "_SPEEDUP");
  try {
    const receipt = await Promise.race([
      _settled(_tolerantWait(tx, label, onWaitError, speedupPhase.budget)),
      speedupPhase.timer,
    ]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_SPEEDUP") throw err;
  } finally {
    speedupPhase.done();
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
    /*- Nothing races this one, so it needs neither a timeout nor a
     *  signal: there is no loser to stop, and the move's own remaining
     *  budget is the only bound there is. A phase object here would add
     *  a timer whose rejection nobody is waiting for. */
    return _extractReceipt(
      await _tolerantWait(tx, label, onWaitError, {
        deadlineMs: Math.max(0, cancelMs - (Date.now() - startTime)),
      }),
    );
  }

  /*- Phase 3: wait for either to confirm, or fall through to cancel. */
  const elapsed = Date.now() - startTime;
  const cancelIn = Math.max(10_000, cancelMs - elapsed);
  /*- Two waits here, and only one transaction can ever mine, so one of
   *  them is guaranteed to be a loser. That is the poll this phase must
   *  stop rather than merely stop reading. */
  const cancelPhase = _phase(cancelIn, "_CANCEL");
  try {
    const receipt = await Promise.race([
      _settled(_tolerantWait(tx, label, onWaitError, cancelPhase.budget)),
      _settled(
        _tolerantWait(replacement, label, onWaitError, cancelPhase.budget),
      ),
      cancelPhase.timer,
    ]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_CANCEL") throw err;
  } finally {
    cancelPhase.done();
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
