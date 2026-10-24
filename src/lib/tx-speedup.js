/**
 * @file src/lib/tx-speedup.js
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
 * Lives apart from `src/lib/send-transaction.js`, and the seam is a real
 * one: nothing here consults the RPC endpoint list or the failover
 * window. It is handed a transaction and a signer and works with those
 * alone.
 */

"use strict";

const { makeError } = require("ethers");
const { log } = require("./log");
const config = require("./config");
const { _retrySend, _isNonceTooLow } = require("./tx-retry");
const { heldTransaction } = require("./held-transaction");
const { receiptGasWei } = require("./receipt-gas");
const { addSpentGas } = require("./spent-gas");

/**
 * A cancel is a 0-value self-transfer, which costs exactly the 21000 gas
 * every plain transfer does. Shared with the aggregator's own cancel.
 */
const CANCEL_GAS_LIMIT = 21000n;

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
 * Compute a cancel gas price that beats the stuck replacement TX: the
 * higher of current network gas or the stuck TX's own, times the chain's
 * `cancelGasBump` in chains.json.
 */
async function _cancelGasPrice(provider, stuckGas) {
  const fd = await provider.getFeeData();
  const cur = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
  const base = cur > stuckGas ? cur : stuckGas;
  return BigInt(Math.ceil(Number(base) * config.CHAIN.cancelGasBump));
}

/**
 * A receipt that records success, or the error ethers' own wait raises
 * for one that records a revert.
 *
 * `tx.wait()` refuses a transaction that failed on chain: it throws
 * CALL_EXCEPTION with the receipt attached, and every caller treats that
 * as the transaction reverting. Two other ways hand a receipt back without
 * that check: the replacement's receipt ethers attaches when it reports a
 * transaction replaced, and the receipt another endpoint returns when the
 * first stops answering. Through either, a reverted transaction was read
 * as confirmed: a failed swap taken as done, a failed mint reported as
 * one that returned no tokenId. Both now pass through here, so all three
 * answer a revert the same way, with the error ethers itself raises.
 *
 * A receipt without a status passes through, as it does in ethers' own
 * wait: nothing in it says the transaction failed.
 *
 * @param {object|null} receipt  A transaction receipt.
 * @returns {object|null} The same receipt.
 * @throws {Error} CALL_EXCEPTION, carrying the receipt, when it records a
 *   revert.
 */
function confirmedReceipt(receipt) {
  if (receipt === null || receipt === undefined || receipt.status !== 0)
    return receipt;
  throw makeError("transaction execution reverted", "CALL_EXCEPTION", {
    action: "sendTransaction",
    data: null,
    reason: null,
    invocation: null,
    revert: null,
    transaction: { to: receipt.to, from: receipt.from, data: "" },
    receipt,
  });
}

/**
 * Wait for a transaction's receipt, surfacing the receipt of a
 * TRANSACTION_REPLACED event and surviving the endpoint going down.
 *
 * `tx.wait()` polls the provider the transaction object was built with
 * and never asks which endpoint is current, so the endpoint it waits on
 * can be one selection has since left. Its refusal says nothing about
 * whether the transaction is on chain, and a wait that surfaced that
 * refusal as the move's own failure would abandon moves already mined —
 * leaving funds moved and nothing recorded, because gas and amounts are
 * written on the success path.
 *
 * `onWaitError` is how a refusal is answered without this module
 * learning anything about endpoints. It is handed the error and
 * decides: re-throw when the TRANSACTION is what failed, or return a
 * receipt obtained some other way when the endpoint is. It is optional
 * so that a caller with no way to reach another endpoint still gets the
 * plain `tx.wait()` behaviour; both production callers supply it.
 *
 * @param {object} tx        The transaction to wait on.
 * @param {string} label     Log label.
 * @param {Function} [onWaitError]  `(err, tx, label, budget) => Promise<receipt>`.
 * @param {{signal: AbortSignal}} budget  What ends the re-ask
 *   `onWaitError` performs: a phase's signal, aborted when the phase's
 *   own clock runs out, or the cancel's, aborted once one of the
 *   transactions competing for the nonce has mined.
 * @returns {Promise<object>} The receipt.
 */
function _tolerantWait(tx, label, onWaitError, budget) {
  return tx.wait().catch((e) => {
    if (e.code === "TRANSACTION_REPLACED" && e.receipt) {
      log.info("[send-tx] %s: TX replaced, using replacement receipt", label);
      return confirmedReceipt(e.receipt);
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
    /*-
     *  Deliberately NOT unref'd. This timer is what defines a phase,
     *  and a phase only exists while a transaction is in flight and the
     *  rebalance lock is held — work the process should stay alive to
     *  finish rather than drain out from under. Shutdown is not at risk:
     *  `server.js` force-exits `shutdown.exitTimeoutMs` after SIGINT or
     *  SIGTERM regardless of what is pending. An unref'd timer would
     *  also leave a test process nothing holding its loop open, so it
     *  would drain before the first phase elapsed, its promises
     *  unsettled.
     */
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
 * The budget it hands down carries the signal and NOTHING ELSE. A
 * re-ask inside a phase is bounded by that phase, and a clock of its own
 * would be a second bound of the same length deciding the opposite
 * thing: this phase's timeout means "go on to the next phase", while a
 * re-ask giving up means "the move failed". Two of them racing over one
 * silence would let the order the event loop happens to run two
 * callbacks decide whether a stuck transaction gets sped up or dropped.
 * The phase owns the clock, so the phase alone says when to stop.
 *
 * @param {number} ms       How long the phase waits.
 * @param {string} sentinel Message its timeout rejects with.
 * @returns {{timer: Promise, budget: {signal: AbortSignal},
 *   done: () => void}}
 */
function _phase(ms, sentinel) {
  const controller = new AbortController();
  const timer = _timeout(ms, sentinel);
  return {
    timer,
    budget: { signal: controller.signal },
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
 * Wait for one transaction's receipt, bounded by a single phase.
 *
 * The first phase of `_waitOrSpeedUp`, offered on its own for a caller
 * that brings its own recovery and wants only the waiting: ask for the
 * receipt, keep asking when an endpoint will not answer, and give up at
 * a deadline with a sentinel the caller recognises.
 *
 * **An endpoint failure is not one of the outcomes.** `onWaitError` is
 * handed the phase's signal and keeps asking other endpoints until the
 * phase ends it, so exactly three things can come back: a receipt, the
 * caller's own sentinel, or an error that describes the TRANSACTION
 * rather than an endpoint — a revert, which every endpoint would report
 * the same way. A caller can therefore branch on its sentinel and on a
 * real answer, and need no branch for "the endpoint was unreachable",
 * which is the branch that gets forgotten.
 *
 * The phase hands down its signal and no deadline of its own, so the
 * clock here is the only clock. Two of the same length would conclude
 * opposite things about one silence and let the event loop pick.
 *
 * @param {object} o
 * @param {object} o.tx               The transaction to wait on.
 * @param {string} o.label            Log label.
 * @param {Function} o.onWaitError    `(err, tx, label, budget)` — the
 *   re-ask. Injected rather than imported because the module that owns
 *   endpoint selection imports this one.
 * @param {number} o.ms               How long to wait.
 * @param {string} o.sentinel         Message the deadline rejects with.
 * @returns {Promise<object>} The receipt.
 */
async function _waitOnePhase({ tx, label, onWaitError, ms, sentinel }) {
  const phase = _phase(ms, sentinel);
  try {
    const receipt = await Promise.race([
      _settled(_tolerantWait(tx, label, onWaitError, phase.budget)),
      phase.timer,
    ]);
    return _extractReceipt(receipt);
  } finally {
    phase.done();
  }
}

/**
 * Submit a speed-up replacement at the same nonce with a bumped gas price.
 * Returns the replacement TransactionResponse, or null when none could be
 * sent: the original has already mined, or the node refused it, or the
 * gas price it is priced from could not be read. Every one of those leaves
 * the caller waiting on the original alone, and then cancelling it, so
 * none may throw past it.
 */
async function _submitSpeedUp(tx, signer, label) {
  try {
    const fd = await signer.provider.getFeeData();
    const curGas = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
    const origGas = tx.gasPrice ?? tx.maxFeePerGas ?? 0n;
    const bump = config.CHAIN.speedUpGasBump;
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
      {
        signer,
        retryingTxWithSameNonce: true,
        heldProviders: () => ({
          wait: _baseSigner(signer).provider,
          read: signer.provider,
        }),
      },
    );
    log.info(
      "[send-tx] %s: replacement TX submitted, hash= %s nonce=%d",
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
 * Send the zero-value self-transfer that cancels a stuck nonce, or learn
 * that it is not needed.
 *
 * A node refuses the cancel as "nonce too low" when the nonce is already
 * taken: by the move's own transaction, by its speed-up, or by an earlier
 * submission of this very cancel that arrived though its reply was lost,
 * and has since mined. That is not a failed cancel. The refused cancel is
 * rebuilt from the request (src/lib/held-transaction.js), whose bytes are the
 * lost copy's, and returned to be waited on with the move, so the caller
 * names whichever of them mined. An endpoint that still holds that earlier
 * submission answers "already known" instead; the cancel is recovered and
 * returned like a fresh one, since it is waiting to be mined. Any other
 * failure leaves the nonce stuck, and says so, whether the node refused
 * the cancel or the gas price it is priced from could not be read.
 *
 * @returns {Promise<object|null>} The cancel, or null when the nonce was
 *   already taken and the refused cancel cannot be rebuilt.
 * @throws {Error} "TX stuck and cancel failed" for any other failure.
 */
async function _sendCancel(tx, signer, label, stuckGas) {
  const base = _baseSigner(signer);
  try {
    const cancelGas = await _cancelGasPrice(signer.provider, stuckGas);
    const addr = await base.getAddress();
    const cancelTx = await _retrySend(
      () =>
        base.sendTransaction({
          type: config.TX_TYPE,
          to: addr,
          value: 0,
          nonce: tx.nonce,
          gasPrice: cancelGas,
          gasLimit: CANCEL_GAS_LIMIT,
        }),
      "[send-tx] " + label + " cancel nonce=" + tx.nonce,
      {
        signer: base,
        retryingTxWithSameNonce: true,
        heldProviders: () => ({ wait: base.provider, read: signer.provider }),
      },
    );
    log.info(
      "[send-tx] %s: cancel TX submitted, hash= %s nonce=%d gasPrice=%s",
      label,
      cancelTx.hash,
      cancelTx.nonce,
      String(cancelGas),
    );
    return cancelTx;
  } catch (sendErr) {
    if (_isNonceTooLow(sendErr)) {
      /*-
       *  A failed rebuild leaves the wait to the move alone, as before
       *  the cancel could be recognised; it must not fail the move.
       */
      const refused = await heldTransaction(sendErr, {
        wait: base.provider,
        read: signer.provider,
      }).catch(() => null);
      log.info(
        "[send-tx] %s: cancel refused as 'nonce too low' — nonce %d was " +
          "already taken, by the transaction, its speed-up, or an earlier " +
          "copy of this cancel whose reply was lost; waiting for %s",
        label,
        tx.nonce,
        refused === null
          ? "the transaction's receipt"
          : "whichever of them mined (cancel hash= " + refused.hash + ")",
      );
      return refused;
    }
    log.error(
      "[send-tx] %s: cancel TX failed: %s — nonce %d may still be stuck",
      label,
      sendErr.message,
      tx.nonce,
    );
    throw new Error("TX stuck and cancel failed: " + sendErr.message, {
      cause: sendErr,
    });
  }
}

/**
 * Cancel a stuck nonce, and report which transaction took it.
 *
 * Up to three transactions now compete for one nonce — the move's own,
 * its speed-up, and the cancel — and exactly one of them will mine. Which
 * one decides the result. The cancel: the move did not happen, and an
 * error marked `cancelled: true` carries the cancel's hash and gas, so
 * the caller can tell "cancelled, try again" from "failed". The move's
 * own transaction or its speed-up: the move happened after all, and its
 * receipt is returned exactly as phase 3 would have returned it.
 *
 * All of them are waited on together, through `_tolerantWait`, so an
 * endpoint that will not answer is asked of another, and a wait that
 * finds its nonce taken by one of the others hands back that one's
 * receipt. The first answer decides, and the rest are stopped. None is
 * timed: a pending transaction stays pending until something mines at
 * its nonce, and the rebalance lock is held until then by design.
 */
async function _cancelStuckNonce(
  tx,
  signer,
  label,
  replacement,
  totalMin,
  onWaitError,
) {
  log.error(
    "[send-tx] %s: TX STILL STUCK after %d min — cancelling nonce %d with a zero-value self-transfer",
    label,
    totalMin,
    tx.nonce,
  );
  const moves = replacement ? [tx, replacement] : [tx];
  const stuckGas = (replacement ?? tx).gasPrice ?? 0n;
  const cancelTx = await _sendCancel(tx, signer, label, stuckGas);
  const contenders = cancelTx ? [...moves, cancelTx] : moves;
  const settled = new AbortController();
  let receipt;
  try {
    receipt = _extractReceipt(
      await Promise.race(
        contenders.map((t) =>
          _settled(
            _tolerantWait(t, label, onWaitError, { signal: settled.signal }),
          ),
        ),
      ),
    );
  } finally {
    settled.abort();
  }
  if (moves.some((t) => t.hash === receipt.hash)) {
    log.warn(
      "[send-tx] %s: nonce %d was taken by the transaction itself, hash= %s — reporting it confirmed",
      label,
      tx.nonce,
      receipt.hash,
    );
    return receipt;
  }
  /*-
   *  Neither the move nor the cancel: something sent from this wallet
   *  outside the bot took the nonce. The move did not happen, and nothing
   *  here can say more about what did.
   */
  if (cancelTx === null || receipt.hash !== cancelTx.hash)
    throw new Error(
      `Nonce ${tx.nonce} was taken by another transaction, hash= ${receipt.hash}`,
    );
  log.info(
    "[send-tx] %s: cancel TX confirmed in block %d — nonce %d is now free",
    label,
    receipt.blockNumber,
    tx.nonce,
  );
  _resetNonce(signer);
  const cancelErr = new Error(
    "Transaction cancelled after " +
      totalMin +
      " min (nonce " +
      tx.nonce +
      " freed via a zero-value self-transfer)",
  );
  cancelErr.cancelled = true;
  cancelErr.cancelTxHash = cancelTx.hash;
  throw addSpentGas(cancelErr, receiptGasWei(receipt));
}

/**
 * Wait for a TX to confirm, automatically speeding it up after
 * TX_SPEEDUP_SEC and cancelling after TX_CANCEL_SEC.
 *
 * Four phases:
 *   1. wait up to TX_SPEEDUP_SEC for the original.
 *   2. submit a speed-up replacement at the same nonce + bumped gas.
 *   3. wait up to total TX_CANCEL_SEC for either to confirm.
 *   4. cancel the stuck nonce with a zero-value self-transfer.
 *
 * Both clocks count from `startedAt`, the transaction's first
 * submission. A transaction can reach here later than that: its
 * submission was retried after a lost reply, and the endpoint answered
 * "already known" because the first one had arrived. Counting from the
 * first submission gives it the same schedule as any other, so one whose
 * wait has already run out is sped up at once.
 *
 * @param {object} tx  The submitted transaction.
 * @param {object} signer  The signer that submitted it.
 * @param {string} label  Log label.
 * @param {Function} [onWaitError]  The re-ask; see `_tolerantWait`.
 * @param {number} [startedAt]  When the transaction was first submitted,
 *   in epoch milliseconds; now, when not given.
 * @returns {Promise<object>} The receipt of whichever transaction took
 *   the nonce for the move.
 */
async function _waitOrSpeedUp(tx, signer, label, onWaitError, startedAt) {
  /*-
   *  No literal fallbacks per feedback_one_literal_per_shipped_default:
   *  config.TX_SPEEDUP_SEC and TX_CANCEL_SEC come from `.env` or
   *  app-runtime.json through `parseTimerSec`, which refuses to start on
   *  a value outside the timer range, so both are positive numbers here.
   */
  const speedupMs = config.TX_SPEEDUP_SEC * 1000;
  const cancelMs = config.TX_CANCEL_SEC * 1000;
  const startTime = typeof startedAt === "number" ? startedAt : Date.now();

  /*-
   *  Phase 1: wait for confirmation, or fall through to speed-up.
   *
   *  Each phase hands its re-asks a signal and nothing else, aborted when
   *  the phase ends; `_phase` says why it carries no clock of its own.
   *  The signal stops a re-ask outliving the RACE that started it. A
   *  `Promise.race` abandons its losers without stopping them, and a
   *  loser here is a poll against an endpoint, released one at a time
   *  through a queue everything else shares.
   */
  const speedupPhase = _phase(
    Math.max(0, speedupMs - (Date.now() - startTime)),
    "_SPEEDUP",
  );
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

  /*-
   *  Phase 3: wait for either to confirm, or fall through to cancel.
   *  When the speed-up could not be sent, only the original is waited
   *  on, under the same clock. The usual reason is that the original
   *  mined between phases 1 and 2 and the replacement was refused as
   *  "nonce too low"; its receipt then arrives at once. Any other
   *  refusal leaves it stuck, and the cancel below is still owed.
   *
   *  Only one transaction can ever mine, so with two waits one is
   *  guaranteed to lose. That is the poll this phase must stop rather
   *  than merely stop reading.
   */
  const moves = replacement ? [tx, replacement] : [tx];
  const elapsed = Date.now() - startTime;
  const cancelIn = Math.max(
    config.TX_CANCEL_PHASE_FLOOR_SEC * 1000,
    cancelMs - elapsed,
  );
  const cancelPhase = _phase(cancelIn, "_CANCEL");
  try {
    const receipt = await Promise.race([
      ...moves.map((t) =>
        _settled(_tolerantWait(t, label, onWaitError, cancelPhase.budget)),
      ),
      cancelPhase.timer,
    ]);
    return _extractReceipt(receipt);
  } catch (err) {
    if (err.message !== "_CANCEL") throw err;
  } finally {
    cancelPhase.done();
  }

  // Phase 4: cancel the stuck nonce, and report whichever transaction took it.
  const totalMin = Math.round((Date.now() - startTime) / 60_000);
  return _cancelStuckNonce(
    tx,
    signer,
    label,
    replacement,
    totalMin,
    onWaitError,
  );
}

module.exports = {
  _waitOrSpeedUp,
  _waitOnePhase,
  confirmedReceipt,
  CANCEL_GAS_LIMIT,
};
