/**
 * @file dashboard-routing-labels.js
 * @description Display labels for swap-routing indicators (Mission
 *   Control "Routing through:" badge and related UI).
 *
 *   These are the client-side copies of the labels the server stamps
 *   onto rebalance results.  Because the dashboard bundle can't require
 *   Node modules directly, we maintain parallel constants here and on
 *   the server.  Keep them in sync:
 *
 *     server: src/rebalancer-aggregator.js    → AGGREGATOR_LABEL
 *     server: src/rebalancer-swap.js          → "9mm V3 Router"  (inline)
 *     HTML pre-render default in public/index.html must also match.
 */

/** Primary swap path — always shown on the badge when no rebalance
 *  override is active.  MUST equal AGGREGATOR_LABEL exported from
 *  src/rebalancer-aggregator.js. */
export const AGGREGATOR_LABEL = "9mm Aggregator";
