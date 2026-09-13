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

const DRY_RUN = process.argv.includes("--dry-run");

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

/** Human-readable byte count. */
function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  const pid = runningPid();
  if (pid !== null) {
    console.error(
      `[clear-cache] LP Ranger is running (PID ${pid}). Stop it first:\n\n    npm stop\n`,
    );
    process.exitCode = 1;
    return;
  }

  let files;
  try {
    files = fs
      .readdirSync(TMP)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(TMP, f));
  } catch {
    console.log("[clear-cache] No tmp/ directory — nothing to clear.");
    return;
  }

  if (files.length === 0) {
    console.log("[clear-cache] Cache already empty — nothing to clear.");
    return;
  }

  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(f).size;
    } catch {
      /*- Raced with something else removing it; it is going anyway. */
    }
  }

  if (DRY_RUN) {
    console.log(
      `[clear-cache] DRY RUN — would delete ${files.length} file(s), ${human(bytes)}:`,
    );
    for (const f of files) console.log("    " + path.relative(ROOT, f));
    return;
  }

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

  console.log(
    `[clear-cache] Cleared ${removed} cache file(s), ${human(bytes)} freed.`,
  );
  console.log(
    "[clear-cache] Next start re-scans from chain. Let it finish so the " +
      "scan checkpoint is written.",
  );
}

main();
