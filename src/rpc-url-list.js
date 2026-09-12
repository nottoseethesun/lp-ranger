/**
 * @file src/rpc-url-list.js
 * @module rpcUrlList
 * @description
 * Composes the ordered RPC endpoint list from its three sources.
 *
 * Extracted from `src/config.js` as a pure function so it can be driven
 * directly by tests. `config.js` resolves this once at module load from
 * live files and environment, which makes the composition rule itself
 * untestable in place — and re-implementing the rule inside a test file
 * would be a mirror, which drifts from the real code and makes a green
 * test meaningless.
 *
 * Pure: no files, no environment, no logging. Callers supply the three
 * sources and get the resolved list back.
 */

"use strict";

/**
 * Build the ordered endpoint list, most-preferred first.
 *
 * Order of preference:
 *   1. `saved` — the RPC URL the operator entered in Bot Settings.
 *   2. `envOverrides` — `RPC_URL`, `RPC_URL_FALLBACK`,
 *      `RPC_URL_FALLBACK_2`, each replacing the chain entry at the same
 *      position.
 *   3. `chainUrls` — the endpoints shipped in `chains.json`.
 *
 * The saved value is **prepended**, not substituted. An operator who
 * points LP Ranger at their own node keeps the shipped endpoints behind
 * it as automatic failover — choosing a private node should not quietly
 * cost redundancy.
 *
 * Duplicates are dropped, keeping the earliest position. That makes
 * saving the shipped primary a no-op rather than listing it twice, and
 * saving an endpoint already further down the list simply promotes it.
 * It also matters at runtime: failing over from an endpoint to itself is
 * a wasted round-trip, and it makes "have I run out of endpoints?"
 * impossible to answer honestly.
 *
 * @param {object} sources
 * @param {string|null} [sources.saved]        Bot Settings RPC URL.
 * @param {Array<string|undefined>} [sources.envOverrides]  Positional
 *   env overrides; a blank entry falls through to the chain URL.
 * @param {string[]} [sources.chainUrls]       Shipped endpoints, in order.
 * @returns {string[]}  Ordered, deduplicated, blank-free.
 */
function composeRpcUrls({ saved, envOverrides = [], chainUrls = [] } = {}) {
  const out = [];
  const push = (url) => {
    if (typeof url === "string" && url.length > 0 && !out.includes(url)) {
      out.push(url);
    }
  };

  if (typeof saved === "string" && saved.trim().length > 0) push(saved.trim());

  const len = Math.max(chainUrls.length, envOverrides.length);
  for (let i = 0; i < len; i++) {
    push(envOverrides[i] || chainUrls[i]);
  }
  return out;
}

module.exports = { composeRpcUrls };
