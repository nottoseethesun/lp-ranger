"use strict";

/**
 * @file test/bot-private-key.test.js
 * @description The headless bot's key from the wallet's password
 *   (src/bot/bot-private-key.js): WALLET_PASSWORD is read through
 *   `readEnv`, so a blank value is no password, as the startup check
 *   takes it, and the bot does not try it on the wallet.
 *
 *   Run in a child process, which imports a wallet of its own into a temp
 *   file (`WALLET_FILE_PATH`) and then asks for the key, so the test
 *   process's environment and the operator's wallet are left alone. The
 *   child keeps the test runner's marker, so the rest of what it loads
 *   uses test folders too, and is given an empty PRIVATE_KEY, so an
 *   operator's `.env` cannot answer first.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

/**
 * The bot's key in a child process whose wallet was imported with
 * `password`, asked with WALLET_PASSWORD set to `walletPassword`.
 * @param {string} walletPassword
 * @returns {string}  The key, "null", or "threw: <message>", from the
 *   child's last line, which follows its log lines.
 */
function keyInChild(walletPassword) {
  const wallet = JSON.stringify(
    path.join(__dirname, "..", "src", "lib", "wallet-manager"),
  );
  const botKey = JSON.stringify(
    path.join(__dirname, "..", "src", "bot", "bot-private-key"),
  );
  const script = `
    (async () => {
      await require(${wallet}).importWallet({
        address: "0xAbCdEf0000000000000000000000000000000001",
        privateKey: "0x" + "ab".repeat(32),
        password: "right-password",
      });
      const key = await require(${botKey}).resolvePrivateKey({ askPassword: null });
      process.stdout.write("\\nKEY=" + String(key));
    })().catch((err) => process.stdout.write("\\nKEY=threw: " + err.message));
  `;
  const env = {
    ...process.env,
    WALLET_FILE_PATH: path.join(makeTestTempFolder("bot-key"), "wallet.json"),
    WALLET_PASSWORD: walletPassword,
    PRIVATE_KEY: "",
  };
  const res = spawnSync(process.execPath, ["-e", script], {
    env,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  // The answer follows the child's log lines, which share its stdout.
  const answer = res.stdout.match(/\nKEY=(.*)$/);
  assert.ok(answer, `no answer in the child's output: ${res.stdout}`);
  return answer[1];
}

describe("the headless bot's key from the wallet's password", () => {
  it("takes a blank WALLET_PASSWORD as no password", () => {
    assert.equal(keyInChild("   "), "null");
  });

  it("decrypts the wallet with a WALLET_PASSWORD that is set", () => {
    assert.equal(keyInChild("right-password"), "0x" + "ab".repeat(32));
  });
});
