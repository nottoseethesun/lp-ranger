"use strict";

/**
 * @file src/spent-gas.js
 * @module spentGas
 *
 * Carry the gas a move has paid to the place it is recorded, whether the
 * move succeeds or fails.
 *
 * A rebalance or a compound can pay for transactions that do not complete
 * it: an approval mined before a quote that then fails, a transaction that
 * reverts on chain, the cancel sent to free one left unconfirmed, and
 * every step that confirmed before a later one failed, such as the
 * removal of liquidity before a failed mint. Each of those was mined, so
 * each was paid for, and the payment stands whatever happens to the
 * rebalance or compound afterwards.
 *
 * The cost travels in one field, `gasCostWei`, on whatever an attempt
 * ends with. On a result it means what the attempt cost. On a thrown
 * error it means the same: what the attempt paid before it failed. So a
 * swap that gives up on one route adds that route's figure to the next
 * route's, and a rebalance or compound that fails outright still hands
 * its figure on.
 *
 * Each layer adds only the gas it paid itself, which is what lets a
 * figure pass through several layers and still be counted once:
 *   - the send path, a transaction that failed on chain;
 *   - the aggregator's retry loop, its reverted swaps and cancels;
 *   - the aggregator swap, the V3 router swap, the mint and the
 *     compound's deposit, their approvals;
 *   - the chunked swap, its earlier chunks, and the corrective swaps,
 *     their earlier rounds;
 *   - `swapIfNeeded`, the routes it gave up on;
 *   - the rebalance and the compound, the steps that confirmed before the
 *     one that failed;
 *   - `carryingGas`, around the work that follows a confirmed
 *     transaction, that transaction.
 *
 * At the end of a failed rebalance or compound, `recordSpentGas` adds the
 * figure to the open period, as compound gas is added, because nothing
 * else would count it. A failure closes no period, and most of these
 * transactions never touch the position's NFT, so the chain scans that
 * recover a position's gas cannot find them.
 *
 * Dependency-free, so the swap modules can use it without loading the
 * P&L code. The one dependency the recorder has, pricing wei in dollars,
 * is passed in by its caller.
 */

/**
 * The gas a result or a thrown error says its attempt paid.
 *
 * @param {{gasCostWei?: bigint}} outcome  A swap result, a failed
 *   rebalance's result, or a thrown error.
 * @returns {bigint} Wei paid, or `0n` when the outcome names none.
 */
function spentGasOf(outcome) {
  return outcome.gasCostWei ?? 0n;
}

/**
 * Add gas already paid to what an attempt ended with, and hand it back.
 *
 * Used on results and errors alike, so a caller can write
 * `return addSpentGas(result, wei)` or `throw addSpentGas(err, wei)`.
 *
 * @param {{gasCostWei?: bigint}} outcome  A swap result or a thrown error.
 * @param {bigint} wei  Gas paid by transactions `outcome` does not yet
 *   count.
 * @returns {object} `outcome`, now carrying the sum.
 */
function addSpentGas(outcome, wei) {
  outcome.gasCostWei = spentGasOf(outcome) + wei;
  return outcome;
}

/**
 * Run the work that follows a confirmed transaction, so a failure in it
 * carries that transaction's gas.
 *
 * A transaction is paid for the moment it is mined. What comes after it,
 * reading the balances it changed or the receipt's events, can still
 * fail, and an error raised there would otherwise leave without the gas
 * of the transaction it came after.
 *
 * @param {bigint} wei  Gas the confirmed transaction paid.
 * @param {() => *} work  What follows it; may return a promise.
 * @returns {Promise<*>} What `work` returns.
 * @throws {*} What `work` throws, now carrying `wei`.
 */
async function carryingGas(wei, work) {
  try {
    return await work();
  } catch (err) {
    throw addSpentGas(err, wei);
  }
}

/**
 * Add the gas a failed rebalance or compound paid to the open period,
 * and write the period out.
 *
 * It is written out at once because nothing else will be. No period
 * closes behind a failed move, so the tracker would hold the charge only
 * in memory until some later rebalance or compound saved it, and a
 * restart before then would lose it for good. Gas only accumulates, so a
 * lost charge cannot be rebuilt.
 *
 * The coins are recorded even when there is no dollar price for them, as
 * a successful compound's are. The tracker's `addGas` takes each figure
 * only when it is above zero, so a missing price leaves the dollar figure
 * alone and still counts what was paid.
 *
 * @param {bigint} wei  Gas the move paid, from `spentGasOf`.
 * @param {object} deps  Bot deps: `_pnlTracker`, the tracker holding the
 *   open period, and `updateBotState`, which persists it.
 * @param {(wei: bigint) => Promise<number>} toUsd  Prices wei in dollars
 *   at today's rate: `actualGasCostUsd` from `bot-pnl-updater.js`.
 */
async function recordSpentGas(wei, deps, toUsd) {
  if (wei <= 0n) return;
  const tracker = deps._pnlTracker;
  if (tracker === undefined || tracker === null) return;
  const gasUsd = await toUsd(wei);
  const gasNative = Number(wei) / 1e18;
  tracker.addGas(gasUsd, gasNative);
  if (deps.updateBotState !== undefined && deps.updateBotState !== null)
    deps.updateBotState({ pnlEpochs: tracker.serialize() });
}

module.exports = { spentGasOf, addSpentGas, carryingGas, recordSpentGas };
