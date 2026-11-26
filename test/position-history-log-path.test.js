"use strict";

/**
 * @file test/position-history-log-path.test.js
 * @description A closed NFT's history reads the rebalance log from where
 *   the bot writes it.
 *
 *   `src/bot/bot-recorder.js` writes the log at
 *   `path.resolve(config.rebalanceLogPath())`, and the reader must resolve
 *   the setting the same way. Joining it onto
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

const { useRebalanceLog } = require("./helpers/rebalance-log");
const { _readRebalanceLog } = require("../src/bot/position-history");

describe("the rebalance log a closed NFT's history reads", () => {
  it("is found at an absolute path, where the bot writes it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rebalance-log-"));
    const file = path.join(dir, "rebalance_log.json");
    fs.writeFileSync(file, JSON.stringify([{ newTokenId: "1" }]));
    const restoreLog = useRebalanceLog(file);
    try {
      assert.deepEqual(_readRebalanceLog(), [{ newTokenId: "1" }]);
    } finally {
      restoreLog();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads as empty when there is no log yet", () => {
    const restoreLog = useRebalanceLog(
      path.join(os.tmpdir(), "no-such-dir-" + process.pid, "x.json"),
    );
    try {
      assert.deepEqual(_readRebalanceLog(), []);
    } finally {
      restoreLog();
    }
  });
});
