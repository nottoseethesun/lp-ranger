/**
 * @file src/client/web/positions-filter.js
 * @description Pure-JS matcher for the LP Position Browser filter input.
 *   Has zero browser dependencies (no DOM, no localStorage, no `window`)
 *   so it can be `import`ed by both the browser bundle and Node tests.
 *
 *   The matcher searches across token addresses, token symbols, token ID,
 *   contract address, wallet address, and position type. The token-symbol
 *   coverage is the regression-relevant part — without it, typing the
 *   pair name (e.g. "CRO/dwb") in the browser filter matches nothing.
 */

/**
 * Test whether a position-store entry matches a filter string.
 *
 * @param {object} e         Position-store entry.
 * @param {string} filter    Lowercased query string (already trimmed).
 * @returns {boolean}        True if any indexed field includes the filter.
 */
export function matchesPosFilter(e, filter) {
  if (!filter) return true;
  const hay = [
    e.token0,
    e.token1,
    e.token0Symbol,
    e.token1Symbol,
    e.tokenId,
    e.contractAddress,
    e.walletAddress,
    e.positionType,
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(filter);
}
