"use strict";

/**
 * @file test/rebalance-log-setting.test.js
 * @description Where the rebalance log is set to be
 *   (src/lib/rebalance-log-setting.js): LOG_FILE, else app-runtime.json's
 *   `log.file`. The app, `npm run clean` (scripts/clean.js) and the
 *   bookkeeping report (util/bookkeeping/coins-in-transactions-on-wallet/)
 *   all find it there, so none of them misses a log the operator moved.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { rebalanceLogSetting } = require("../src/lib/rebalance-log-setting");
const config = require("../src/lib/config");
const { useRebalanceLog } = require("./helpers/rebalance-log");
const {
  reportRebalanceLog,
} = require("../util/bookkeeping/coins-in-transactions-on-wallet");

const ROOT = path.join(__dirname, "..");
const SHIPPED = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      "app-config",
      "app-defaults-for-user-configurable",
      "app-runtime.json",
    ),
    "utf8",
  ),
).log.file;

describe("where the rebalance log is set to be", () => {
  it("is LOG_FILE when it is set", () => {
    const restore = useRebalanceLog("/elsewhere/log.json");
    try {
      assert.equal(rebalanceLogSetting(), "/elsewhere/log.json");
      assert.equal(rebalanceLogSetting("ignored.json"), "/elsewhere/log.json");
    } finally {
      restore();
    }
  });

  it("is app-runtime.json's log.file when LOG_FILE is not set", () => {
    assert.equal(process.env.LOG_FILE, undefined);
    assert.equal(rebalanceLogSetting(), SHIPPED);
  });

  it("is the log.file the caller already read, when it gives one", () => {
    assert.equal(rebalanceLogSetting("given.json"), "given.json");
  });

  it("is where the app reads the log when LOG_FILE is set", () => {
    const restore = useRebalanceLog("/elsewhere/log.json");
    try {
      assert.equal(config.rebalanceLogPath(), "/elsewhere/log.json");
    } finally {
      restore();
    }
  });

  it("is where the bookkeeping report reads it, from the project folder", () => {
    const restore = useRebalanceLog("moved/log.json");
    try {
      assert.equal(
        reportRebalanceLog({}),
        path.join(ROOT, "moved", "log.json"),
      );
      assert.equal(
        reportRebalanceLog({ rebalanceLog: "/own.json" }),
        "/own.json",
      );
    } finally {
      restore();
    }
  });

  it("is where npm run clean removes it", () => {
    // clean.js stops the server and resets the wallet, so it is read, not run.
    const src = fs.readFileSync(path.join(ROOT, "scripts", "clean.js"), "utf8");
    assert.match(
      src,
      /loadEnvFile\(\);\s*const rebalanceLog = rmLogFiles\(\[rebalanceLogSetting\(\)\]\);/,
    );
    assert.doesNotMatch(src, /"app-data\/rebalance_log\.json"/);
  });
});
