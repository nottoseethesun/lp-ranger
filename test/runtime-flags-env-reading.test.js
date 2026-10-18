"use strict";

/**
 * @file test/runtime-flags-env-reading.test.js
 * @description The app reads each `.env` variable one way, by its rule in
 *   src/env-settings.js, and coerces nothing: `DRY_RUN` and `VERBOSE` are
 *   exactly `true` or `false`, and the port is plain digits. Anything
 *   else stops the load, naming the variable, where an older reading took
 *   `1` or `yes` for on, or the leading digits of `80a` for the port.
 *
 *   Each case loads the real src/runtime-flags.js afresh with one
 *   variable set. Operator overrides are read from an empty directory of
 *   the test's own, and every variable a case sets is cleared again, so
 *   the operator's own `.env`, which dotenv never lets override a set
 *   variable, cannot reach these cases.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const _USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "env-reading-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;
const NAMES = ["DRY_RUN", "VERBOSE", "PORT"];
for (const name of NAMES) process.env[name] = "";
after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

/** Load src/runtime-flags.js as startup would, with `name` set to `text`. */
function loadWith(name, text) {
  process.env[name] = text;
  try {
    delete require.cache[require.resolve("../src/runtime-flags")];
    return require("../src/runtime-flags");
  } finally {
    process.env[name] = "";
  }
}

describe("how the app reads .env", () => {
  it("reads DRY_RUN and VERBOSE as exactly true or false", () => {
    assert.equal(loadWith("DRY_RUN", "true").DRY_RUN, true);
    assert.equal(loadWith("DRY_RUN", "false").DRY_RUN, false);
    assert.equal(loadWith("VERBOSE", "true").VERBOSE, true);
  });

  it("refuses any other spelling, naming the variable", () => {
    for (const text of ["1", "yes", "TRUE"]) {
      assert.throws(() => loadWith("DRY_RUN", text), /DRY_RUN in \.env/, text);
      assert.throws(() => loadWith("VERBOSE", text), /VERBOSE in \.env/, text);
    }
  });

  it("reads the port only as plain digits", () => {
    assert.equal(loadWith("PORT", "5599").PORT, 5599);
    assert.throws(() => loadWith("PORT", "80a"), /PORT in \.env/);
  });
});
