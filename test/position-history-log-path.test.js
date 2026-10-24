"use strict";

/**
 * @file test/position-history-log-path.test.js
 * @description A closed NFT's history reads the rebalance log from where
 *   the bot writes it.
 *
 *   `src/lib/bot-recorder.js` writes the log at `path.resolve(config.LOG_FILE)`,
 *   and the reader must resolve the setting the same way. Joining it onto
 *   the working directory instead agrees for a relative path and not for
 *   an absolute one: a log set to an absolute path in `.env` would be
 *   written in one place and looked for in another, and every closed NFT
 *   would lose what the log knows of it.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../src/lib/config");
const { _readRebalanceLog } = require("../src/lib/position-history");

describe("the rebalance log a closed NFT's history reads", () => {
  it("is found at an absolute path, where the bot writes it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rebalance-log-"));
    const file = path.join(dir, "rebalance_log.json");
    fs.writeFileSync(file, JSON.stringify([{ newTokenId: "1" }]));
    const saved = config.LOG_FILE;
    config.LOG_FILE = file;
    try {
      assert.deepEqual(_readRebalanceLog(), [{ newTokenId: "1" }]);
    } finally {
      config.LOG_FILE = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads as empty when there is no log yet", () => {
    const saved = config.LOG_FILE;
    config.LOG_FILE = path.join(
      os.tmpdir(),
      "no-such-dir-" + process.pid,
      "x.json",
    );
    try {
      assert.deepEqual(_readRebalanceLog(), []);
    } finally {
      config.LOG_FILE = saved;
    }
  });
});
