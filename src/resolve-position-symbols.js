/**
 * @file src/resolve-position-symbols.js
 * @module resolve-position-symbols
 * @description
 * Populate `position.token0Symbol` and `position.token1Symbol` so every
 * downstream log site (bot-recorder*, bot-hodl-scan, compounder,
 * position-details*) can substitute real names instead of
 * "Token0"/"Token1" placeholders.
 *
 * Routes through the existing dashboard resolver (`resolveSymbolMap`),
 * which already caches as a side effect — no new caching layer is
 * introduced here.  The on-disk symbol cache is checked first to skip
 * the on-chain lookup when a prior dashboard scan already resolved it.
 * Tolerates failure: leaves `position.tokenNSymbol` undefined so the
 * existing `|| "Token0"` fallbacks still kick in.
 */
"use strict";

const { resolveSymbolMap } = require("./server-scan");
const { getTokenSymbol } = require("./token-symbol-cache");

const _SLOTS = [
  { addrKey: "token0", symKey: "token0Symbol" },
  { addrKey: "token1", symKey: "token1Symbol" },
];

/** Resolve token symbols and attach them to the position object in place. */
async function resolvePositionSymbols(provider, position) {
  if (!position) return;
  const toResolve = new Set();
  for (const { addrKey, symKey } of _SLOTS) {
    if (position[symKey]) continue;
    const addr = position[addrKey];
    if (!addr) continue;
    const cached = getTokenSymbol(addr);
    if (cached) {
      position[symKey] = cached;
      continue;
    }
    toResolve.add(addr);
  }
  if (toResolve.size === 0) return;
  const symMap = await resolveSymbolMap(provider, toResolve).catch(() => ({}));
  for (const { addrKey, symKey } of _SLOTS) {
    if (position[symKey]) continue;
    const sym = symMap[position[addrKey]];
    if (sym && !sym.startsWith("0x")) position[symKey] = sym;
  }
}

module.exports = { resolvePositionSymbols };
