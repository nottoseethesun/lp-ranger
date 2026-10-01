"use strict";

/**
 * @file src/aggregator-nonce-settle.js
 * @module aggregatorNonceSettle
 *
 * Answers one question for the aggregator's swap path: **which transaction
 * owns this nonce?**
 *
 * A swap whose confirmation budget expires is followed by a cancel at the same
 * nonce, so two transactions compete for one slot and at most one of them can
 * ever mine. Which one did decides what the caller may do next, and the three
 * answers have exactly one safe continuation each — report the swap, re-quote
 * at the next nonce, or send nothing at all. Getting that wrong is not a
 * cosmetic error: `swapIfNeeded` falls back to the V3 router on any unflagged
 * failure, so an answer of "the swap did not happen" when it did spends the
 * same balance twice.
 *
 * It lives apart from `rebalancer-aggregator.js` because that file sits at the
 * project's 500-line cap and because this is a separable concept with no
 * dependency on the retry loop around it: given a provider and two hashes it
 * reaches only the chain. That also lets the decision be driven directly in
 * tests, without standing up a quote endpoint or a signer.
 */

const { log } = require("./log");

/**
 * Read a receipt, treating an unreadable answer as no answer.
 *
 * A read that throws leaves the nonce's owner unknown, which is the state the
 * caller must treat most cautiously, so the failure resolves to null rather
 * than propagating: an error escaping here would reach the swap fallback as an
 * ordinary failure and earn a second swap, which is the outcome this whole
 * path exists to prevent. It is logged, because "unknown" chosen by an RPC
 * error should be visible in the record.
 *
 * @param {object} provider Read provider.
 * @param {string} hash     Transaction hash to look up.
 * @returns {Promise<object|null>} The receipt, or null if absent or unreadable.
 */
async function receiptOrNull(provider, hash) {
  try {
    return await provider.getTransactionReceipt(hash);
  } catch (readErr) {
    log.warn(
      "[aggregator] could not read receipt for %s: %s —" +
        " treating this nonce as unsettled",
      hash,
      readErr.message,
    );
    return null;
  }
}

/**
 * Decide which transaction owns a nonce once the swap's wait has expired.
 *
 * A receipt for the swap means it landed and there is nothing to retry. A
 * receipt for the cancel means the slot is spent, the swap can never mine, and
 * a fresh quote at the next nonce is safe. Neither means the slot is still
 * open and the swap may yet mine — the one state in which sending anything
 * risks swapping the same balance a second time.
 *
 * The chain is asked directly rather than the cancel's own `wait()` being
 * trusted, because that wait collapses three different outcomes into a null:
 * an expired timer, a rejected wait, and an RPC error during it. A cancel
 * receipt already in hand is taken as given and not re-read.
 *
 * A receipt is not by itself proof the swap happened — a reverted transaction
 * has one — so the swap's `status` decides, and its three values are not a
 * gradient from strict to lax. `1` means it landed and a re-quote would swap
 * the balance twice; `0` means it consumed the nonce without moving funds and
 * a re-quote is right; absent means unknown, where sending anything risks
 * being the second swap. The rule across all of them is to send nothing while
 * unsure.
 *
 * @param {object} provider Read provider.
 * @param {string} swapHash Hash of the aggregator swap at this nonce.
 * @param {{hash: string, receipt: object|null}} cancel  What the cancel
 *   attempt reported, or a null hash when none was ever broadcast.
 * @returns {Promise<{swapReceipt: object|null, nonceSpent: boolean}>}
 */
async function settleNonce(provider, swapHash, cancel) {
  const swap = await receiptOrNull(provider, swapHash);
  if (swap) {
    if (swap.status === 1) return { swapReceipt: swap, nonceSpent: true };
    if (swap.status === 0) return { swapReceipt: null, nonceSpent: true };
    log.warn(
      "[aggregator] receipt for %s carries no status — treating this nonce" +
        " as unsettled rather than guessing whether the swap landed",
      swapHash,
    );
    return { swapReceipt: null, nonceSpent: false };
  }
  /*- The cancel needs no status check: a 0-value self-transfer at 21000
   *  gas does not revert, and a reverted transaction consumes its nonce
   *  regardless, so either way the slot is closed to the swap. */
  if (cancel.receipt) return { swapReceipt: null, nonceSpent: true };
  const cancelReceipt = cancel.hash
    ? await receiptOrNull(provider, cancel.hash)
    : null;
  return { swapReceipt: null, nonceSpent: Boolean(cancelReceipt) };
}

module.exports = { receiptOrNull, settleNonce };
