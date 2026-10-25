"use strict";

/**
 * @file test/startup-refuses-bad-settings.test.js
 * @description The server and the bot check every setting before they
 *   read any, and refuse to start on a wrong one, naming it.
 *
 *   Driven through the real entry points, `node src/server.js` and
 *   `node src/bot.js`, each run from a folder of this test's own whose `.env`
 *   sets a variable LP Ranger does not read, with an empty folder for the
 *   operator's copies of the settings files. Nothing in them can send a
 *   transaction: the check exits before the app's own config is loaded,
 *   and the `.env` names the testnet and a dry run besides. The test
 *   runner's marker is left out of their environment, so bot-config.json
 *   is looked for in that folder, as it is on an install.
 */

const { it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "startup-settings-"));
const USER_DIR = path.join(DIR, "user-configurable");
fs.mkdirSync(USER_DIR);
fs.writeFileSync(
  path.join(DIR, ".env"),
  "CHAIN_NAME=pulsechain-testnet\nDRY_RUN=true\nPORT=5598\nNOT_A_SETTING=1\n",
);
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const { NODE_TEST_CONTEXT: _marker, ...ENV } = process.env;

for (const entry of ["bot.js", "server.js"]) {
  it(`${entry} refuses to start, naming the setting`, () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, "src", entry)], {
      cwd: DIR,
      env: { ...ENV, LP_RANGER_USER_CONFIG_DIR: USER_DIR },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(run.status, 1, `${run.stderr}\n${run.stdout}`);
    assert.match(run.stderr, /LP Ranger cannot start/);
    assert.match(run.stderr, /NOT_A_SETTING is not a setting LP Ranger reads/);
  });
}
