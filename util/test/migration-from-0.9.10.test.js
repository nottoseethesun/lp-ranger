/**
 * @file util/test/migration-from-0.9.10.test.js
 * @description Tests for the migration's steps for an install updated
 *   from 0.9.10 (util/migration/from-0.9.10/): the settings for retrying a
 *   rebalance the price outran come out, and so does a gentle-stop
 *   interval longer than this release allows. Such an install starts
 *   once the migration has run.
 *
 *   The install a case builds holds a whole copy of app-runtime.json,
 *   made from the file this release ships with 0.9.10's differences put
 *   back (its retry settings and its five-minute gentle-stop interval),
 *   and a `.env` setting the retry limit. The longest interval the tests
 *   expect is read from the shipped setting-bounds.json, so they follow
 *   its range. Each case's install is in a temp folder of its own, so no
 *   operator file is in reach.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTestTempFolder } = require("../../src/lib/test-temp-folders");
const { settingsProblems } = require("../../src/lib/settings-check");
const { runMigration, report } = require("../migration");
const { keepCopy } = require("../migration/settings-copies");

const SHIPPED = path.join(
  __dirname,
  "..",
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
);
const USER = "app-config/user-configurable";
const RUNTIME = `${USER}/app-runtime.json`;

/** A file this release ships, parsed afresh, so a case may change it. */
const shipped = (file) =>
  JSON.parse(fs.readFileSync(path.join(SHIPPED, file), "utf8"));

/** The gentle-stop interval's range, as this release ships it. */
const INTERVAL = shipped("setting-bounds.json").timers.settings
  .gentleStopPollMs;

/** A whole copy of 0.9.10's app-runtime.json, with an operator's own value. */
function runtimeFrom0910() {
  const runtime = shipped("app-runtime.json");
  runtime.tx.speedupSec = 90;
  Object.assign(runtime.tx, {
    retrySwapLimit: 8,
    _swapBackoff_comment: "How a rebalance is retried after the price moved.",
    swapBackoffBaseMs: 60000,
    swapBackoffMaxMs: 1200000,
  });
  // 0.9.10's gentle-stop asked every five minutes.
  runtime.shutdown.gentleStopPollMs = 300000;
  return runtime;
}

const ENV_0910 = [
  "# The operator's own note stays.",
  "REBALANCE_RETRY_SWAP_LIMIT=6",
  "CHECK_INTERVAL_SEC=300",
  "",
].join("\n");

/** Write `text` to `rel` in `root`. */
function put(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** An install with `runtime` as its copy of app-runtime.json, and `env` as its `.env` when given. */
function installWith(runtime, env) {
  const root = makeTestTempFolder("migration-from-0.9.10");
  put(root, RUNTIME, JSON.stringify(runtime, null, 2));
  if (env !== undefined) {
    put(root, ".env", env);
    fs.chmodSync(path.join(root, ".env"), 0o600);
  }
  return root;
}

/** An install as 0.9.10 left it. */
const installFrom0910 = (env = ENV_0910) => installWith(runtimeFrom0910(), env);

const read = (root, rel) =>
  JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

/** Every problem the startup check finds in the install at `root`. */
const problemsAt = (root) =>
  settingsProblems({
    userDir: path.join(root, USER),
    envFile: path.join(root, ".env"),
    env: {},
    botConfigFile: path.join(root, USER, "bot-config.json"),
    recordsFile: path.join(root, "app-data", "position-records.json"),
  });

describe("an install updated from 0.9.10", () => {
  it("would not start before the migration, and starts after it", () => {
    const root = installFrom0910();
    const before = problemsAt(root).join("\n");
    for (const said of [
      "tx.retrySwapLimit is not a setting",
      "tx.swapBackoffBaseMs is not a setting",
      "tx.swapBackoffMaxMs is not a setting",
      "REBALANCE_RETRY_SWAP_LIMIT is not a setting",
      "shutdown.gentleStopPollMs must be",
    ])
      assert.ok(before.includes(said), before);
    runMigration({ root });
    assert.deepEqual(problemsAt(root), []);
  });

  it("keeps a copy of the old app-runtime.json in tmp/", () => {
    // Two steps change the file; the oldest copy is the file as it was.
    const root = installFrom0910();
    runMigration({ root });
    const kept = fs
      .readdirSync(path.join(root, "tmp"))
      .filter((f) => f.startsWith("app-runtime.pre-migration-"))
      .sort();
    assert.ok(kept.length >= 1, kept.join(", "));
    assert.deepEqual(read(root, `tmp/${kept[0]}`), runtimeFrom0910());
  });

  it("changes nothing on a dry run, and nothing more when run again", () => {
    const root = installFrom0910();
    const runtimeBefore = fs.readFileSync(path.join(root, RUNTIME), "utf8");
    const dry = report(runMigration({ root, dryRun: true }), true);
    assert.match(dry, /would remove tx\.retrySwapLimit/);
    assert.match(dry, /would make REBALANCE_RETRY_SWAP_LIMIT a comment/);
    assert.match(dry, /would remove shutdown\.gentleStopPollMs/);
    assert.equal(
      fs.readFileSync(path.join(root, RUNTIME), "utf8"),
      runtimeBefore,
    );
    assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), ENV_0910);
    runMigration({ root });
    assert.equal(
      report(runMigration({ root }), false),
      "Nothing to change: this install is up to date.",
    );
  });
});

describe("the settings for retrying a rebalance the price outran", () => {
  it("come out of the copy, which keeps the operator's own", () => {
    const root = installFrom0910();
    runMigration({ root });
    assert.deepEqual(read(root, RUNTIME).tx, {
      ...shipped("app-runtime.json").tx,
      speedupSec: 90,
    });
  });

  it("make the retry limit in .env a comment, never quoting its value", () => {
    const root = installFrom0910();
    const said = report(runMigration({ root }), false);
    const env = fs.readFileSync(path.join(root, ".env"), "utf8");
    assert.match(env, /^# REBALANCE_RETRY_SWAP_LIMIT=6$/m);
    assert.match(env, /^# The operator's own note stays\.$/m);
    assert.match(env, /^CHECK_INTERVAL_SEC=300$/m);
    assert.match(said, /made REBALANCE_RETRY_SWAP_LIMIT a comment/);
    assert.ok(!/REBALANCE_RETRY_SWAP_LIMIT\s*=/.test(said), said);
    assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);
  });

  it("make an exported retry limit a comment too", () => {
    const root = installFrom0910("export REBALANCE_RETRY_SWAP_LIMIT=6\n");
    runMigration({ root });
    assert.equal(
      fs.readFileSync(path.join(root, ".env"), "utf8"),
      "# LP Ranger reads REBALANCE_RETRY_SWAP_LIMIT no more; util/migration made it a comment:\n" +
        "# export REBALANCE_RETRY_SWAP_LIMIT=6\n",
    );
  });
});

describe("a gentle-stop interval", () => {
  it("comes out whenever it is longer than this release allows, saying so", () => {
    for (const ms of [INTERVAL.max + 1, 300000, 3600000]) {
      const root = installWith({
        shutdown: { gentleStopPollMs: ms, exitTimeoutMs: 4000 },
      });
      const said = report(runMigration({ root }), false);
      assert.deepEqual(read(root, RUNTIME), {
        shutdown: { exitTimeoutMs: 4000 },
      });
      assert.ok(
        said.includes(
          `removed shutdown.gentleStopPollMs: ${ms} is over the ${INTERVAL.max} ms`,
        ),
        said,
      );
    }
  });

  it("stays when this release allows it, as does a copy without one", () => {
    for (const runtime of [
      { shutdown: { gentleStopPollMs: INTERVAL.max } },
      { shutdown: { gentleStopPollMs: INTERVAL.min } },
      { shutdown: { exitTimeoutMs: 4000 } },
      { tx: { speedupSec: 90 } },
    ]) {
      const root = installWith(runtime);
      assert.equal(
        report(runMigration({ root }), false),
        "Nothing to change: this install is up to date.",
      );
      assert.deepEqual(read(root, RUNTIME), runtime);
    }
  });
});

describe("keepCopy", () => {
  it("keeps the older file when two steps name their copies alike", () => {
    /*-
     *  Two steps of one run can change the same file in the same
     *  millisecond. The first copy is the file before the run, which is
     *  what undoing the run needs.
     */
    const root = makeTestTempFolder("migration-keep-copy");
    const file = path.join(root, "app-runtime.json");
    fs.writeFileSync(file, '{ "before": "the run" }');
    keepCopy(root, file, "same-stamp");
    fs.writeFileSync(file, '{ "after": "the first step" }');
    keepCopy(root, file, "same-stamp");
    assert.deepEqual(
      read(root, "tmp/app-runtime.pre-migration-same-stamp.json"),
      { before: "the run" },
    );
  });
});
