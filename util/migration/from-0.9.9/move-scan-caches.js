"use strict";

/**
 * @file util/migration/from-0.9.9/move-scan-caches.js
 * @description
 * A migration step: move the scan caches an older release kept in
 * `tmp/` into `app-data/scan-cache/`, where this release keeps them
 * (src/lib/scan-cache-dir.js), so an updated install starts warm rather than
 * re-reading every position's history from the blockchain.
 *
 * The names are the caches those releases wrote, fixed as they were; a
 * file of any other name in `tmp/` is not a cache and stays. A cache
 * already in `app-data/scan-cache/` was written by this release and is
 * kept, and the older copy stays in `tmp/` beside the other disposable
 * files.
 *
 * Runs on Node built-ins only, like the rest of the migration.
 */

const fs = require("fs");
const path = require("path");

/** The caches' file names, or the start of each name for a family. */
const _CACHE_NAMES = Object.freeze([
  "pnl-epochs-cache.json",
  "liquidity-pair-details-cache.json",
  "historical-price-cache.json",
  "block-time-cache.json",
  "gecko-pool-cache.json",
  "token-symbol-cache.json",
  "pool-creation-blocks-cache.json",
  "nft-mint-date-cache.json",
]);
const _CACHE_FAMILIES = Object.freeze(["event-cache-", "lp-position-cache-"]);

/** Whether `name` is one of the caches an older release kept in tmp/. */
function isOldScanCache(name) {
  if (_CACHE_NAMES.includes(name)) return true;
  return (
    name.endsWith(".json") && _CACHE_FAMILIES.some((f) => name.startsWith(f))
  );
}

/**
 * Move the install's old scan caches into place.
 * @param {object} o
 * @param {string} o.root     The install's folder.
 * @param {boolean} o.dryRun  Report what would move, and move nothing.
 * @returns {string[]}  One line per file moved or left in place.
 */
function moveScanCaches({ root, dryRun }) {
  const from = path.join(root, "tmp");
  const to = path.join(root, "app-data", "scan-cache");
  let names;
  try {
    names = fs.readdirSync(from).filter(isOldScanCache).sort();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const lines = [];
  for (const name of names) {
    const src = path.join(from, name);
    if (!fs.statSync(src).isFile()) continue;
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) {
      lines.push(
        `kept app-data/scan-cache/${name}, which this release wrote; tmp/${name} is left as it was`,
      );
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(to, { recursive: true });
      fs.renameSync(src, dest);
    }
    const moved = dryRun ? "would move" : "moved";
    lines.push(`${moved} tmp/${name} to app-data/scan-cache/${name}`);
  }
  return lines;
}

module.exports = { moveScanCaches, isOldScanCache };
