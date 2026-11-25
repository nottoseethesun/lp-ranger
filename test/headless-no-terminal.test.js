"use strict";

/**
 * @file test/headless-no-terminal.test.js
 * @description LP Ranger started with nobody at a terminal, as a service
 *   manager or a script starts it: a wallet saved, no WALLET_PASSWORD, and
 *   nothing to type into. The terminal prompt for the password closes at
 *   once (src/lib/ask-password.js); it says why, and the headless bot and
 *   the server started with `--headless` each stop with an error saying
 *   what to do, rather than waiting for ever.
 *
 *   Each runs in a child process from a folder of its own, over a wallet
 *   file in a temp folder, with its input on /dev/null. The child keeps
 *   the test runner's marker, so it reads no `.env`; with no key it can
 *   sign nothing, and both stop before any position starts.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const ROOT = path.join(__dirname, "..");

// A saved wallet file's text; its secrets are not real, and need not be.
const SAVED = JSON.stringify({
  address: "0xAbCdEf0000000000000000000000000000000001",
  source: "key",
  hasMnemonic: false,
  encrypted: {
    saltHex: "00",
    ivHex: "00",
    authTagHex: "00",
    ciphertextHex: "00",
  },
});

/**
 * Start `args` (an entry point and its options) with nothing to type into.
 * @param {string[]} args
 * @param {object} [env]  Set over the child's environment.
 * @returns {{status: number|null, output: string}}
 */
function startWithNoTerminal(args, env = {}) {
  const file = path.join(makeTestTempFolder("no-terminal"), "wallet.json");
  fs.writeFileSync(file, SAVED);
  const childEnv = {
    ...process.env,
    WALLET_FILE_PATH: file,
    LP_RANGER_USER_CONFIG_DIR: makeTestTempFolder("no-terminal-overrides"),
    ...env,
  };
  delete childEnv.WALLET_PASSWORD;
  delete childEnv.PRIVATE_KEY;
  const res = spawnSync(process.execPath, args, {
    cwd: makeTestTempFolder("no-terminal-cwd"),
    env: childEnv,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: res.status, output: res.stdout + res.stderr };
}

describe("a headless start with nobody at a terminal", () => {
  it("stops the headless bot, saying why and what to do", () => {
    const run = startWithNoTerminal([path.join(ROOT, "src", "bot.js")]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /The prompt closed before anything was typed/);
    assert.match(run.output, /The wallet is locked: no password was given/);
    assert.match(run.output, /Set WALLET_PASSWORD in \.env/);
  });

  it("stops the server started with --headless, saying why and what to do", () => {
    // A port of its own, clear of the dashboard's and of other tests'.
    const port = String(40000 + (process.pid % 20000));
    const run = startWithNoTerminal(
      [path.join(ROOT, "src", "server.js"), "--headless"],
      { PORT: port, HOST: "127.0.0.1" },
    );
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /The prompt closed before anything was typed/);
    assert.match(run.output, /The wallet is locked: no password was given/);
    assert.match(run.output, /Set WALLET_PASSWORD in \.env/);
  });
});
