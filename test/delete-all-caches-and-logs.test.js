"use strict";

/**
 * @file test/delete-all-caches-and-logs.test.js
 * @description What `npm run build-and-start -- --delete-all-caches-and-logs`
 *   deletes before it builds (scripts/delete-all-caches-and-logs.js): all
 *   of LP Ranger's caches and logs, the way back from a damaged one. It
 *   says first that it deletes them all and that the rebuild can take
 *   several hours, and asks for YES, in capitals. YES deletes every scan
 *   cache, the figures worked out from the blockchain for each position,
 *   the rebalance log wherever it is, and the diagnostic log and the
 *   error log, keeping the settings, the records no scan can rebuild and
 *   today's rebalance counts. Any other answer deletes nothing. It is
 *   refused while LP Ranger runs, names a file it could not delete, and
 *   leaves a diagnostic or error log outside the install folder alone.
 *
 *   Each case works in a folder of its own: its install folder, its
 *   settings folder, and the scan-cache folder the test process has under
 *   `node --test` (src/lib/scan-cache-dir.js). The operator's files are
 *   never touched.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { scanCacheDir } = require("../src/lib/scan-cache-dir");
const { loadConfig } = require("../src/lib/bot-config-v2");
const { CHAIN_DERIVED_POSITION_KEYS } = require("../src/lib/bot-config-keys");
const { poolDailyCountsPath } = require("../src/bot/pool-daily-counts-file");
const {
  deleteAllCachesAndLogs,
} = require("../scripts/delete-all-caches-and-logs");

const KEY = "pulsechain-0xW-0xC-100";
const LOGS = [
  "app-data/rebalance_log.json",
  "logs/lp-ranger.log",
  "logs/error.log",
];
const CACHES = ["event-cache-a.json", "pnl-epochs-cache.json"];

let root;
let configDir;

/** A file of the case's install folder holding `text`. */
function put(rel, text = "x") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

beforeEach(() => {
  root = makeTestTempFolder("delete-all-root");
  configDir = makeTestTempFolder("delete-all-config");
  for (const f of LOGS) put(f);
  for (const f of CACHES) fs.writeFileSync(path.join(scanCacheDir(), f), "{}");
  // A position's settings, records no scan rebuilds, and scan figures.
  fs.writeFileSync(
    path.join(configDir, "bot-config.json"),
    JSON.stringify({
      global: {},
      positions: {
        [KEY]: {
          status: "running",
          slippagePctToken0: 0.75,
          residuals: { amount0: "5" },
          compoundedAmount0: 1111.16,
          hodlBaseline: { entryValue: 1 },
          totalLifetimeDepositUsd: 2406.7,
        },
      },
    }),
  );
});

/**
 * Run it with `answer` typed, recording what it said and asked.
 * @returns {Promise<{outcome: string, said: string[], asked: string[]}>}
 */
async function runWith(answer, extra = {}) {
  const said = [];
  const asked = [];
  const outcome = await deleteAllCachesAndLogs({
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    rebalanceLog: LOGS[0],
    logs: LOGS.slice(1),
    say: (line) => said.push(line),
    serverPid: () => null,
    root,
    configDir,
    ...extra,
  });
  return { outcome, said, asked };
}

const exists = (rel) => fs.existsSync(path.join(root, rel));
const cachesLeft = () =>
  CACHES.filter((f) => fs.existsSync(path.join(scanCacheDir(), f)));

describe("deleting all of LP Ranger's caches and logs", () => {
  it("says first that it deletes them all, that the rebuild can take hours, and asks for YES", async () => {
    const { said, asked } = await runWith("no");
    const warning = said.join("\n");
    assert.match(warning, /This deletes ALL of LP Ranger's caches and logs/);
    assert.match(warning, /can take it several hours/);
    assert.match(warning, /Your wallet, keys and settings are kept\./);
    for (const f of LOGS) assert.ok(warning.includes(f), f);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^Type YES to delete them and start LP Ranger/);
  });

  it("deletes every cache and log on YES, keeping the settings and the records no scan rebuilds", async () => {
    const { outcome, said } = await runWith("YES");
    assert.equal(outcome, "deleted");
    for (const f of LOGS) assert.equal(exists(f), false, `${f} deleted`);
    assert.deepEqual(cachesLeft(), [], "every scan cache deleted");
    const slot = loadConfig(configDir).positions[KEY];
    for (const k of CHAIN_DERIVED_POSITION_KEYS)
      assert.equal(k in slot, false, `${k} gone`);
    assert.equal(slot.slippagePctToken0, 0.75, "a setting kept");
    assert.deepEqual(slot.residuals, { amount0: "5" }, "a live record kept");
    assert.match(said.at(-1), /Deleted all of LP Ranger's caches and logs/);
  });

  for (const answer of ["yes", "Yes", "Y", "", "NO", "YES please"])
    it(`deletes nothing on ${JSON.stringify(answer)}`, async () => {
      const { outcome, said } = await runWith(answer);
      assert.equal(outcome, "declined");
      for (const f of LOGS) assert.equal(exists(f), true, `${f} kept`);
      assert.deepEqual(cachesLeft(), CACHES, "the caches kept");
      const slot = loadConfig(configDir).positions[KEY];
      assert.equal(slot.compoundedAmount0, 1111.16, "the figures kept");
      assert.equal(
        said.at(-1),
        "[delete-all] Nothing was deleted, and LP Ranger did not start.",
      );
    });

  it("is refused while LP Ranger runs, before asking, deleting nothing", async () => {
    const { outcome, said, asked } = await runWith("YES", {
      serverPid: () => 4321,
    });
    assert.equal(outcome, "refused");
    assert.deepEqual(asked, [], "not asked");
    assert.match(said[0], /LP Ranger is running \(PID 4321\)/);
    for (const f of LOGS) assert.equal(exists(f), true, `${f} kept`);
    assert.deepEqual(cachesLeft(), CACHES);
  });

  it("names a file it could not delete, and does not start LP Ranger", async () => {
    // A folder, with a file in it, where the error log should be.
    fs.rmSync(path.join(root, "logs/error.log"));
    put("logs/error.log/inside");
    const { outcome, said } = await runWith("YES");
    assert.equal(outcome, "failed");
    assert.match(said.at(-1), /Could not delete: logs\/error\.log\./);
    assert.match(said.at(-1), /LP Ranger did not start\./);
  });

  it("deletes the rebalance log outside the install folder too, the file the dialog's last step is for", async () => {
    const outsideLog = path.join(
      makeTestTempFolder("delete-all-outside"),
      "rebalance_log.json",
    );
    fs.writeFileSync(outsideLog, "[");
    const { outcome } = await runWith("YES", { rebalanceLog: outsideLog });
    assert.equal(outcome, "deleted");
    assert.equal(fs.existsSync(outsideLog), false, "deleted");
  });

  it("leaves a diagnostic log outside the install folder alone, and says so", async () => {
    const outsideFile = path.join(
      makeTestTempFolder("delete-all-outside"),
      "lp-ranger.log",
    );
    fs.writeFileSync(outsideFile, "x");
    const { outcome, said } = await runWith("YES", {
      logs: [outsideFile, LOGS[2]],
    });
    assert.equal(outcome, "deleted");
    assert.equal(fs.existsSync(outsideFile), true, "left alone");
    assert.match(
      said.join("\n"),
      /Left alone, being outside the install folder: .*lp-ranger\.log/,
    );
  });

  it("keeps today's rebalance counts, which are neither a cache nor a log", async () => {
    const counts = poolDailyCountsPath();
    fs.mkdirSync(path.dirname(counts), { recursive: true });
    fs.writeFileSync(counts, '{"day":"2026-11-23","counts":{}}');
    await runWith("YES");
    assert.equal(fs.existsSync(counts), true);
  });
});
