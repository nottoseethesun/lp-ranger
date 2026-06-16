#!/usr/bin/env node
/**
 * @file scripts/clear-pool-cache.js
 * @description
 * Invalidate historical-price-cache entries for one or more tokens, with
 * BEFORE/AFTER verification logging. Useful when a bad price (e.g. from a
 * swapped token-order bug, bad meme-token candle, or stale current-price
 * fallback) needs to be flushed so the next app restart re-fetches cleanly.
 *
 * Usage:
 *   node scripts/clear-pool-cache.js 0xTOKEN0 [0xTOKEN1 ...]
 *
 * Example (CRO / dickwifbutt):
 *   node scripts/clear-pool-cache.js \
 *     0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b \
 *     0xAEbcD0F8f69ECF9587e292bdfc4d731c1abedB68
 *
 * The script also clears the corresponding gecko-pool-cache entries so the
 * orientation will be re-fetched too.
 *
 * Output is grep-friendly so it can be pasted into a chat for review.
 */

"use strict";

const { log } = require("../src/log");
const fs = require("fs");
const path = require("path");

const PRICE_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  "historical-price-cache.json",
);
const GECKO_POOL_CACHE_PATH = path.join(
  process.cwd(),
  "tmp",
  "gecko-pool-cache.json",
);

/** Load JSON file, returning `{}` if missing or malformed. */
function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

/** Write JSON file prettily (2-space indent). */
function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

/** Find keys in `cache` that contain any of `needles` (case-insensitive). */
function findMatchingKeys(cache, needles) {
  const lc = needles.map((n) => n.toLowerCase());
  return Object.keys(cache).filter((k) => {
    const kl = k.toLowerCase();
    return lc.some((n) => kl.includes(n));
  });
}

/** Pretty-print a cache entry value for logging. */
function fmtValue(v) {
  if (v && typeof v === "object" && "priceUsd" in v)
    return `priceUsd=${v.priceUsd} cachedAt=${v.cachedAt || "?"}`;
  return JSON.stringify(v);
}

/** Main entry. */
function main() {
  const tokens = process.argv.slice(2);
  if (tokens.length === 0) {
    log.error(
      "usage: node scripts/clear-pool-cache.js 0xTOKEN0 [0xTOKEN1 ...]",
    );
    process.exit(1);
  }

  log.info("=== CLEAR POOL CACHE ===");
  log.info("Tokens:");
  for (const t of tokens) log.info("  " + t);
  log.info("");

  // 1) Historical price cache
  const priceCache = loadJson(PRICE_CACHE_PATH);
  const priceHits = findMatchingKeys(priceCache, tokens);
  log.info(
    `[historical-price-cache] ${priceHits.length} matching entries (of ${Object.keys(priceCache).length} total):`,
  );
  for (const k of priceHits) {
    log.info("  BEFORE " + k + " = " + fmtValue(priceCache[k]));
  }
  for (const k of priceHits) delete priceCache[k];
  saveJson(PRICE_CACHE_PATH, priceCache);
  // Verify by reloading
  const reloadedPrice = loadJson(PRICE_CACHE_PATH);
  const remainingPrice = findMatchingKeys(reloadedPrice, tokens);
  log.info(
    `[historical-price-cache] AFTER: ${remainingPrice.length} matching entries remain`,
  );
  if (remainingPrice.length > 0) {
    log.error("  ERROR: entries still present:");
    for (const k of remainingPrice) log.error("    " + k);
    process.exitCode = 2;
  }
  log.info("");

  // 2) Gecko pool cache
  const poolCache = loadJson(GECKO_POOL_CACHE_PATH);
  const poolHits = findMatchingKeys(poolCache, tokens);
  log.info(
    `[gecko-pool-cache] ${poolHits.length} matching entries (of ${Object.keys(poolCache).length} total):`,
  );
  for (const k of poolHits) {
    log.info("  BEFORE " + k + " = " + poolCache[k]);
  }
  for (const k of poolHits) delete poolCache[k];
  saveJson(GECKO_POOL_CACHE_PATH, poolCache);
  const reloadedPool = loadJson(GECKO_POOL_CACHE_PATH);
  const remainingPool = findMatchingKeys(reloadedPool, tokens);
  log.info(
    `[gecko-pool-cache] AFTER: ${remainingPool.length} matching entries remain`,
  );
  if (remainingPool.length > 0) {
    log.error("  ERROR: entries still present:");
    for (const k of remainingPool) log.error("    " + k);
    process.exitCode = 2;
  }
  log.info("");

  log.info("=== DONE ===");
  log.info(
    `Removed ${priceHits.length} price entries and ${poolHits.length} pool-info entries`,
  );
  log.info(
    "Restart the app to refetch historical prices with the new orientation.",
  );
}

main();
