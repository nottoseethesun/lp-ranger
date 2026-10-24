/**
 * @file test/bot-config-defaults.test.js
 * @description Unit tests for src/lib/bot-config-defaults.js and the
 * GET /api/bot-config-defaults route handler.
 *
 * Tests write a `bot-config-defaults.json` operator override and let
 * the loader deep-merge it on top of the shipped defaults, so this
 * exercises the exact same path real operators use.  The shipped file
 * is the known-good baseline that `loadShippedDefaults()` reads once at
 * module init for the per-key fallback when an operator's override
 * contains an out-of-range value.
 *
 * **The override goes in this process's own directory, not the real
 * one.**  Some of these cases write a deliberately bad value to prove
 * the strict reader refuses it.  The real
 * `app-config/user-configurable/` is one directory shared by every
 * process on the machine, and the runner starts a separate process per
 * test file and runs 24 at once — so a bad override left there for even
 * a moment is the live config of 23 unrelated test processes, and one
 * of them requiring `src/lib/config.js` in that window dies on the startup
 * throw.  That produced a real intermittent (`bot-hodl-scan` failing
 * once in CI and never on a re-run).  `LP_RANGER_USER_CONFIG_DIR` is
 * read by `src/lib/load-merged-defaults.js` at module load, so it is set
 * here BEFORE anything under `src/lib/` is required.
 */

"use strict";

const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const _TMP_ROOT = path.join(__dirname, "..", "tmp");
fs.mkdirSync(_TMP_ROOT, { recursive: true });
const _USER_DIR = fs.mkdtempSync(path.join(_TMP_ROOT, "defaults-test-"));
process.env.LP_RANGER_USER_CONFIG_DIR = _USER_DIR;

after(() => fs.rmSync(_USER_DIR, { recursive: true, force: true }));

const _SHIPPED_FILE = path.join(
  __dirname,
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
  "bot-config-defaults.json",
);

const _USER_FILE = path.join(_USER_DIR, "bot-config-defaults.json");

/*- The shipped JSON is the source of truth for default values; the
 *  tests read it (NOT a hardcoded copy) so this file never drifts
 *  when an operator updates the shipped defaults. */
const _SHIPPED = JSON.parse(fs.readFileSync(_SHIPPED_FILE, "utf8"));

// Each setting's range, read the same way and for the same reason.
const SETTING_BOUNDS = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(_SHIPPED_FILE), "setting-bounds.json"),
    "utf8",
  ),
);

// Dependency-free, so loading it here reads no configuration.
const { boundText } = require("../src/lib/range-check");

function _clearModuleCache() {
  delete require.cache[require.resolve("../src/lib/bot-config-defaults")];
  delete require.cache[require.resolve("../src/lib/load-merged-defaults")];
}

function _writeUser(obj) {
  fs.writeFileSync(_USER_FILE, JSON.stringify(obj));
  /*- The loader reads each file once and keeps it, so changing the file
   *  on disk is exactly the moment that read stops being true.  Doing it
   *  here rather than in each case means a loop that writes several
   *  overrides gets each one.
   *
   *  Required inside the function, not hoisted: `_clearModuleCache`
   *  drops the loader from the require cache, so a reference captured
   *  at file load would reset an instance nothing reads any more while
   *  the fresh one kept its memo. */
  require("../src/lib/load-merged-defaults")._resetMemoForTests();
}

function _clearUser() {
  /*- TOCTOU-safe: a parallel test (24-way concurrency per
   *  package.json) could unlink between exists and unlink.  Treat
   *  ENOENT as success since the post-condition (file absent) holds. */
  try {
    fs.unlinkSync(_USER_FILE);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  require("../src/lib/load-merged-defaults")._resetMemoForTests();
}

beforeEach(() => {
  _clearUser();
  _clearModuleCache();
});

afterEach(() => {
  _clearUser();
  _clearModuleCache();
});

describe("bot-config-defaults.readBotConfigDefaults", () => {
  it("returns approvalMultiple from the shipped JSON when no override exists", () => {
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("returns operator-edited approvalMultiple from the user override", () => {
    _writeUser({ approvalMultiple: 50 });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 50);
  });

  it("falls back to shipped default when user override is malformed JSON", () => {
    fs.writeFileSync(_USER_FILE, "{ not valid json");
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("ignores non-numeric override values (falls back to shipped)", () => {
    _writeUser({ approvalMultiple: "forty" });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("refuses a fractional approvalMultiple override rather than rounding it", () => {
    /*-
     *  A whole-number setting given a fraction is not moved to a nearby
     *  whole number, which would be a value nobody chose: the shipped
     *  default stands, as for any other value outside its range.
     */
    _writeUser({ approvalMultiple: 25.8 });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("rejects approvalMultiple < 1 in override (falls back to shipped)", () => {
    for (const bad of [0, -5]) {
      _writeUser({ approvalMultiple: bad });
      _clearModuleCache();
      const {
        readBotConfigDefaults,
      } = require("../src/lib/bot-config-defaults");
      const out = readBotConfigDefaults();
      assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
    }
  });

  it("rejects approvalMultiple above the 1_000_000 cap (falls back to shipped)", () => {
    _writeUser({ approvalMultiple: 2_000_000 });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, _SHIPPED.approvalMultiple);
  });

  it("ignores _comment / _*-prefixed keys in the override (just doc fields)", () => {
    _writeUser({ _comment: "doc", approvalMultiple: 30 });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.approvalMultiple, 30);
    assert.equal(out._comment, undefined);
  });

  it("returns all shipped user-setting defaults when no override exists", () => {
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(
      out.rebalanceOutOfRangeThresholdPercent,
      _SHIPPED.rebalanceOutOfRangeThresholdPercent,
    );
    assert.equal(out.rebalanceTimeoutMin, _SHIPPED.rebalanceTimeoutMin);
    assert.equal(out.slippagePct, _SHIPPED.slippagePct);
    assert.equal(out.checkIntervalSec, _SHIPPED.checkIntervalSec);
    assert.equal(out.minRebalanceIntervalMin, _SHIPPED.minRebalanceIntervalMin);
    assert.equal(out.maxRebalancesPerDay, _SHIPPED.maxRebalancesPerDay);
    assert.equal(out.offsetToken0Pct, _SHIPPED.offsetToken0Pct);
  });

  it("returns operator-edited values when within range", () => {
    _writeUser({
      rebalanceOutOfRangeThresholdPercent: 7,
      rebalanceTimeoutMin: 0,
      slippagePct: 1.2,
      checkIntervalSec: 120,
      minRebalanceIntervalMin: 30,
      maxRebalancesPerDay: 10,
      offsetToken0Pct: 60,
    });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.rebalanceOutOfRangeThresholdPercent, 7);
    assert.equal(out.rebalanceTimeoutMin, 0);
    assert.equal(out.slippagePct, 1.2);
    assert.equal(out.checkIntervalSec, 120);
    assert.equal(out.minRebalanceIntervalMin, 30);
    assert.equal(out.maxRebalancesPerDay, 10);
    assert.equal(out.offsetToken0Pct, 60);
  });

  it("holds the daily cap to the range a Bot Settings save is held to", () => {
    /*-
     *  One range for both roads: the shipped file is held to the same
     *  cap a Bot Settings save is refused past.
     */
    _writeUser({ maxRebalancesPerDay: 50 });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.maxRebalancesPerDay, _SHIPPED.maxRebalancesPerDay);
  });

  it("STRICT refuses an out-of-range checkIntervalSec rather than resetting it", () => {
    /*- The poll interval becomes a `setTimeout` delay, so it is bounded
     *  by `src/lib/timer-bounds.js` — the same module `.env` and
     *  `POST /api/config` ask. At startup it is refused rather than
     *  replaced, because a schedule silently swapped for a default is a
     *  bot running on a cadence nobody chose, and the cadence is then
     *  the last thing anyone would think to check. */
    const {
      readBotConfigDefaultsStrict,
    } = require("../src/lib/bot-config-defaults");
    for (const bad of [1, 9, 3601, 7200, "abc", 0, -5]) {
      _writeUser({ checkIntervalSec: bad });
      assert.throws(
        () => readBotConfigDefaultsStrict(),
        /checkIntervalSec/,
        `${String(bad)} must be refused, not replaced`,
      );
    }
    /*- The bounds are the shared ones: 10 through 3600. */
    for (const good of [10, 300, 3600]) {
      _writeUser({ checkIntervalSec: good });
      assert.equal(readBotConfigDefaultsStrict().checkIntervalSec, good);
    }
  });

  it("STRICT refuses a request pacing under 5 ms, so pacing cannot be turned off", () => {
    /*-
     *  The user, 2026-10-18: "let's not allow a pacing of 0; it should
     *  be at least 5 ms."
     */
    const {
      readBotConfigDefaultsStrict,
    } = require("../src/lib/bot-config-defaults");
    for (const bad of [0, 4, -1]) {
      _writeUser({ globalRPCRequestRateIntervalMS: bad });
      assert.throws(
        () => readBotConfigDefaultsStrict(),
        /globalRPCRequestRateIntervalMS/,
        `${String(bad)} must be refused`,
      );
    }
    for (const good of [5, 100]) {
      _writeUser({ globalRPCRequestRateIntervalMS: good });
      assert.equal(
        readBotConfigDefaultsStrict().globalRPCRequestRateIntervalMS,
        good,
      );
    }
  });

  it("LENIENT never throws, because a poll cycle and a route call it", () => {
    /*- This file is re-read on every call, and several of those calls
     *  are on hot paths — `GET /api/bot-config-defaults` among them,
     *  which the file header promises never 500s. An edit made while
     *  the bot is running must not break a poll; it falls back here and
     *  is refused at the next start. */
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    for (const bad of [1, 9, 3601, 7200, "abc", 0, -5]) {
      _writeUser({ checkIntervalSec: bad });
      assert.equal(
        readBotConfigDefaults().checkIntervalSec,
        _SHIPPED.checkIntervalSec,
        `${String(bad)} falls back rather than throwing`,
      );
    }
  });

  it("STRICT refuses a setting out of range that is not a timer, too", () => {
    /*-
     *  The lenient reader keeps the shipped default in its place, as for
     *  a timer; the strict one, at startup, refuses it.
     */
    _writeUser({ slippagePct: 99, checkIntervalSec: 300 });
    const mod = require("../src/lib/bot-config-defaults");
    assert.throws(() => mod.readBotConfigDefaultsStrict(), /slippagePct/);
    assert.equal(mod.readBotConfigDefaults().slippagePct, _SHIPPED.slippagePct);
  });

  it("rejects out-of-range overrides and falls back per-key to shipped", () => {
    _writeUser({
      rebalanceOutOfRangeThresholdPercent: 0, // below min
      rebalanceTimeoutMin: -10, // negative
      slippagePct: 99, // above max
      // above max: one past the range in setting-bounds.json
      minRebalanceIntervalMin: SETTING_BOUNDS.minRebalanceIntervalMin.max + 1,
      maxRebalancesPerDay: 0, // below min
      offsetToken0Pct: 200, // above max
    });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(
      out.rebalanceOutOfRangeThresholdPercent,
      _SHIPPED.rebalanceOutOfRangeThresholdPercent,
    );
    assert.equal(out.rebalanceTimeoutMin, _SHIPPED.rebalanceTimeoutMin);
    assert.equal(out.slippagePct, _SHIPPED.slippagePct);
    assert.equal(out.checkIntervalSec, _SHIPPED.checkIntervalSec);
    assert.equal(out.minRebalanceIntervalMin, _SHIPPED.minRebalanceIntervalMin);
    assert.equal(out.maxRebalancesPerDay, _SHIPPED.maxRebalancesPerDay);
    assert.equal(out.offsetToken0Pct, _SHIPPED.offsetToken0Pct);
  });

  it("returns priceCacheTtlMs and dustUnitPriceCacheMultiplier shipped defaults", () => {
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.priceCacheTtlMs, _SHIPPED.priceCacheTtlMs);
    assert.equal(
      out.dustUnitPriceCacheMultiplier,
      _SHIPPED.dustUnitPriceCacheMultiplier,
    );
  });

  it("clamps priceCacheTtlMs and dustUnitPriceCacheMultiplier override to safe bounds", () => {
    _writeUser({
      priceCacheTtlMs: 0, // below 1_000 ms floor
      dustUnitPriceCacheMultiplier: 0, // below 1 floor
    });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(
      out.priceCacheTtlMs,
      _SHIPPED.priceCacheTtlMs,
      "falls back to shipped",
    );
    assert.equal(
      out.dustUnitPriceCacheMultiplier,
      _SHIPPED.dustUnitPriceCacheMultiplier,
      "falls back to shipped",
    );
  });

  it("accepts in-range priceCacheTtlMs / dustUnitPriceCacheMultiplier overrides", () => {
    _writeUser({
      priceCacheTtlMs: 60_000,
      dustUnitPriceCacheMultiplier: 60,
    });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.priceCacheTtlMs, 60_000);
    assert.equal(out.dustUnitPriceCacheMultiplier, 60);
  });

  it("ignores non-numeric override values and keeps shipped defaults", () => {
    _writeUser({
      slippagePct: "half",
      checkIntervalSec: null,
      offsetToken0Pct: true,
    });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.slippagePct, _SHIPPED.slippagePct);
    assert.equal(out.checkIntervalSec, _SHIPPED.checkIntervalSec);
    assert.equal(out.offsetToken0Pct, _SHIPPED.offsetToken0Pct);
  });
});

describe("bot-config-defaults: rpc and history-scan plumbing", () => {
  /*-
   *  Each setting with an override inside its bounds, and one outside
   *  them. Inside, the override is what the reader returns; outside,
   *  the shipped value stands, as for every other key in the file.
   */
  const CASES = [
    ["rpcFailoverStickyMs", 120_000, 59_999],
    ["boundedReadAttemptsPerEndpoint", 3, 11],
    ["boundedReadRetryDelayMs", 1_000, 0],
    ["feeDataLogIntervalMs", 60_000, 999],
    ["historyLookbackYears", 2, 21],
    ["eventCacheTtlMs", 86_400_000, 3_599_999],
    ["poolScanReuseMs", 0, 3_600_001],
    ["rebalancePairingWindowSec", 600, 0],
  ];

  it("are shipped, each with a value", () => {
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    for (const [key] of CASES) assert.equal(out[key], _SHIPPED[key], key);
  });

  for (const [key, inRange, outOfRange] of CASES) {
    it(`${key}: takes ${inRange}, refuses ${outOfRange} for the shipped value`, () => {
      _writeUser({ [key]: inRange });
      let mod = require("../src/lib/bot-config-defaults");
      assert.equal(mod.readBotConfigDefaults()[key], inRange);

      _clearModuleCache();
      _writeUser({ [key]: outOfRange });
      mod = require("../src/lib/bot-config-defaults");
      assert.equal(mod.readBotConfigDefaults()[key], _SHIPPED[key]);
    });
  }

  it("STRICT refuses an out-of-range boundedReadRetryDelayMs at startup", () => {
    // It becomes a timer, so startup refuses it rather than resetting it.
    _writeUser({ boundedReadRetryDelayMs: 0 });
    const {
      readBotConfigDefaultsStrict,
    } = require("../src/lib/bot-config-defaults");
    assert.throws(
      () => readBotConfigDefaultsStrict(),
      /boundedReadRetryDelayMs/,
    );
  });
});

describe("bot-config-defaults: STRICT refuses any setting outside its range", () => {
  /*-
   *  At startup the strict reader refuses rather than replaces, for every
   *  setting with a range in setting-bounds.json: each top-level one, each
   *  member of a group, each entry of a list. The message names the
   *  setting, its range and what was written, so the operator knows what
   *  to correct, and where.
   */

  /** Write `override`, read strictly, and hand back what was thrown. */
  function strictRefusal(override) {
    _writeUser(override);
    const {
      readBotConfigDefaultsStrict,
    } = require("../src/lib/bot-config-defaults");
    let refusal = null;
    assert.throws(
      () => readBotConfigDefaultsStrict(),
      (err) => {
        refusal = err;
        return true;
      },
      `${JSON.stringify(override)} must be refused`,
    );
    return refusal;
  }

  /** Assert the refusal names `sentence`, as the operator would read it. */
  function names(err, sentence) {
    assert.equal(err.badSettingValue, true);
    assert.ok(err.message.includes(sentence), err.message);
  }

  it("refuses a value above its range, naming the file, setting and range", () => {
    const bound = SETTING_BOUNDS.maxRebalancesPerDay;
    const err = strictRefusal({ maxRebalancesPerDay: bound.max + 1 });
    names(
      err,
      `maxRebalancesPerDay must be ${boundText(bound)}; it is ${bound.max + 1}.`,
    );
    assert.match(
      err.message,
      /app-config\/user-configurable\/bot-config-defaults\.json/,
    );
  });

  it("refuses a fraction where the range takes whole numbers, and text", () => {
    const bound = SETTING_BOUNDS.approvalMultiple;
    names(
      strictRefusal({ approvalMultiple: 2.5 }),
      `approvalMultiple must be ${boundText(bound)}; it is 2.5.`,
    );
    names(
      strictRefusal({ approvalMultiple: "five" }),
      `approvalMultiple must be ${boundText(bound)}; it is "five".`,
    );
  });

  it("refuses a group's member outside its range, naming it by its path", () => {
    const bound = SETTING_BOUNDS.residualCleanup.delayMs;
    names(
      strictRefusal({ residualCleanup: { delayMs: 0 } }),
      `residualCleanup.delayMs must be ${boundText(bound)}; it is 0.`,
    );
  });

  it("refuses a group written as a single value", () => {
    names(
      strictRefusal({ residualCleanup: 5 }),
      "residualCleanup must be a set of named values; it is 5.",
    );
  });

  it("refuses a list with an entry outside the range", () => {
    const bound = SETTING_BOUNDS.rpcRetryOn429DelaysMs;
    names(
      strictRefusal({ rpcRetryOn429DelaysMs: [1000, 0] }),
      `rpcRetryOn429DelaysMs must be a list, each entry ${boundText(bound)};` +
        " it is [1000,0].",
    );
  });

  it("names every refused setting at once", () => {
    const err = strictRefusal({
      gasFeePct: SETTING_BOUNDS.gasFeePct.max + 1,
      ilGuardRetry: { baseMs: 1 },
    });
    assert.match(err.message, /gasFeePct must be/);
    assert.match(err.message, /ilGuardRetry\.baseMs must be/);
  });

  it("passes values inside their ranges, and ignores null", () => {
    const max = SETTING_BOUNDS.maxRebalancesPerDay.max;
    _writeUser({
      maxRebalancesPerDay: max,
      residualCleanup: { delayMs: 1 },
      rpcRetryOn429DelaysMs: [1000, 2000],
      slippagePct: null,
    });
    const {
      readBotConfigDefaultsStrict,
    } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaultsStrict();
    assert.equal(out.maxRebalancesPerDay, max);
    assert.equal(out.residualCleanup.delayMs, 1);
    assert.equal(
      out.residualCleanup.thresholdPct,
      _SHIPPED.residualCleanup.thresholdPct,
    );
    assert.deepEqual(out.rpcRetryOn429DelaysMs, [1000, 2000]);
    assert.equal(out.slippagePct, _SHIPPED.slippagePct);
  });

  it("LENIENT keeps the shipped value for each, never throwing", () => {
    _writeUser({
      maxRebalancesPerDay: SETTING_BOUNDS.maxRebalancesPerDay.max + 1,
      residualCleanup: { delayMs: 0 },
      rpcRetryOn429DelaysMs: [0],
    });
    const { readBotConfigDefaults } = require("../src/lib/bot-config-defaults");
    const out = readBotConfigDefaults();
    assert.equal(out.maxRebalancesPerDay, _SHIPPED.maxRebalancesPerDay);
    assert.equal(out.residualCleanup.delayMs, _SHIPPED.residualCleanup.delayMs);
    assert.deepEqual(out.rpcRetryOn429DelaysMs, _SHIPPED.rpcRetryOn429DelaysMs);
  });
});

describe("bot-config-defaults: the file is read once", () => {
  it("returns the same frozen object rather than re-reading", () => {
    /*- Parsing and merging the file costs real synchronous I/O, and
     *  callers include a poll cycle and a per-request path.  One read
     *  is also the semantics the file documents: override it and
     *  restart. */
    const mod = require("../src/lib/bot-config-defaults");
    const first = mod.readBotConfigDefaults();
    assert.equal(mod.readBotConfigDefaults(), first, "same object");
    assert.equal(Object.isFrozen(first), true, "frozen");
  });

  it("picks up an override written after the first read only on reset", () => {
    /*- Every caller shares one object now, so the memo is what makes a
     *  mid-run edit invisible until restart — and the reset hook is
     *  what lets a test stand in for that restart. */
    const mod = require("../src/lib/bot-config-defaults");
    assert.equal(
      mod.readBotConfigDefaults().approvalMultiple,
      _SHIPPED.approvalMultiple,
    );

    _writeUser({ approvalMultiple: 77 });
    assert.equal(
      mod.readBotConfigDefaults().approvalMultiple,
      _SHIPPED.approvalMultiple,
      "the edit is not seen while the process is up",
    );

    mod._resetMemoForTests();
    assert.equal(mod.readBotConfigDefaults().approvalMultiple, 77);
  });
});
