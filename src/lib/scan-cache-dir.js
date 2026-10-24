"use strict";

/**
 * @file src/lib/scan-cache-dir.js
 * @module scanCacheDir
 * @description
 * Where the scan caches live: `app-data/scan-cache/` in the install's
 * folder.
 *
 * A scan cache holds what LP Ranger read from the blockchain or a price
 * service, so it need not read it again: each pool's rebalance history,
 * the wallet's positions, the Per-Day P&L periods, the leftover coins
 * from each pool's first mint, historical prices, block times, pool
 * creation blocks, NFT mint dates and token symbols. All of it can be
 * read again, but that takes about an hour per position and spends
 * price-service quota, so it lives with the install's other data in
 * `app-data/`, which an update carries forward. `tmp/` keeps only what is
 * disposable: the server's process id file and scratch output.
 * `npm run clear-blockchain-scan-cache` empties this folder.
 *
 * Under `node --test` the folder is one of the test process's own temp
 * folders (src/lib/test-temp-folders.js), as bot-config.json's is, so no test
 * reads or writes the operator's caches. It is resolved per call, so the
 * answer is never fixed before a test process has identified itself.
 */

const path = require("path");
const { makeTestTempFolder } = require("./test-temp-folders");

/** This test process's folder, made the first time one is asked for. */
let _testDir = null;

/**
 * The folder the scan caches live in.
 * @returns {string}
 */
function scanCacheDir() {
  if (process.env.NODE_TEST_CONTEXT === undefined)
    return path.join(process.cwd(), "app-data", "scan-cache");
  if (_testDir === null) _testDir = makeTestTempFolder("scan-cache");
  return _testDir;
}

/**
 * Where the scan cache named `fileName` lives.
 * @param {string} fileName  The cache's file name, e.g.
 *   `block-time-cache.json`.
 * @returns {string}
 */
function scanCachePath(fileName) {
  return path.join(scanCacheDir(), fileName);
}

module.exports = { scanCacheDir, scanCachePath };
