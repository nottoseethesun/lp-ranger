/**
 * @file test/config-path-sandbox.test.js
 * @description A test run must never write the operator's bot-config.json.
 *
 *   `saveConfig(cfg)` with no directory used to resolve to
 *   `app-config/user-configurable/`, so any test driving a route handler
 *   or a started server wrote the live file. That is not hypothetical:
 *   it is how a test fixture's position key came to be sitting in a real
 *   operator config, and `scripts/check.js` only has to back the file up
 *   because of it.
 *
 *   The redirect keys off `NODE_TEST_CONTEXT`, which Node sets in every
 *   `node --test` worker. A per-file redirect would be a convention the
 *   next test could forget; this one cannot be forgotten, because the
 *   runner sets it rather than the test author.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadConfig, saveConfig } = require("../src/bot-config-v2");

const LIVE = path.join(
  process.cwd(),
  "app-config",
  "user-configurable",
  "bot-config.json",
);

describe("undirected config writes never reach the operator's file", () => {
  it("is running where the redirect applies", () => {
    /*- Guards the guard. Without this, every assertion below would pass
     *  vacuously if Node stopped setting the variable. */
    assert.notEqual(
      process.env.NODE_TEST_CONTEXT,
      undefined,
      "NODE_TEST_CONTEXT must be set inside `node --test`",
    );
  });

  it("leaves the live file untouched when saving with no directory", () => {
    const before = fs.existsSync(LIVE) ? fs.readFileSync(LIVE) : null;

    saveConfig({
      global: {},
      positions: { "pulsechain-0xSandbox-0xSandbox-1": { slippagePct: 1 } },
    });

    const after = fs.existsSync(LIVE) ? fs.readFileSync(LIVE) : null;
    if (before === null) {
      assert.equal(after, null, "a live file must not be created");
      return;
    }
    assert.ok(
      before.equals(after),
      "the operator's bot-config.json was modified by a test",
    );
  });

  it("the write still lands somewhere, and reads back", () => {
    /*- The redirect must not be a silent no-op: a test that saves and
     *  reloads has to see its own data, or the sandbox would be hiding
     *  broken behaviour rather than protecting a file. */
    const key = "pulsechain-0xRoundTrip-0xRoundTrip-7";
    saveConfig({ global: {}, positions: { [key]: { slippagePct: 0.5 } } });
    const back = loadConfig();
    assert.equal(back.positions[key]?.slippagePct, 0.5);
  });

  it("writes inside a temp directory, not the project", () => {
    saveConfig({ global: {}, positions: {} });
    /*- `loadConfig` reads through the same resolver, so finding the data
     *  under os.tmpdir() is what shows the resolver moved. */
    const sandboxes = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith("lp-ranger-test-config-"));
    assert.ok(
      sandboxes.length > 0,
      "expected a sandbox config directory under the system temp dir",
    );
  });
});
