/**
 * @file scripts/restore-settings.js
 * @description Restore settings previously backed up by wipe-settings.js.
 * Walks tmp/.settings-backup/, moves every file back to its original
 * relative path, then removes the backup directory.
 */

"use strict";

const { log } = require("../src/log");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const BACKUP_DIR = path.join("tmp", ".settings-backup");

if (!fs.existsSync(BACKUP_DIR) || !fs.statSync(BACKUP_DIR).isDirectory()) {
  log.error("ERROR: No backup found at %s", BACKUP_DIR);
  log.error("Nothing to restore.");
  process.exit(1);
}

/**
 * Recursively collect every regular-file path under `dir`.
 * @param {string} dir
 * @returns {string[]}  Absolute-or-relative paths as walked.
 */
function walkFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

let restored = 0;

for (const src of walkFiles(BACKUP_DIR)) {
  // Relative path from BACKUP_DIR (e.g. ".env", "tmp/event-cache.json").
  const rel = path.relative(BACKUP_DIR, src);
  fs.mkdirSync(path.dirname(rel) || ".", { recursive: true });
  fs.renameSync(src, rel);
  log.info("  restored: %s", rel);
  restored++;
}

fs.rmSync(BACKUP_DIR, { recursive: true, force: true });

log.info("");
log.info("Restored %d file(s). Backup directory cleaned up.", restored);
