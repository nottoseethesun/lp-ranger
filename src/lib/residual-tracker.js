/**
 * @file src/lib/residual-tracker.js
 * @module residual-tracker
 * @description
 * Tracks token residuals left in the wallet after rebalances.  When a
 * position is rebalanced the mint may deposit slightly less than what was
 * collected (rounding, tick alignment, ratio rebalancing).  The difference
 * stays in the wallet and has real USD value that should count toward P&L.
 *
 * Residuals are accumulated per pool address and capped to the actual
 * wallet balance so that tokens the user withdrew are not double-counted.
 */

"use strict";

/**
 * Create a new residual tracker.
 * @returns {object} Tracker API.
 */
function createResidualTracker() {
  /** @type {Map<string, {token0: bigint, token1: bigint}>} */
  const pools = new Map();

  /**
   * Normalise a pool address to lowercase for consistent keying.
   * @param {string} addr
   * @returns {string}
   */
  function _key(addr) {
    return addr.toLowerCase();
  }

  /**
   * Record the delta between collected and minted amounts after a rebalance.
   * @param {string} poolAddress  Pool contract address.
   * @param {bigint} delta0       token0 collected − minted (may be negative).
   * @param {bigint} delta1       token1 collected − minted (may be negative).
   */
  function addDelta(poolAddress, delta0, delta1) {
    const k = _key(poolAddress);
    const cur = pools.get(k) || { token0: 0n, token1: 0n };
    const t0 = cur.token0 + delta0;
    const t1 = cur.token1 + delta1;
    pools.set(k, { token0: t0 > 0n ? t0 : 0n, token1: t1 > 0n ? t1 : 0n });
  }

  /**
   * Get the raw (uncapped) residual for a pool.
   * @param {string} poolAddress
   * @returns {{token0: bigint, token1: bigint}}
   */
  function getResidual(poolAddress) {
    return pools.get(_key(poolAddress)) || { token0: 0n, token1: 0n };
  }

  /**
   * Compute the USD value of the residual, capped to actual wallet balances.
   * If the wallet holds less than the expected residual for a token, only
   * the wallet balance is counted (user may have withdrawn the rest).
   * @param {string} poolAddress
   * @param {bigint} walBal0    Wallet balance of token0.
   * @param {bigint} walBal1    Wallet balance of token1.
   * @param {number} price0     Token0 USD price.
   * @param {number} price1     Token1 USD price.
   * @param {number} decimals0  Token0 decimals.
   * @param {number} decimals1  Token1 decimals.
   * @returns {number}  Residual value in USD.
   */
  function cappedValueUsd(
    poolAddress,
    walBal0,
    walBal1,
    price0,
    price1,
    decimals0,
    decimals1,
  ) {
    const r = getResidual(poolAddress);
    const eff0 = r.token0 <= walBal0 ? r.token0 : walBal0;
    const eff1 = r.token1 <= walBal1 ? r.token1 : walBal1;
    const v0 = (Number(eff0) / Math.pow(10, decimals0)) * price0;
    const v1 = (Number(eff1) / Math.pow(10, decimals1)) * price1;
    return v0 + v1;
  }

  /**
   * Serialize all pool residuals to a plain object (BigInts as strings).
   * @returns {object}
   */
  function serialize() {
    const out = {};
    for (const [k, v] of pools) {
      out[k] = {
        token0: v.token0.toString(),
        token1: v.token1.toString(),
      };
    }
    return out;
  }

  /**
   * Restore residuals from a serialized object.
   * @param {object} data  Output of serialize().
   */
  function deserialize(data) {
    if (!data || typeof data !== "object") return;
    for (const [k, v] of Object.entries(data)) {
      if (v && v.token0 !== undefined && v.token1 !== undefined) {
        pools.set(k.toLowerCase(), {
          token0: BigInt(v.token0),
          token1: BigInt(v.token1),
        });
      }
    }
  }

  return { addDelta, getResidual, cappedValueUsd, serialize, deserialize };
}

module.exports = { createResidualTracker };
