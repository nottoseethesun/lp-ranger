/**
 * @file util/test/validate-config-values-with-any-user-overrides.test.js
 * @description
 * Tests for `validate-config-values-with-any-user-overrides.js`, the
 * diagnostic that checks every setting an install runs on and lists each
 * problem, as the server and the bot do at startup.
 *
 * The verdict itself is src/lib/settings-check.js's, tested in
 * test/settings-check.test.js; these cover the command: its help, the
 * words it prints, and its exit status. Each install is a fixture in a
 * temporary directory, with an empty environment, so the machine running
 * the suite cannot change the answer.
 */

"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildProgram,
  main,
} = require("../diagnostic/validate-config-values-with-any-user-overrides");

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** An install with only the given `.env` text of its own. */
function install(envText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-config-"));
  dirs.push(dir);
  const userDir = path.join(dir, "user-configurable");
  fs.mkdirSync(userDir);
  const envFile = path.join(dir, ".env");
  if (envText !== undefined) fs.writeFileSync(envFile, envText);
  return {
    userDir,
    envFile,
    botConfigFile: path.join(userDir, "bot-config.json"),
    env: {},
  };
}

/** Run the command on an install, answering its status and its output. */
function run(where) {
  const printed = [];
  const status = main([], { print: (t) => printed.push(t), where });
  return { status, text: printed.join("\n") };
}

describe("validate-config-values-with-any-user-overrides", () => {
  it("names itself, says what it checks, and gives its exit status in its help", () => {
    let help = "";
    const program = buildProgram()
      .exitOverride()
      .configureOutput({ writeOut: (s) => (help += s) });
    // Commander answers --help by exiting, which exitOverride turns into a throw.
    assert.throws(() => program.parse(["--help"], { from: "user" }), {
      code: "commander.helpDisplayed",
    });
    assert.match(help, /validate-config-values-with-any-user-overrides/);
    assert.match(help, /bot-config\.json/);
    assert.match(help, /-h, --help/);
    assert.match(help, /Exit status: 0 when every setting passes/);
  });

  it("says every setting passes, and exits 0, when they do", () => {
    const { status, text } = run(install());
    assert.equal(status, 0);
    assert.match(text, /Every setting passes/);
  });

  it("lists each problem, and exits 1, when there is any", () => {
    const { status, text } = run(install("DRY_RUN=yes\nNOT_A_SETTING=1\n"));
    assert.equal(status, 1);
    assert.match(text, /Found 2 problems in the settings/);
    assert.match(text, /DRY_RUN in \.env must be true or false/);
    assert.match(text, /NOT_A_SETTING is not a setting LP Ranger reads/);
  });
});
