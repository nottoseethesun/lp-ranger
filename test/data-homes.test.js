"use strict";

/**
 * @file test/data-homes.test.js
 * @description NEVER PUT CACHE DATA IN A CONFIGURATION FILE.
 *
 *   Each kind of data has one home. Files under `app-config/` hold only
 *   what the operator chooses: the settings, the managed positions, the
 *   encrypted wallet and api keys, and the shipped defaults with the
 *   operator's copies. What is read from the blockchain or a price
 *   service, kept to save reading it again, is in `app-data/scan-cache/`
 *   (src/lib/scan-cache-dir.js). What the bot records about a position is in
 *   `app-data/position-records.json` (src/lib/util/position-records.js). `tmp/`
 *   holds nothing worth keeping: the server's PID file alone of what the
 *   app writes.
 *
 *   Ten kinds of record once piled up in bot-config.json, one at a time,
 *   because the file was already keyed per position, and the scan caches
 *   sat in `tmp/`. These cases read the source, with its comments
 *   removed, so a module that puts data anywhere else fails the build.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  POSITION_KEYS,
  SETTING_POSITION_KEYS,
  RECORD_POSITION_KEYS,
} = require("../src/lib/bot-config-keys");

/*- The app's module folders: the modules the programs share, the
 *  server's own and the bot's own, each with its subfolders. */
const SRC_DIRS = ["lib", "server", "bot"].map((d) =>
  path.join(__dirname, "..", "src", d),
);

/**
 * Every .js file under `dir`, in its subfolders too (src/lib/util/, the
 * telegram-notifications/ folders), as `[file name, path]`.
 * @param {string} dir
 * @returns {Array<[string, string]>}
 */
function jsFilesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFilesUnder(p);
    return e.name.endsWith(".js") ? [[e.name, p]] : [];
  });
}

/** Each module in those folders, by file name, as code with comments removed. */
const MODULES = SRC_DIRS.flatMap(jsFilesUnder).map(([f, p]) => [
  f,
  fs
    .readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, ""),
]);

/*-
 *  The modules that own a file under app-config/, each something the
 *  operator chooses or the shipped defaults: the settings, the wallet,
 *  the api keys, the defaults and their copies, and the one-time move of
 *  an old layout's files into app-config/.
 */
const APP_CONFIG_OWNERS = [
  "bot-config-v2.js",
  "wallet-manager.js",
  "api-key-store.js",
  "load-merged-defaults.js",
  "migrate-app-config.js",
];

describe("where each kind of data is kept", () => {
  it("reads every module, those in subfolders included", () => {
    /*-
     *  The records file's own module sits in src/lib/util/; a check that
     *  skipped subfolders would leave it, and the Telegram modules,
     *  unread.
     */
    const names = MODULES.map(([f]) => f);
    for (const f of [
      "position-records.js",
      "telegram.js",
      "balanced-notifier.js",
    ])
      assert.ok(names.includes(f), `${f} is read`);
  });

  it("names a cache's file only through scanCachePath, in the scan-cache folder", () => {
    for (const [file, code] of MODULES) {
      const named = code.match(/["'`][\w$\-{}.]*cache[\w$\-{}.]*\.json["'`]/g);
      for (const literal of named ?? []) {
        const at = code.indexOf(literal);
        const before = code.slice(Math.max(0, at - 20), at);
        assert.match(
          before,
          /scanCachePath\(\s*$/,
          `${file} names the cache ${literal} outside scanCachePath`,
        );
      }
    }
  });

  /*-
   *  A path built into a folder, as against a message that names it to
   *  the operator: the folder as one of `path.join`'s parts.
   */
  const builtInto = (folder) =>
    new RegExp(`path\\.(join|resolve)\\([^;]*["'\`]${folder}["'\`]`);

  it("puts nothing under app-config/ but what its owners keep there", () => {
    for (const [file, code] of MODULES) {
      if (APP_CONFIG_OWNERS.includes(file)) continue;
      assert.doesNotMatch(
        code,
        builtInto("(app-config|user-configurable)"),
        `${file} builds a path into app-config/: only what the operator chooses goes there`,
      );
    }
  });

  it("keeps nothing in tmp/ but the server's PID file", () => {
    for (const [file, code] of MODULES) {
      if (file === "server-pid.js") continue;
      assert.doesNotMatch(
        code,
        builtInto("tmp"),
        `${file} builds a path into tmp/: nothing worth keeping goes there`,
      );
    }
  });

  it("makes every position key a setting or a record, never both", () => {
    const both = SETTING_POSITION_KEYS.filter((k) =>
      RECORD_POSITION_KEYS.includes(k),
    );
    assert.deepEqual(both, []);
    assert.deepEqual(
      [...SETTING_POSITION_KEYS, ...RECORD_POSITION_KEYS].sort(),
      [...POSITION_KEYS].sort(),
    );
  });
});
