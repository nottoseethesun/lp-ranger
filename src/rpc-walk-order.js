/**
 * @file src/rpc-walk-order.js
 * @module rpcWalkOrder
 * @description
 * Endpoint order for the two readers that walk the RPC list themselves
 * — `getPoolState` and the can-reopen balance check. Both build a
 * provider per URL so they can aim a retry at a named endpoint, which
 * is why they cannot use the managed read proxy. Starting at the head
 * of the list every time means a failover never moves them.
 */

"use strict";

/**
 * Rotate `urls` to begin at `selectedUrl`, keeping the list's order.
 * A URL not in the list, and a list already beginning at it, both come
 * back unchanged — which is also the answer before `init`, when there
 * is no selection to honour.
 *
 * @param {string[]} urls            Endpoints, most-preferred first.
 * @param {string|null} selectedUrl  The endpoint selection names.
 * @returns {string[]} A new array; the input is never mutated.
 */
function walkOrderFrom(urls, selectedUrl) {
  const list = Array.isArray(urls) ? [...urls] : [];
  const start = list.indexOf(selectedUrl);
  if (start <= 0) return list;
  return [...list.slice(start), ...list.slice(0, start)];
}

module.exports = { walkOrderFrom };
