#!/usr/bin/env node
/**
 * @file scripts/clear-blockchain-scan-cache.js
 * @description Delete everything on disk that was derived from scanning
 *   the chain, so the next start rebuilds it from scratch.
 *
 * Two places hold it:
 *
 * - **`tmp/*.json`** — event scans, LP position enumeration, P&L
 *   epochs and the lifetime HODL amounts kept beside them, block
 *   timestamps, pool creation blocks, token symbols, fetched prices.
 * - **Scan-derived keys in each position's slot** in
 *   `app-config/user-configurable/bot-config.json` — compound history
 *   and totals, per-NFT gas and compound figures, the HODL baseline and
 *   amounts, and the lifetime deposit (`CHAIN_DERIVED_POSITION_KEYS`).
 *
 * The second matters as much as the first. The lifetime scan treats a
 * value already in the config as settled and does not re-derive it, so
 * clearing `tmp/` alone gives a start that is cold for the caches and
 * warm for everything the config remembers — including any error in
 * it. Settings, managed status and values recorded live that a scan
 * cannot reproduce are left alone.
 *
 * Clearing both is how you test scan behavior from cold.
 *
 * Also the single definition of "the scan cache" for
 * `scripts/clean.js`, so neither command needs a hand-written list of
 * cache filenames — a list that goes stale still reports success, and
 * the surviving cache is exactly what the caller asked to be rid of.
 *
 * Usage:
 *   npm run clear-blockchain-scan-cache
 *   npm run clear-blockchain-scan-cache -- --dry-run
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { loadConfig, saveConfig } = require("../src/bot-config-v2");
const { CHAIN_DERIVED_POSITION_KEYS } = require("../src/bot-config-keys");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, "tmp");
const PID_FILE = path.join(TMP, "lp-ranger.pid");

/**
 * The PID of a running server, or null.
 *
 * Deleting the cache under a live server achieves nothing: it rewrites
 * the files within seconds and keeps its in-memory copies regardless,
 * so the cold scan being tested would not be cold.
 * @returns {number|null}
 */
function runningPid() {
  let pid;
  try {
    pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    /*- Signal 0 tests for existence without delivering anything. */
    process.kill(pid, 0);
    return pid;
  } catch {
    /*- Stale PID file from a crash; the process is gone. */
    return null;
  }
}

/**
 * Wait for a shutting-down server to actually exit.
 *
 * `npm run clean` sends SIGTERM and then clears the cache. Shutdown is
 * not instant — the server stops every position and closes the HTTP
 * listener first — so checking once would refuse on a server that is
 * two seconds from gone. Polls instead, and only gives up if the
 * process is genuinely still there.
 * @param {number} [timeoutMs=15000]
 * @returns {number|null}  Surviving PID, or null once it is gone.
 */
function waitForServerExit(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let pid = runningPid();
  while (pid !== null && Date.now() < deadline) {
    /*- Synchronous sleep: this is a CLI step that must finish before
     *  the next one starts, and there is nothing else to do meanwhile. */
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    pid = runningPid();
  }
  return pid;
}

/** Human-readable byte count. */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Delete every `tmp/*.json`, optionally keeping some by name.
 *
 * Non-`.json` entries are left alone by design: `tmp/` also collects
 * the PID file, ad-hoc diagnostic output and developer scratch files
 * that no app code wrote and that no reset should destroy.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]      Report without deleting.
 * @param {string[]} [opts.preserve]   Bare filenames to keep.
 * @returns {{files: string[], kept: string[], removed: number, bytes: number}}
 */
function clearScanCache({ dryRun = false, preserve = [] } = {}) {
  const keep = new Set(preserve);
  let entries;
  try {
    entries = fs.readdirSync(TMP).filter((f) => f.endsWith(".json"));
  } catch {
    return { files: [], kept: [], removed: 0, bytes: 0 };
  }

  const kept = entries.filter((f) => keep.has(f));
  const files = entries
    .filter((f) => !keep.has(f))
    .map((f) => path.join(TMP, f));

  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(f).size;
    } catch {
      /*- Raced with something else removing it; it is going anyway. */
    }
  }
  if (dryRun) return { files, kept, removed: 0, bytes };

  let removed = 0;
  for (const f of files) {
    try {
      fs.unlinkSync(f);
      removed++;
    } catch (e) {
      console.error(
        `[clear-cache] Could not delete ${path.relative(ROOT, f)}: ${e.message}`,
      );
    }
  }
  return { files, kept, removed, bytes };
}

/**
 * Remove scan-derived values from every position slot in the config.
 *
 * Clears exactly `CHAIN_DERIVED_POSITION_KEYS` — the set Reload Current
 * Position clears for one position — so the two commands cannot drift
 * on what "derived from the chain" means.
 *
 * Saves only when something was removed. That is also what makes a
 * config that fails to parse safe: `loadConfig` returns an empty config
 * then, nothing is removed, and the damaged file is left for the
 * operator rather than overwritten with an empty one.
 *
 * `loadConfig` snapshots the file to `bot-config.backup.json` before
 * anything here runs, so the pre-clear values are recoverable from
 * there — until the next start, which snapshots the cleared file over
 * it.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  Report without changing anything.
 * @param {string} [opts.dir]      Config directory (tests).
 * @returns {{positions: number, keys: number}}  Slots touched, keys
 *   removed (or that would be, on a dry run).
 */
function clearScanDerivedConfig({ dryRun = false, dir } = {}) {
  const cfg = loadConfig(dir);
  let positions = 0;
  let keys = 0;
  for (const slot of Object.values(cfg.positions)) {
    let touched = false;
    for (const k of CHAIN_DERIVED_POSITION_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(slot, k)) continue;
      keys++;
      touched = true;
      if (!dryRun) delete slot[k];
    }
    if (touched) positions++;
  }
  if (!dryRun && keys > 0) saveConfig(cfg, dir);
  return { positions, keys };
}

/** Print what a dry run would do. */
function _reportDryRun(r, c) {
  console.log(
    `[clear-cache] DRY RUN — would delete ${r.files.length} cache file(s), ${human(r.bytes)}:`,
  );
  for (const f of r.files) console.log("    " + path.relative(ROOT, f));
  console.log(
    `[clear-cache] DRY RUN — would remove ${c.keys} scan-derived value(s) ` +
      `from ${c.positions} position(s) in bot-config.json.`,
  );
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pid = waitForServerExit();
  if (pid !== null) {
    console.error(
      `[clear-cache] LP Ranger is running (PID ${pid}). Stop it first:\n\n    npm stop\n`,
    );
    process.exitCode = 1;
    return;
  }

  const r = clearScanCache({ dryRun });
  const c = clearScanDerivedConfig({ dryRun });
  if (r.files.length === 0 && c.keys === 0) {
    console.log("[clear-cache] Nothing to clear — already cold.");
    return;
  }
  if (dryRun) {
    _reportDryRun(r, c);
    return;
  }

  console.log(
    `[clear-cache] Cleared ${r.removed} cache file(s), ${human(r.bytes)} freed.`,
  );
  if (c.keys > 0) {
    console.log(
      `[clear-cache] Removed ${c.keys} scan-derived value(s) from ` +
        `${c.positions} position(s) in bot-config.json. The previous ` +
        "values are in bot-config.backup.json until the next start.",
    );
  }
  console.log(
    "[clear-cache] Next start re-scans from chain. Let it finish so its " +
      "results are saved.",
  );
}

if (require.main === module) main();

module.exports = {
  clearScanCache,
  clearScanDerivedConfig,
  runningPid,
  waitForServerExit,
  human,
  TMP,
};
