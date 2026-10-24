"use strict";

/**
 * @file test/shipped-config-values.test.js
 * @description Every value the app ships as a default is of the right
 *   type and inside its range.
 *
 *   The files under `app-config/app-defaults-for-user-configurable/` hold
 *   the app's own answers, used wherever an operator has not given one.
 *   A wrong one is wrong on every install at once, and some would not
 *   show until the code that reads them ran: a gas-limit multiplier below
 *   one sends transactions that run out of gas, and a Bot Settings
 *   default outside its range now stops startup.
 *
 *   So every file is checked here against its JSON Schema, in
 *   src/lib/settings-file-rules.js: the schemas the server and the bot hold an
 *   install's own values to at startup (src/lib/settings-check.js). A schema
 *   names every key its file takes, and requires each, so a value added
 *   to a shipped file fails here until its schema names it, and a key a
 *   schema names that the file no longer holds fails as missing. A file
 *   added to the directory is either given a schema or named among the
 *   files that hold no settings. A few values must also agree with each
 *   other, and the last case checks those.
 *
 *   Only what ships is read, so this test passes or fails alike on every
 *   machine. The override directory is pointed at an empty one of this
 *   file's own before anything under `src/lib/` loads, because the loader
 *   reads it at load, and a developer's own overrides are not what an
 *   install receives.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-values-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const { loadShippedDefaults } = require("../src/lib/load-merged-defaults");
const {
  SETTINGS_FILE_SCHEMAS,
  NOT_SETTINGS_FILES,
  settingsFileProblems,
  agreementProblems,
} = require("../src/lib/settings-file-rules");

const DIR = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
);

/**
 * Every place in a schema without the words a refusal there would
 * quote: each value, group, list entry and name rule carries them as
 * its `description`.
 */
function wordless(schema, at = "") {
  if (schema === null || typeof schema !== "object") return [];
  const out = typeof schema.description === "string" ? [] : [at || "(file)"];
  for (const [k, sub] of Object.entries(schema.properties ?? {}))
    out.push(...wordless(sub, `${at}.${k}`));
  for (const k of ["additionalProperties", "items", "propertyNames"])
    if (typeof schema[k] === "object")
      out.push(...wordless(schema[k], `${at}.<${k}>`));
  return out;
}

describe("every value the app ships as a default", () => {
  it("is in a file this test checks, or one named as holding none", () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
    for (const f of files)
      assert.ok(
        Object.hasOwn(SETTINGS_FILE_SCHEMAS, f) ||
          Object.hasOwn(NOT_SETTINGS_FILES, f),
        `${f} is new: give it a schema in src/lib/settings-file-rules.js, ` +
          "or name it in NOT_SETTINGS_FILES",
      );
    for (const f of [
      ...Object.keys(SETTINGS_FILE_SCHEMAS),
      ...Object.keys(NOT_SETTINGS_FILES),
    ])
      assert.ok(files.includes(f), `${f} is not in the directory any more`);
  });

  for (const file of Object.keys(SETTINGS_FILE_SCHEMAS)) {
    it(`${file}: each value is named by its schema, of the right type and inside its range`, () => {
      assert.deepEqual(
        settingsFileProblems(file, loadShippedDefaults(file)),
        [],
      );
    });

    it(`${file}: every part of its schema carries the words a refusal quotes`, () => {
      assert.deepEqual(wordless(SETTINGS_FILE_SCHEMAS[file]), []);
    });
  }
});

describe("shipped values that must agree with each other", () => {
  it("agree: the cancel timer, the csrf refresh, each chain's cache tag and aggregator, the chains each setting names", () => {
    assert.deepEqual(agreementProblems(loadShippedDefaults), []);
  });
});
