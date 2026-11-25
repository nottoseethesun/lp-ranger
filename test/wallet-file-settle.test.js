"use strict";

/**
 * @file test/wallet-file-settle.test.js
 * @description The programs that own the wallet put its files right as
 *   they start (`settleWalletFile`, src/lib/wallet-manager.js): the copy a
 *   save cut short left becomes wallet.json again, or is removed. A util
 *   tool that loads the module never does (test/wallet-manager.test.js).
 *
 *   The import script and the headless bot are run as they are started,
 *   each in a child process from a folder of its own, over a wallet file
 *   in a temp folder that is empty beside a whole copy; each stops on its
 *   own soon after its start step. The child keeps the test runner's
 *   marker, so it reads no `.env`, and takes no key from the shell. The
 *   server keeps running once started, so its source is checked instead:
 *   the start step comes once it holds its port, before it reads a
 *   request, so a second start, which fails on the port, never takes it.
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
 * Run `entry` (a path under the project) in a child process over an empty
 * wallet.json beside a whole copy; answer how it exited and both files'
 * text afterwards (null for none).
 * @param {string} entry
 * @param {object} [env]  Set over this process's environment.
 * @returns {{status: number|null, output: string, after: (string|null)[]}}
 */
function startOverACopy(entry, env = {}) {
  const dir = makeTestTempFolder("wallet-settle");
  const file = path.join(dir, "wallet.json");
  fs.writeFileSync(file, "");
  fs.writeFileSync(`${file}.tmp`, SAVED);
  const res = spawnSync(process.execPath, [path.join(ROOT, entry)], {
    cwd: makeTestTempFolder("wallet-settle-cwd"),
    env: {
      ...process.env,
      WALLET_FILE_PATH: file,
      LP_RANGER_USER_CONFIG_DIR: makeTestTempFolder("wallet-settle-overrides"),
      /*-
       *  No key from the shell, and no transaction even with one: the
       *  bot takes PRIVATE_KEY before the wallet, and would run live on
       *  it. A dry run still reads the key, so the bot still stops on
       *  the wrong password.
       */
      PRIVATE_KEY: "",
      DRY_RUN: "true",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const after = [file, `${file}.tmp`].map((f) =>
    fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null,
  );
  return { status: res.status, output: res.stdout + res.stderr, after };
}

describe("the programs that own the wallet, as they start", () => {
  it("the import script puts the copy back, then refuses a second wallet", () => {
    const run = startOverACopy(path.join("scripts", "import-wallet.js"));
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /A wallet is already imported/);
    assert.deepEqual(run.after, [SAVED, null]);
  });

  it("the headless bot puts the copy back before it reads the key", () => {
    const run = startOverACopy(path.join("src", "bot.js"), {
      WALLET_PASSWORD: "not-the-password",
    });
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /Wrong password/);
    assert.deepEqual(run.after, [SAVED, null]);
  });

  it("the server puts the files right once it holds its port", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "server.js"), "utf8");
    const main = src.indexOf("if (require.main === module) {");
    const listen = src.indexOf("start()", main);
    // The first step once listening: a plain function, so nothing waits first.
    const up = src.indexOf(".then(() => {", listen);
    const pid = src.indexOf("writePidFile();", up);
    const settle = src.indexOf("walletManager.settleWalletFile();", main);
    const reset = src.indexOf("resetErrorLog();", main);
    assert.ok(main > 0, "the server's main block");
    assert.ok(listen > main && up > listen, "start(), then the step after");
    assert.ok(settle > up && settle < pid, "the start step opens that step");
    assert.ok(reset > up && reset < pid, "and so does the error log's reset");
  });
});
