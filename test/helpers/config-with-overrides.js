"use strict";

/**
 * @file test/helpers/config-with-overrides.js
 * @description Loads the real `src/config.js` as startup would, against
 *   settings files of a test's own, so a test can watch it refuse a
 *   setting it cannot use, or read one moved off what ships.
 *
 *   `LP_RANGER_USER_CONFIG_DIR` is read by `src/load-merged-defaults.js`
 *   when it loads, so requiring this helper points it at a temp folder
 *   of its own (`makeTestTempFolder`, removed when the process exits);
 *   require it before anything under `src/`. It also pins the `.env`
 *   keys that would override the settings under test, since dotenv
 *   leaves a key alone once it is set. Each load writes the overrides
 *   and loads afresh the modules that read the settings files.
 */

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { makeTestTempFolder } = require("../../src/test-temp-folders");

/** The folder the overrides are written to, as the operator's copies. */
const USER_DIR = makeTestTempFolder("startup-checks");
process.env.LP_RANGER_USER_CONFIG_DIR = USER_DIR;
process.env.CHAIN_NAME = "pulsechain";
process.env.AGGREGATOR_URL = "";
process.env.SWAP_ROUTER = "";

const _OVERRIDABLE = [
  "chains.json",
  "app-runtime.json",
  "ui-defaults_non-layout_for-server-up-scenario.json",
  "bot-config-defaults.json",
];

/**
 * Load `src/config.js` as startup would, with `overrides` as the
 * operator's files: `{ "chains.json": {...} }` and so on. A chains.json
 * override is given for PulseChain's entry alone.
 * @param {object} [overrides]
 * @returns {object} The loaded config.
 */
function loadConfigWith(overrides = {}) {
  for (const name of _OVERRIDABLE)
    fs.rmSync(path.join(USER_DIR, name), { force: true });
  for (const [name, body] of Object.entries(overrides)) {
    const json = name === "chains.json" ? { pulsechain: body } : body;
    fs.writeFileSync(path.join(USER_DIR, name), JSON.stringify(json));
  }
  for (const mod of [
    "load-merged-defaults",
    "bot-config-defaults",
    "ui-defaults",
    "runtime-flags",
    "cache-store",
    "config",
  ])
    delete require.cache[require.resolve(`../../src/${mod}`)];
  return require("../../src/config");
}

/** Load with one chains.json override, expecting startup to refuse it. */
function refuses(chainOverride, pattern) {
  assert.throws(
    () => loadConfigWith({ "chains.json": chainOverride }),
    pattern,
  );
}

module.exports = { USER_DIR, loadConfigWith, refuses };
