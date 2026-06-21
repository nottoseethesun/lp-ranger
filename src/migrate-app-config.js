/**
 * @file src/migrate-app-config.js
 * @module migrateAppConfig
 * @description
 * One-time migration for very old installations that still keep runtime
 * config files (`.bot-config.json`, `.wallet.json`, `api-keys.json`,
 * `rebalance_log.json`, plus the legacy `.bot-config.backup.json` and
 * `.bot-config.v1.json`) at the project root.
 *
 * Target layout (see the `app-config/` section of server.js for the full
 * explanation): per-operator runtime state lives under
 * `app-config/user-configurable/`; the historical rebalance log lives
 * under `app-data/`; pure performance caches stay in `tmp/`; shipped
 * defaults live in `app-config/app-defaults-for-user-configurable/`.
 *
 * This module's `migrateAppConfig()` function is idempotent and safe:
 *
 *  - Fresh install (no legacy files at root): creates the destination
 *    directories if missing, moves nothing, returns
 *    `{ moved: 0, skipped: 0, dropped: 0 }`.
 *
 *  - Upgrade (legacy files at root, destination empty): `fs.renameSync`s
 *    each file to its new home, logs each move, returns
 *    `{ moved: N, skipped: 0, dropped: 0 }`.
 *
 *  - Conflict (both root legacy file AND destination exist): refuses
 *    to touch that file, logs a warning, returns
 *    `{ moved, skipped: >0, dropped }`. We never auto-overwrite — the
 *    user resolves manually.
 *
 *  - Drop list (`.bot-config.backup.json`, `.bot-config.v1.json`): if a
 *    root copy exists it is simply unlinked.  Backup snapshots
 *    regenerate themselves on the next config load; the v1 format has
 *    no readers.
 *
 *  - Subsequent restarts: every legacy source file is gone, nothing
 *    happens, silent.
 *
 * NOTE: This module does NOT migrate from the intermediate
 * `app-config/.bot-config.json` layout (the one that pre-dates the
 * `user-configurable/` reorg) to the current layout.  That migration is
 * documented as a manual `mv` in the release notes — see
 * [[project-approaching-battle-tested]] / clean-break rationale.
 *
 * `fs.renameSync` is atomic within a single filesystem, so there is no
 * partial-move window where a file could be lost.
 */

"use strict";

const { log } = require("./log");
const fs = require("fs");
const path = require("path");

/*- Files we migrate from the project root.  Destinations are expressed
 *  relative to the project base; `app-config/user-configurable/...` and
 *  `app-data/...` are the only two destination roots. */
const _MIGRATIONS = [
  {
    src: ".bot-config.json",
    dest: path.join("app-config", "user-configurable", "bot-config.json"),
  },
  {
    src: ".wallet.json",
    dest: path.join("app-config", "user-configurable", "wallet.json"),
  },
  {
    src: "api-keys.json",
    dest: path.join("app-config", "user-configurable", "api-keys.json"),
  },
  {
    src: "rebalance_log.json",
    dest: path.join("app-data", "rebalance_log.json"),
  },
];

/*- Legacy root files that have no destination — we simply unlink them.
 *  `.bot-config.backup.json` is regenerated on the next config load.
 *  `.bot-config.v1.json` is a dead format with no readers. */
const _DROP = [".bot-config.backup.json", ".bot-config.v1.json"];

/**
 * Move legacy root-level config files into their new homes. Idempotent.
 *
 * Creates each destination directory if it does not yet exist, then
 * iterates over the known legacy file names. For each entry in
 * `_MIGRATIONS`:
 *
 *  - If the source does not exist → skip (fresh install or already migrated).
 *  - If the source exists and the destination does not → `renameSync` it.
 *  - If both exist → log a warning and leave both files in place.
 *
 * For each entry in `_DROP`: if the file exists, unlink it.
 *
 * Prints `[migrate]` log lines for every action so the operator can see
 * exactly what happened during a server or bot restart.
 *
 * @param {string} [cwd=process.cwd()]  Base directory (overridable for tests).
 * @returns {{ moved: number, skipped: number, dropped: number }}  Migration summary.
 */
function migrateAppConfig(cwd) {
  const base = cwd || process.cwd();

  let moved = 0;
  let skipped = 0;
  let dropped = 0;

  for (const m of _MIGRATIONS) {
    const src = path.join(base, m.src);
    const dest = path.join(base, m.dest);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) {
      log.warn(
        "[migrate] REFUSING %s — both root and %s exist; leaving root file in place for manual inspection",
        m.src,
        m.dest,
      );
      skipped++;
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    log.info("[migrate] moved %s → %s", m.src, m.dest);
    moved++;
  }

  for (const f of _DROP) {
    const src = path.join(base, f);
    if (!fs.existsSync(src)) continue;
    fs.unlinkSync(src);
    log.info("[migrate] dropped legacy root file %s", f);
    dropped++;
  }

  return { moved, skipped, dropped };
}

module.exports = { migrateAppConfig, _MIGRATIONS, _DROP };
