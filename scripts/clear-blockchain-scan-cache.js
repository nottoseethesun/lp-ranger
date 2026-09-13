#!/usr/bin/env node
/**
 * @file scripts/clear-blockchain-scan-cache.js
 * @description Delete the on-disk blockchain scan cache: every
 *   `tmp/*.json`.
 *
 * That directory holds derived scan results only — event scans, LP
 * position enumeration, P&L epochs (including the `lastNftScanBlock`
 * resume checkpoint), block timestamps, pool creation blocks, token
 * symbols, fetched prices. All of it is rebuilt from chain on the next
 * start.
 *
 * Clearing it is how you test scan behaviour from cold.
 *
 * Also the single definition of "the scan cache" for
 * `scripts/clean.js`, which used to carry its own hand-written list of
 * cache filenames. That list had drifted: three caches added since
 * survived a "full state reset". One list, one place.
 *
 * Usage:
 *   npm run clear-blockchain-scan-cache
 *   npm run clear-blockchain-scan-cache -- --dry-run
 */

"use strict";

const fs = require("fs");
const path = require("path");

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
  if (r.files.length === 0) {
    console.log("[clear-cache] Cache already empty — nothing to clear.");
    return;
  }

  if (dryRun) {
    console.log(
      `[clear-cache] DRY RUN — would delete ${r.files.length} file(s), ${human(r.bytes)}:`,
    );
    for (const f of r.files) console.log("    " + path.relative(ROOT, f));
    return;
  }

  console.log(
    `[clear-cache] Cleared ${r.removed} cache file(s), ${human(r.bytes)} freed.`,
  );
  console.log(
    "[clear-cache] Next start re-scans from chain. Let it finish so the " +
      "scan checkpoint is written.",
  );
}

if (require.main === module) main();

module.exports = { clearScanCache, runningPid, waitForServerExit, human, TMP };
