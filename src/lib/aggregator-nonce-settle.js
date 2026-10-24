"use strict";

/**
 * @file src/lib/aggregator-nonce-settle.js
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
 * tests, without standing up a quote endpoint or a signer. The move each
 * answer allows is decided here too (`resolveSwapOutcome`), from the answer
 * alone.
 */

const { log } = require("./log");
const { receiptGasWei } = require("./receipt-gas");

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
    return (await provider.getTransactionReceipt(hash)) ?? null;
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
 * an expired timer, a rejected wait, and an RPC error during it.
 *
 * A receipt the cancel's wait did return is read by its hash, not by which
 * wait returned it. When the swap mines while its cancel is still pending,
 * ethers reports the cancel as replaced and hands back the receipt of the
 * transaction that took the nonce, which is the swap's. Read as the cancel's,
 * it would close the slot to a swap that has in fact landed, and the re-quote
 * that follows would swap the same balance a second time whenever the chain's
 * own answer for the swap had not yet arrived. A receipt in hand is not read
 * again.
 *
 * A receipt is not by itself proof the swap happened — a reverted transaction
 * has one — so the swap's `status` decides, and its three values are not a
 * gradient from strict to lax. `1` means it landed and a re-quote would swap
 * the balance twice; `0` means it consumed the nonce without moving funds and
 * a re-quote is right; absent means unknown, where sending anything risks
 * being the second swap. The rule across all of them is to send nothing while
 * unsure.
 *
 * Any transaction found here was mined, so it was paid for. When that is the
 * landed swap, its gas is the swap's own cost, which the caller reports with
 * the swap. When it is anything else, a reverted swap or the cancel, its gas
 * comes back as `spentGasWei` for the caller to count in the move's cost. That
 * includes a cancel whose own wait gave up but which the chain shows mined.
 *
 * @param {object} provider Read provider.
 * @param {string} swapHash Hash of the aggregator swap at this nonce.
 * @param {{hash: string, receipt: object|null}} cancel  What the cancel
 *   attempt reported, or a null hash when none was ever broadcast.
 * @returns {Promise<{swapReceipt: object|null, nonceSpent: boolean,
 *   spentGasWei: bigint}>}
 */
async function settleNonce(provider, swapHash, cancel) {
  const inHand = cancel.receipt;
  const held = inHand !== undefined && inHand !== null;
  const swap =
    held && inHand.hash === swapHash
      ? inHand
      : await receiptOrNull(provider, swapHash);
  if (swap !== null) {
    if (swap.status === 1)
      return { swapReceipt: swap, nonceSpent: true, spentGasWei: 0n };
    const spentGasWei = receiptGasWei(swap);
    if (swap.status === 0)
      return { swapReceipt: null, nonceSpent: true, spentGasWei };
    log.warn(
      "[aggregator] receipt for %s carries no status — treating this nonce" +
        " as unsettled rather than guessing whether the swap landed",
      swapHash,
    );
    return { swapReceipt: null, nonceSpent: false, spentGasWei };
  }
  /*-
   *  Whatever else took the nonce closed it to the swap. The cancel needs
   *  no status check: a 0-value self-transfer at 21000 gas does not
   *  revert, and a reverted transaction consumes its nonce regardless.
   *  Only the cancel's own gas is the move's cost.
   */
  if (held)
    return {
      swapReceipt: null,
      nonceSpent: true,
      spentGasWei: inHand.hash === cancel.hash ? receiptGasWei(inHand) : 0n,
    };
  const cancelReceipt =
    typeof cancel.hash === "string"
      ? await receiptOrNull(provider, cancel.hash)
      : null;
  return {
    swapReceipt: null,
    nonceSpent: cancelReceipt !== null,
    spentGasWei: cancelReceipt !== null ? receiptGasWei(cancelReceipt) : 0n,
  };
}

/**
 * Turn a settled nonce into the retry loop's next move.
 *
 * Each of the three answers from `_handleSwapError`
 * (src/lib/rebalancer-aggregator.js), which `settleNonce` gives it, has exactly
 * one safe continuation. A `swapReceipt` means the swap mined after its wait
 * expired, so it is returned as the swap's result — which is what keeps the
 * caller's router fallback from swapping the same balance a second time, since
 * that fallback treats any throw from here as "no swap happened". A spent
 * nonce means the slot is closed to the swap and a fresh quote at the next
 * nonce is safe, so this returns null and the loop continues. An unspent nonce
 * means the swap is still able to mine, and every continuation — retrying at
 * the next nonce, or falling through to the router — spends the balance twice
 * if it does, so it throws with `nonceUnsettled` set for the fallback to
 * recognise and decline. The gas paid so far goes onto that error in
 * `_sendWithRetry`, which every error from the loop leaves through.
 *
 * @param {object} a            Arguments.
 * @param {object} a.outcome    What `_handleSwapError` reported.
 * @param {object} a.tx         The submitted swap, for its `hash` and `nonce`.
 * @param {number} a.waitMs     Confirmation budget, for the message.
 * @param {bigint} a.spentGasWei Gas paid so far by reverted swaps and
 *   cancels, this attempt's included.
 * @param {string} a.ctx        Log context.
 * @param {string} a.fromSym    Sell-token symbol.
 * @param {string} a.toSym      Buy-token symbol.
 * @returns {object|null} The swap's result when it landed, its receipt
 *   included (`receipt`, read for the swap's own exchange), else null.
 */
function resolveSwapOutcome({
  outcome,
  tx,
  waitMs,
  spentGasWei,
  ctx,
  fromSym,
  toSym,
}) {
  if (outcome.swapReceipt) {
    log.info(
      "[rebalance] %s: swap (aggregator) confirmed late %s -> %s" +
        " gasUsed=%s — accepting it instead of retrying",
      ctx,
      fromSym,
      toSym,
      String(outcome.swapReceipt.gasUsed),
    );
    return {
      txHash: outcome.swapReceipt.hash,
      gasCostWei: receiptGasWei(outcome.swapReceipt) + spentGasWei,
      receipt: outcome.swapReceipt,
    };
  }
  if (outcome.nonceSpent) return null;
  const unsettled = new Error(
    "Aggregator swap nonce " +
      tx.nonce +
      " unsettled: neither the swap (" +
      tx.hash +
      ") nor its cancel confirmed within " +
      waitMs / 1000 +
      "s. Not retrying — the swap may still mine.",
  );
  unsettled.nonceUnsettled = true;
  throw unsettled;
}

module.exports = { receiptOrNull, settleNonce, resolveSwapOutcome };
