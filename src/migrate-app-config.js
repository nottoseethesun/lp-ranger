/**
 * @file src/migrate-app-config.js
 * @module migrateAppConfig
 * @description
 * One-time migration for existing installations that still keep runtime
 * config files (`.bot-config.json`, `.wallet.json`, `api-keys.json`,
 * `rebalance_log.json`, `.bot-config.backup.json`, `.bot-config.v1.json`)
 * at the project root.
 *
 * New layout (see the `app-config/` section of server.js for the full
 * explanation): everything the app reads or writes for its own state
 * lives under `app-config/`. Pure performance caches stay in `tmp/`.
 * Static tunables (the tracked `chains.json`, etc.) live in
 * `app-config/static-tunables/`.
 *
 * This module's `migrateAppConfig()` function is idempotent and safe:
 *
 *  - Fresh install (no legacy files at root): creates `app-config/` if
 *    missing, moves nothing, returns `{ moved: 0, skipped: 0 }`.
 *
 *  - Upgrade (legacy files at root, destination empty): `fs.renameSync`s
 *    each file into `app-config/`, logs each move, returns
 *    `{ moved: N, skipped: 0 }`.
 *
 *  - Conflict (both root legacy file AND destination exist): refuses
 *    to touch that file, logs a warning, returns `{ moved, skipped: >0 }`.
 *    We never auto-overwrite — the user resolves manually.
 *
 *  - Subsequent restarts: every legacy source file is gone, nothing
 *    happens, silent.
 *
 * `fs.renameSync` is atomic within a single filesystem, so there is no
 * partial-move window where a file could be lost.
 */

"use strict";

const fs = require("fs");
const path = require("path");

/** Files we migrate, in order. All are plain basenames at project root. */
const _MIGRATION_FILES = [
  ".bot-config.json",
  ".bot-config.backup.json",
  ".bot-config.v1.json",
  ".wallet.json",
  "api-keys.json",
  "rebalance_log.json",
];

/**
 * Move legacy root-level config files into `app-config/`. Idempotent.
 *
 * Creates the `app-config/` directory if it does not yet exist, then
 * iterates over the known legacy file names. For each:
 *
 *  - If the source does not exist → skip (fresh install or already migrated).
 *  - If the source exists and the destination does not → `renameSync` it.
 *  - If both exist → log a warning and leave both files in place.
 *
 * Prints `[migrate]` log lines for every action so the operator can see
 * exactly what happened during a server or bot restart.
 *
 * @param {string} [cwd=process.cwd()]  Base directory (overridable for tests).
 * @returns {{ moved: number, skipped: number }}  Migration summary.
 */
function migrateAppConfig(cwd) {
  const base = cwd || process.cwd();
  const appConfigDir = path.join(base, "app-config");
  fs.mkdirSync(appConfigDir, { recursive: true });

  let moved = 0;
  let skipped = 0;

  for (const f of _MIGRATION_FILES) {
    const src = path.join(base, f);
    const dest = path.join(appConfigDir, f);
    const srcExists = fs.existsSync(src);
    const destExists = fs.existsSync(dest);

    if (!srcExists) continue; // fresh install or already migrated
    if (destExists) {
      console.warn(
        "[migrate] REFUSING %s — both root and app-config/ exist; " +
          "leaving root file in place for manual inspection",
        f,
      );
      skipped++;
      continue;
    }
    fs.renameSync(src, dest);
    console.log("[migrate] moved %s → app-config/%s", f, f);
    moved++;
  }

  return { moved, skipped };
}

module.exports = { migrateAppConfig, _MIGRATION_FILES };
