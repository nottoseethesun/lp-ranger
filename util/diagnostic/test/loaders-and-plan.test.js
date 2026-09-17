/**
 * @file util/diagnostic/test/loaders-and-plan.test.js
 * @description
 * Tests for the remaining untested surfaces of the diagnostic tools:
 * the JSON loaders (`rescan-pool-history._loadJson`,
 * `inspect-pool.loadEpochCache`) and the rescan tool's dry-run plan
 * renderer.
 *
 * `_printPlan` is the safety feature of a destructive tool — it is the
 * screen an operator reads before answering y/N to wiping
 * `compoundHistory` and the lifetime deposit.  If it under-reports what
 * will change, the operator consents to something they did not see, so
 * these assertions are about consent accuracy, not just coverage.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { _loadJson, _printPlan } = require("../rescan-pool-history");
const { loadEpochCache } = require("../inspect-pool");
const { captureConsole, captureExit } = require("./_capture");

const KEY = "pulsechain-0xW-0xPM-162980";

test("_loadJson — parses a well-formed file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadjson-"));
  const p = path.join(dir, "x.json");
  try {
    fs.writeFileSync(p, '{"a":1}');
    assert.deepEqual(_loadJson(p, "test"), { a: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("_loadJson — exits 2 with the label when file is missing", async () => {
  const res = await captureConsole(() =>
    captureExit(() => _loadJson("/nonexistent/nope.json", "bot config")),
  );
  assert.equal(res.value.code, 2);
  assert.match(res.err.join("\n"), /failed to read bot config/);
});

test("_loadJson — exits 2 on malformed JSON", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loadjson-"));
  const p = path.join(dir, "bad.json");
  try {
    fs.writeFileSync(p, "{not json");
    const res = await captureConsole(() =>
      captureExit(() => _loadJson(p, "epoch cache")),
    );
    assert.equal(res.value.code, 2);
    assert.match(res.err.join("\n"), /failed to read epoch cache/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEpochCache — returns an object for the real cache path", () => {
  const cache = loadEpochCache();
  assert.equal(typeof cache, "object");
  assert.notEqual(cache, null);
});

test("loadEpochCache — returns {} when the file is unreadable", () => {
  /*- inspect-pool must still print the positions section when the epoch
   *  cache has never been written.  EPOCH_CACHE_PATH is resolved at
   *  module load, so `chdir` cannot simulate absence — stub the read
   *  itself instead.  Restored in `finally` so no other suite sees it. */
  const orig = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error("ENOENT");
  };
  try {
    assert.deepEqual(loadEpochCache(), {});
  } finally {
    fs.readFileSync = orig;
  }
});

test("_printPlan — lists every field that will be cleared", async () => {
  const pos = {
    totalCompoundedUsd: 277.05,
    compoundHistory: [{}, {}, {}],
    lastCompoundAt: "2026-07-18T04:08:36Z",
    totalLifetimeDepositUsd: 2500,
  };
  const { out } = await captureConsole(() =>
    _printPlan(KEY, pos, ["pool.key.one"], { "clear-hodl": true }),
  );
  const text = out.join("\n");
  assert.match(text, /=== Rescan plan ===/);
  assert.match(text, new RegExp(`Position key: ${KEY}`));
  /*- Current on-disk values must be echoed so the operator can see what
   *  they are about to lose. */
  assert.match(text, /totalCompoundedUsd:\s+277\.05/);
  assert.match(text, /compoundHistory\.length:\s+3/);
  /*- And every field the tool will delete must be named. */
  for (const field of [
    "position.totalCompoundedUsd",
    "position.compoundHistory",
    "position.lastCompoundAt",
    "position.totalLifetimeDepositUsd",
    "position.depositUsedFallback",
  ]) {
    assert.ok(text.includes(field), `plan must name ${field}`);
  }
  assert.match(text, /lifetimeHodlAmounts/);
  assert.match(text, /pool\.key\.one/);
});

test("_printPlan — absent on-disk values render as placeholders", async () => {
  const { out } = await captureConsole(() => _printPlan(KEY, {}, [], {}));
  const text = out.join("\n");
  assert.match(text, /totalCompoundedUsd:\s+—/);
  assert.match(text, /compoundHistory\.length:\s+0/);
  assert.match(text, /lastCompoundAt:\s+—/);
});

test("_printPlan — says so when no pool epoch key was found", async () => {
  const { out } = await captureConsole(() =>
    _printPlan(KEY, {}, [], { "clear-hodl": true }),
  );
  const text = out.join("\n");
  assert.match(text, /none found — only the position config/);
  assert.doesNotMatch(text, /lifetimeHodlAmounts/, "nothing to clear there");
});

test("_printPlan — names the pool and its HODL only if --clear-hodl", async () => {
  const withFlag = await captureConsole(() =>
    _printPlan(KEY, {}, ["k"], { "clear-hodl": true }),
  );
  const withText = withFlag.out.join("\n");
  assert.match(withText, /lifetimeHodlAmounts\s+\(--clear-hodl/);
  const without = await captureConsole(() => _printPlan(KEY, {}, ["k"], {}));
  const withoutText = without.out.join("\n");
  assert.doesNotMatch(withoutText, /lifetimeHodlAmounts|Pool epoch cache/);
});

/** The backup lines a plan names. */
async function plannedBackups(poolKeys, flags) {
  const { out } = await captureConsole(() =>
    _printPlan(KEY, {}, poolKeys, flags),
  );
  return out.filter((l) => l.includes(".pre-rescan.<ISO>.json"));
}

test("_printPlan — names both backups when --clear-hodl has a pool key", async () => {
  const backups = await plannedBackups(["k"], { "clear-hodl": true });
  assert.equal(backups.length, 2, "config + epoch cache backups");
});

test("_printPlan — names only the config backup without --clear-hodl", async () => {
  const backups = await plannedBackups(["k"], {});
  assert.equal(backups.length, 1);
});

test("_printPlan — names only the config backup when no pool key", async () => {
  const backups = await plannedBackups([], { "clear-hodl": true });
  assert.equal(backups.length, 1);
});
