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
 *   So every value in every file is checked here, by exactly one of three
 *   rules, all in src/settings-file-rules.js. A value with a range in
 *   `setting-bounds.json`, at its own path, is held to that range, read
 *   from the same file the app reads. A value that becomes a timer delay
 *   is held to the timer rule in `src/timer-bounds.js`, under the name the
 *   app checks it by. Every other value is named in `SETTINGS_FILE_RULES`
 *   with the kind of value it must be: true or false, a whole number, an
 *   http address, an EIP-55 address, and so on. A few values must also
 *   agree with each other, and the last case checks those. The server and
 *   the bot hold an install's own values to the same rules at startup
 *   (src/settings-check.js).
 *
 *   Nothing is left out by accident. A value no rule covers fails, naming
 *   its path, and so does a rule that names no value, so a value added or
 *   renamed has to be given its check. So does a file added to the
 *   directory: it is either given rules or named among the files that hold
 *   no settings.
 *
 *   Only what ships is read, so this test passes or fails alike on every
 *   machine. The override directory is pointed at an empty one of this
 *   file's own before anything under `src/` loads, because the loader
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

const { loadShippedDefaults } = require("../src/load-merged-defaults");
const {
  SETTINGS_FILE_RULES,
  NOT_SETTINGS_FILES,
  settingsFileProblems,
  agreementProblems,
  leaves,
  rangeAt,
  matches,
} = require("../src/settings-file-rules");

const DIR = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
);
const CHAINS = loadShippedDefaults("chains.json");

describe("every value the app ships as a default", () => {
  it("is in a file this test checks, or one named as holding none", () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
    for (const f of files)
      assert.ok(
        Object.hasOwn(SETTINGS_FILE_RULES, f) ||
          Object.hasOwn(NOT_SETTINGS_FILES, f),
        `${f} is new: give its values rules in src/settings-file-rules.js, ` +
          "or name it in NOT_SETTINGS_FILES",
      );
    for (const f of [
      ...Object.keys(SETTINGS_FILE_RULES),
      ...Object.keys(NOT_SETTINGS_FILES),
    ])
      assert.ok(files.includes(f), `${f} is not in the directory any more`);
  });

  for (const file of Object.keys(SETTINGS_FILE_RULES)) {
    it(`${file}: each is the right type and inside its range`, () => {
      const values = loadShippedDefaults(file);
      assert.deepEqual(
        settingsFileProblems(file, values, { chains: CHAINS, shipped: values }),
        [],
      );
    });

    it(`${file}: each value has exactly one rule, each rule a value`, () => {
      const rules = SETTINGS_FILE_RULES[file];
      const used = new Set();
      let checked = 0;
      for (const [at] of leaves(loadShippedDefaults(file))) {
        const where = `${file} → ${at.join(".")}`;
        const named = Object.keys(rules).filter((p) => matches(p, at));
        if (rangeAt(at) !== null)
          assert.equal(
            named.length,
            0,
            `${where} has a range in setting-bounds.json; give it no rule`,
          );
        else {
          assert.equal(
            named.length,
            1,
            `${where} needs exactly one rule, or a range in ` +
              `setting-bounds.json; it has ${named.length}`,
          );
          used.add(named[0]);
        }
        checked++;
      }
      assert.ok(checked > 0, `${file} holds no values`);
      for (const p of Object.keys(rules))
        assert.ok(used.has(p), `${file} → ${p} names no value; remove it`);
    });
  }
});

describe("shipped values that must agree with each other", () => {
  it("agree: the cancel timer, the csrf refresh, each chain's cache tag and aggregator, each LP provider's key", () => {
    assert.deepEqual(agreementProblems(loadShippedDefaults), []);
  });
});
