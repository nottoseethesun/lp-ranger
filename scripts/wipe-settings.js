/**
 * @file scripts/wipe-settings.js
 * @description Back up all user settings/state to tmp/.settings-backup/
 * and remove them, simulating a fresh install. Restore with
 * `npm run restore-settings`.
 *
 * Runtime config lives under `app-config/`; see the `app-config/` section
 * of server.js for the layout.
 */

"use strict";

const { log } = require("../src/log");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const BACKUP_DIR = path.join("tmp", ".settings-backup");

if (fs.existsSync(BACKUP_DIR)) {
  log.error("ERROR: Backup already exists at %s", BACKUP_DIR);
  log.error(
    "Run 'npm run restore-settings' first, or delete %s manually.",
    BACKUP_DIR,
  );
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

/** Fixed list of single-file backups (.env at root + tmp/ epoch cache).
 *  Files under app-config/user-configurable/ and app-data/ are handled
 *  via the directory loops near the end of this script. */
const FILES = [".env", "tmp/pnl-epochs-cache.json"];

let backed = 0;

/**
 * Move `src` into the backup directory, preserving its relative path.
 * @param {string} src  Repo-relative source path.
 */
function backupOne(src) {
  const dst = path.join(BACKUP_DIR, src);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  log.info("  backed up: %s", src);
  backed++;
}

// Fixed-name files.
for (const f of FILES) {
  if (fs.existsSync(f) && fs.statSync(f).isFile()) backupOne(f);
}

// Event-cache files — glob `tmp/event-cache*.json`.
if (fs.existsSync("tmp")) {
  for (const entry of fs.readdirSync("tmp")) {
    if (entry.startsWith("event-cache") && entry.endsWith(".json")) {
      backupOne(path.join("tmp", entry));
    }
  }
}

// Keyfiles — `*.keyfile.json` and `keyfile.json` at repo root.
for (const entry of fs.readdirSync(".")) {
  if (
    entry === "keyfile.json" ||
    (entry.endsWith(".keyfile.json") && fs.statSync(entry).isFile())
  ) {
    backupOne(entry);
  }
}

// User-configurable overrides and runtime state — everything under
// app-config/user-configurable/ and app-data/ EXCEPT each dir's
// tracked README.md.  These are the canonical homes for operator
// state, and preserving them across the wipe/restore cycle mirrors the
// tarball-upgrade story.
const _OPERATOR_STATE_DIRS = [
  path.join("app-config", "user-configurable"),
  "app-data",
];
for (const dir of _OPERATOR_STATE_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "README.md") continue;
    const p = path.join(dir, entry);
    if (fs.statSync(p).isFile()) backupOne(p);
  }
}

if (backed === 0) {
  try {
    fs.rmdirSync(BACKUP_DIR);
  } catch {
    /* best-effort — directory may have been partially created */
  }
  log.info("Nothing to back up — already clean.");
} else {
  log.info("");
  log.info("Wiped %d file(s). Settings saved to %s/", backed, BACKUP_DIR);
  log.info("Run 'npm run restore-settings' to put them back.");
  log.info("");
  log.info("NOTE: Browser localStorage is not affected by this script.");
  log.info("To complete the fresh-install simulation, open the dashboard and");
  log.info('click the Settings gear icon → "Clear Local Storage & Cookies".');
}
