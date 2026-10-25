/**
 * @file test/config-path-sandbox.test.js
 * @description A test run must never write the operator's bot-config.json,
 *   and must leave no temp folder behind.
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
 *
 *   The config folder is one of the temp folders a test process makes
 *   (src/lib/test-temp-folders.js). Each goes when its process exits, and
 *   `npm run check` removes any a stopped process left, so none piles up
 *   in the system's temp directory.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  loadConfig,
  saveConfig,
  botConfigPath,
} = require("../src/lib/bot-config-v2");
const {
  makeTestTempFolder,
  removeLeftoverTestTempFolders,
} = require("../src/lib/test-temp-folders");

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
      positions: {
        "pulsechain-0xSandbox-0xSandbox-1": { slippagePctToken0: 1 },
      },
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
    saveConfig({
      global: {},
      positions: { [key]: { slippagePctToken0: 0.5 } },
    });
    const back = loadConfig();
    assert.equal(back.positions[key]?.slippagePctToken0, 0.5);
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

  it("is in the system's temp directory, named for the process", () => {
    const dir = path.dirname(botConfigPath());
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(
      path.basename(dir).startsWith(`lp-ranger-test-config-${process.pid}-`),
      dir,
    );
  });
});

/**
 * Run `body` in a process of its own that counts as a test process, as
 * the runner's workers do, once it has its config folder and a temp
 * folder of its own.
 * @param {string} body  What the process does then.
 * @returns {{dirs: string[], status: number, stdout: string,
 *   stderr: string}} The two folders, how the process exited, and what
 *   it wrote.
 */
function testProcess(body) {
  const src = (name) =>
    JSON.stringify(path.join(__dirname, "..", "src", "lib", name));
  const res = spawnSync(
    process.execPath,
    [
      "-e",
      `const path = require("path");
       const { botConfigPath } = require(${src("bot-config-v2")});
       const { makeTestTempFolder } = require(${src("test-temp-folders")});
       const dirs = [path.dirname(botConfigPath()), makeTestTempFolder("error-log")];
       process.stdout.write("DIRS=" + JSON.stringify(dirs) + "\\n");
       ${body}`,
    ],
    {
      env: { ...process.env, NODE_TEST_CONTEXT: "child" },
      encoding: "utf8",
    },
  );
  const dirs = /^DIRS=(.*)$/m.exec(res.stdout)?.[1];
  assert.ok(dirs, `the process named its folders: ${res.stdout}${res.stderr}`);
  return {
    dirs: JSON.parse(dirs),
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

describe("a test process's temp folders", () => {
  it("go when the process exits", () => {
    const { dirs, status } = testProcess("");
    assert.equal(status, 0);
    for (const dir of dirs)
      assert.equal(fs.existsSync(dir), false, `${dir} was left behind`);
  });

  it("go when the process fails", () => {
    const { dirs, status } = testProcess('throw new Error("a test failed");');
    assert.equal(status, 1);
    for (const dir of dirs)
      assert.equal(fs.existsSync(dir), false, `${dir} was left behind`);
  });

  it("go however many a process makes, with one exit hook and no warning", () => {
    const { stdout, stderr, status } = testProcess(
      `const before = process.listenerCount("exit");
       const many = Array.from({ length: 12 }, () => makeTestTempFolder("many"));
       process.stdout.write("MANY=" + JSON.stringify(many) + "\\n");
       process.stdout.write(
         "ADDED=" + (process.listenerCount("exit") - before) + "\\n",
       );`,
    );
    assert.equal(status, 0, stderr);
    const many = JSON.parse(/^MANY=(.*)$/m.exec(stdout)[1]);
    assert.equal(many.length, 12);
    for (const dir of many)
      assert.equal(fs.existsSync(dir), false, `${dir} was left behind`);
    assert.equal(/^ADDED=(\d+)$/m.exec(stdout)[1], "0", "no hook per folder");
    assert.doesNotMatch(stderr, /MaxListenersExceededWarning/);
  });
});

describe("folders a stopped process left", () => {
  it("are removed, and a running process's are kept", () => {
    const parent = makeTestTempFolder("sweep");
    // A process that has ended, as one stopped outright has.
    const ended = spawnSync(process.execPath, ["-e", ""]).pid;
    const names = {
      stopped: `lp-ranger-test-config-${ended}-abc123`,
      stoppedHyphenated: `lp-ranger-test-error-log-${ended}-pqr678`,
      running: `lp-ranger-test-config-${process.pid}-def456`,
      // Process 1 always runs, usually another user's.
      anotherUsers: "lp-ranger-test-config-1-mno345",
      unnumbered: "lp-ranger-test-config-ghi789",
      unrelated: "check-backup-jkl012",
    };
    for (const name of Object.values(names))
      fs.mkdirSync(path.join(parent, name));
    assert.equal(removeLeftoverTestTempFolders(parent), 2);
    const { stopped, stoppedHyphenated, ...kept } = names;
    assert.deepEqual(
      fs.readdirSync(parent).sort(),
      Object.values(kept).sort(),
      `${stopped} and ${stoppedHyphenated} go`,
    );
  });

  it("are removed by npm run check before its tests start", () => {
    /*-
     *  scripts/check.js runs the whole suite when loaded, so the order is
     *  read rather than run.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "check.js"),
      "utf8",
    );
    const sweep = src.indexOf("removeLeftoverTestTempFolders()");
    assert.ok(sweep > -1, "check.js removes leftover folders");
    const firstTests = src.indexOf("const configRun = await runAsync(");
    assert.ok(firstTests > -1, "check.js runs the config-value tests");
    assert.ok(sweep < firstTests, "before the first tests start");
  });

  it("are removed by npm run check before it moves the operator's files out", () => {
    /*-
     *  A folder the sweep cannot remove stops the run. Before the backup,
     *  that leaves the operator's wallet and settings where they are;
     *  after it, they would stay moved out, since only the test stage's
     *  `finally` puts them back.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "check.js"),
      "utf8",
    );
    const sweep = src.indexOf("removeLeftoverTestTempFolders()");
    const backup = src.indexOf("backupProdFiles(backupDir)");
    assert.ok(backup > -1, "check.js backs up the operator's files");
    assert.ok(sweep > -1 && sweep < backup, "the sweep runs first");
  });
});
