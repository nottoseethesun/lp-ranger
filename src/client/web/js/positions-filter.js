/**
 * @file src/client/web/js/positions-filter.js
 * @description Pure-JS matcher for the LP Position Browser filter input.
 *   Has zero browser dependencies (no DOM, no localStorage, no `window`)
 *   so it can be `import`ed by both the browser bundle and Node tests.
 *
 *   The matcher searches across token addresses, token symbols, token ID,
 *   contract address, wallet address, and position type. The token-symbol
 *   coverage is the regression-relevant part — without it, typing a
 *   token symbol (e.g. "dwb") in the browser filter matches nothing.
 */

/**
 * Test whether a position-store entry matches a filter string.
 *
 * @param {object} e         Position-store entry.
 * @param {string} filter    Lowercased query string (not trimmed).
 * @returns {boolean}        True if the filter is empty or occurs in the
 *                           indexed fields joined with spaces.
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
