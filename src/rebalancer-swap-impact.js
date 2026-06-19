"use strict";

/**
 * @file src/rebalancer-swap-impact.js
 * @description
 * Price-impact gate + multi-attempt error synthesis for the swap path.
 * Extracted from rebalancer-pools.js to keep that file under the
 * project's max-lines cap.  No I/O — pure functions.
 */

/**
 * Abort swap if price impact is too high or exceeds slippage setting.
 *
 * @param {number} impactPct  Computed price impact percentage.
 * @param {number} slip       User's slippage setting (percent).
 * @param {Array<{label:string,impactPct:number}>} [attempts]  Optional
 *   shared array — when supplied, every call (including ones that pass
 *   the check) records `{ label, impactPct }` so the swap orchestrator
 *   can later synthesize a "lowest observed impact" error covering the
 *   whole chain (aggregator full → chunks → V3 router fallback).
 * @param {string} [label]    Identifier for this attempt (e.g.
 *   "9mm Aggregator (full)", "9mm V3 Router").
 */
function _checkSwapImpact(impactPct, slip, attempts, label) {
  if (Array.isArray(attempts)) {
    attempts.push({ label: label || "(unknown)", impactPct });
  }
  if (!isFinite(impactPct))
    throw new Error(
      "Swap quote validation failed: price impact is " + impactPct,
    );
  if (impactPct > slip) {
    const s = Math.ceil(impactPct * 10) / 10 + 0.5;
    const err = new Error(
      `Swap aborted: price impact ${impactPct.toFixed(1)}% exceeds slippage ${slip}%. Increase to at least ${s.toFixed(1)}% and manually rebalance.`,
    );
    err.isSwapImpactAbort = true;
    throw err;
  }
}

/**
 * Synthesize a slippage-abort error pointing at the LOWEST observed price
 * impact across the swap chain.  When a multi-step swap fails because the
 * final attempt's impact exceeded slippage, the error returned by the last
 * step often misleads — the V3 router fallback against a single low-liquidity
 * pool can post a 30% impact even though the aggregator's earlier multi-hop
 * route only saw 6%.  This helper picks the smallest impactPct from the
 * attempts log and produces a single, accurate "raise slippage to X%" message.
 *
 * Only attempts that FAILED the slippage gate (`impactPct > slip`) are
 * considered — earlier attempts that PASSED the gate (e.g., a chunk that
 * successfully executed at 3.2% under a 3.75% slippage) are not the
 * blocker and would produce a nonsensical "3.2% exceeds slippage 3.75%"
 * message.  If every attempt passed the gate, returns null and the
 * orchestrator falls back to the underlying error from whatever
 * downstream step actually failed.
 *
 * @param {Array<{label:string,impactPct:number}>} attempts  All recorded
 *   attempts (may include ones that passed the gate but failed downstream).
 * @param {number} slip  User's slippage setting (percent).
 * @returns {Error|null} Synthesized error, or null if no attempt failed
 *   the slippage gate (so this helper isn't responsible for explaining
 *   the failure).
 */
function _bestAttemptError(attempts, slip) {
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  const gateFailed = attempts.filter(
    (a) => isFinite(a.impactPct) && a.impactPct > slip,
  );
  if (gateFailed.length === 0) return null;
  const best = gateFailed.reduce((m, a) => (a.impactPct < m.impactPct ? a : m));
  const s = Math.ceil(best.impactPct * 10) / 10 + 0.5;
  const err = new Error(
    `Swap aborted: lowest observed price impact ${best.impactPct.toFixed(1)}% via ${best.label} (${attempts.length} attempts tried) exceeds slippage ${slip}%. Increase to at least ${s.toFixed(1)}% and manually rebalance.`,
  );
  err.isSwapImpactAbort = true;
  return err;
}

module.exports = { _checkSwapImpact, _bestAttemptError };
