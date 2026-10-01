"use strict";

/**
 * @file src/receipt-gas.js
 * @module receiptGas
 *
 * What a confirmed transaction cost, in wei.
 *
 * One expression — `gasUsed × gasPrice` — asked by every path that records a
 * charge: the rebalance's mint, the removeLiquidity multicall, both swap
 * backends, the compound's collect and increaseLiquidity, the HODL baseline's
 * mint lookup, and the closed-position history. It lives alone because a
 * second copy of it is a copy that can drift, and this one is small enough
 * that the temptation to re-type it rather than import it is exactly why it
 * had to be named.
 *
 * Two field names are tried because receipts arrive in two shapes. ethers v6
 * exposes the paid price as `gasPrice`, while `effectiveGasPrice` is the name
 * carried by v5-shaped and raw JSON-RPC receipts; a receipt from either is
 * valid input here. Both missing yields `0n` rather than a throw, because a
 * cost that cannot be determined is reported as nothing rather than crashing
 * a move that has already succeeded on chain.
 *
 * It returns wei and nothing else. Converting to dollars is a separate step
 * and belongs where the figure is displayed, per the project's rule that gas
 * is stored as coins and priced at the point of display.
 */

/**
 * The gas a receipt's transaction paid, in wei.
 *
 * @param {{gasUsed?: bigint, gasPrice?: bigint, effectiveGasPrice?: bigint}} receipt
 *   A confirmed transaction receipt, in either field shape.
 * @returns {bigint} Wei paid, or `0n` when the receipt carries neither field.
 */
function receiptGasWei(receipt) {
  return (
    (receipt.gasUsed ?? 0n) *
    (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n)
  );
}

module.exports = { receiptGasWei };
