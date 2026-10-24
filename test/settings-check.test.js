"use strict";

/**
 * @file test/settings-check.test.js
 * @description The settings check finds every problem with an install's
 *   settings at once: its copies of the JSON settings files, `.env`, and
 *   bot-config.json (src/lib/settings-check.js). The server and the bot refuse
 *   to start on any, and the
 *   `validate-config-values-with-any-user-overrides` diagnostic lists
 *   them.
 *
 *   Each case builds an install of its own in a temporary directory: the
 *   shipped files are the real ones, everything an operator writes is a
 *   fixture, and the process's own environment is replaced by an empty
 *   one, so the machine running the suite cannot change the answer.
 */

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  settingsProblems,
  refuseToStartOnBadSettings,
} = require("../src/lib/settings-check");
const { readEnv } = require("../src/lib/env-settings");
const { checkConfigValues } = require("../src/lib/config-bounds");
const {
  GLOBAL_KEYS,
  SETTING_POSITION_KEYS,
} = require("../src/lib/bot-config-keys");
const { SETTING_BOUNDS } = require("../src/lib/setting-bounds");
const { boundText } = require("../src/lib/range-check");

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * An install of its own: the operator's copies (`copies`, by file name),
 * its `.env` text and its bot-config.json text, each left out when not
 * given. Answers where to read it from, as `settingsProblems` takes it.
 */
function install({
  copies = {},
  env,
  botConfig,
  records,
  environment = {},
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-check-"));
  dirs.push(dir);
  const userDir = path.join(dir, "user-configurable");
  fs.mkdirSync(userDir);
  for (const [file, text] of Object.entries(copies))
    fs.writeFileSync(path.join(userDir, file), text);
  const envFile = path.join(dir, ".env");
  if (env !== undefined) fs.writeFileSync(envFile, env);
  const botConfigFile = path.join(userDir, "bot-config.json");
  if (botConfig !== undefined)
    fs.writeFileSync(botConfigFile, JSON.stringify(botConfig));
  const recordsFile = path.join(dir, "position-records.json");
  if (records !== undefined)
    fs.writeFileSync(recordsFile, JSON.stringify(records));
  return { userDir, envFile, botConfigFile, recordsFile, env: environment };
}

/** The problems of an install built from `o`. */
const problemsOf = (o) => settingsProblems(install(o));

/** Assert one problem mentions every part in `parts`, and return it. */
function oneProblem(problems, ...parts) {
  const found = problems.filter((p) => parts.every((s) => p.includes(s)));
  assert.equal(
    found.length,
    1,
    `${parts.join(" / ")} in:\n${problems.join("\n")}`,
  );
  return found[0];
}

const WALLET = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const KEY = `pulsechain-${WALLET}-${PM}-101`;

describe("an install with no settings of its own", () => {
  it("has no problem", () => {
    assert.deepEqual(problemsOf(), []);
  });
});

describe("the operator's copies of the settings files", () => {
  it("refuses a quoted true, naming the file and the setting", () => {
    const problems = problemsOf({
      copies: {
        "bot-config-defaults.json": '{ "fullRangeRebalanceEnabled": "true" }',
      },
    });
    oneProblem(
      problems,
      "bot-config-defaults.json",
      "fullRangeRebalanceEnabled",
      "true or false",
    );
  });

  it("refuses a setting LP Ranger does not read", () => {
    const problems = problemsOf({
      copies: { "logging.json": '{ "enabeld": true }' },
    });
    oneProblem(
      problems,
      "logging.json → enabeld",
      "not a setting LP Ranger reads",
    );
  });

  it("refuses a value outside its range", () => {
    const problems = problemsOf({
      copies: { "bot-config-defaults.json": '{ "maxRebalancesPerDay": 0 }' },
    });
    oneProblem(problems, "maxRebalancesPerDay");
  });

  it("refuses a copy that is not valid JSON, naming it", () => {
    const problems = problemsOf({ copies: { "chains.json": "{ nope" } });
    oneProblem(problems, "chains.json", "is not valid JSON");
  });

  it("refuses a copy of a file the app never reads from there", () => {
    const problems = problemsOf({
      copies: {
        "setting-bounds.json": "{}",
        "ui-defaults_non-layout_for-server-down-scenario.json": "{}",
      },
    });
    oneProblem(
      problems,
      "setting-bounds.json",
      "is not a file LP Ranger reads",
    );
    oneProblem(
      problems,
      "server-down-scenario.json",
      "is not a file LP Ranger reads",
    );
  });

  it("refuses a timer past its ceiling, a multiple of the shipped value", () => {
    const problems = problemsOf({
      copies: { "app-runtime.json": '{ "tx": { "speedupSec": 999999999 } }' },
    });
    oneProblem(problems, "tx.speedupSec");
  });

  it("refuses a setting put in a file that does not read it", () => {
    /*-
     *  A setting with a range of its own, in a file that never reads it:
     *  the schema of each file names the keys that file takes.
     */
    const problems = problemsOf({
      copies: {
        "app-runtime.json": '{ "maxRebalancesPerDay": 3 }',
        "bot-config-defaults.json": '{ "slippagePctToken0": 1 }',
      },
    });
    oneProblem(
      problems,
      "app-runtime.json → maxRebalancesPerDay",
      "not a setting LP Ranger reads",
    );
    oneProblem(
      problems,
      "bot-config-defaults.json → slippagePctToken0",
      "not a setting LP Ranger reads",
    );
  });

  it("refuses a list where one number belongs", () => {
    const problems = problemsOf({
      copies: { "bot-config-defaults.json": '{ "maxRebalancesPerDay": [5] }' },
    });
    oneProblem(
      problems,
      "bot-config-defaults.json → maxRebalancesPerDay",
      boundText(SETTING_BOUNDS.maxRebalancesPerDay),
      "it is [5]",
    );
  });

  it("holds each stop timing to its range", () => {
    for (const key of [
      "exitTimeoutMs",
      "stopKillMarginMs",
      "stopCheckIntervalMs",
      "gentleStopPollMs",
    ]) {
      const { max } = SETTING_BOUNDS.timers.settings[key];
      const copy = JSON.stringify({ shutdown: { [key]: max + 1 } });
      oneProblem(
        problemsOf({ copies: { "app-runtime.json": copy } }),
        `app-runtime.json → shutdown.${key}`,
        `${max}`,
      );
    }
  });

  it("holds the transaction deadline to its range", () => {
    const bound = SETTING_BOUNDS.tx.deadlineSec;
    const copy = JSON.stringify({ tx: { deadlineSec: bound.min - 1 } });
    oneProblem(
      problemsOf({ copies: { "app-runtime.json": copy } }),
      "app-runtime.json → tx.deadlineSec",
      boundText(bound),
    );
  });

  it("refuses a chain the settings name that chains.json does not hold", () => {
    const problems = problemsOf({
      copies: { "app-runtime.json": '{ "defaults": { "chain": "nochain" } }' },
    });
    oneProblem(problems, "defaults.chain", "a chain in chains.json");
  });

  it("refuses a label for a setting the dashboard never saves", () => {
    const problems = problemsOf({
      copies: {
        "setting-labels.json":
          '{ "notASetting": { "label": "x", "unit": "" } }',
      },
    });
    oneProblem(
      problems,
      "setting-labels.json → notASetting",
      "a setting the dashboard saves",
    );
  });

  it("names each entry of a list on its own", () => {
    const problems = problemsOf({
      copies: {
        "chains.json": JSON.stringify({
          pulsechain: { rpc: { urls: ["https://rpc.example", "ftp://x"] } },
        }),
      },
    });
    oneProblem(problems, "chains.json → pulsechain.rpc.urls[1]", '"ftp://x"');
  });
});

describe(".env", () => {
  it("reads an on/off variable as exactly true or false", () => {
    assert.deepEqual(problemsOf({ env: "DRY_RUN=true\nVERBOSE=false\n" }), []);
    for (const text of ["yes", "1", "TRUE", "on"])
      oneProblem(
        problemsOf({ env: `DRY_RUN=${text}\n` }),
        "DRY_RUN",
        "true or false",
      );
  });

  it("reads a number only as plain digits", () => {
    for (const text of ["1,800", "1e3", "-5", "abc", "2.5"])
      oneProblem(
        problemsOf({ env: `TX_SPEEDUP_SEC=${text}\n` }),
        "TX_SPEEDUP_SEC",
      );
  });

  it("refuses a timer outside its range", () => {
    for (const text of ["0", "5", "7200"])
      oneProblem(
        problemsOf({ env: `CHECK_INTERVAL_SEC=${text}\n` }),
        "CHECK_INTERVAL_SEC",
      );
  });

  it("holds DEADLINE_SEC to the deadline's range", () => {
    const bound = SETTING_BOUNDS.tx.deadlineSec;
    for (const out of [bound.min - 1, bound.max + 1])
      oneProblem(
        problemsOf({ env: `DEADLINE_SEC=${out}\n` }),
        "DEADLINE_SEC",
        boundText(bound),
      );
    for (const fine of [bound.min, bound.max])
      assert.deepEqual(problemsOf({ env: `DEADLINE_SEC=${fine}\n` }), []);
  });

  it("refuses a variable LP Ranger does not read, and a line that is not NAME=value", () => {
    const problems = problemsOf({
      env: "NODE_OPTIONS=--foo\nCHECK_INTERVAL_SEC 300\n",
    });
    oneProblem(problems, "NODE_OPTIONS", "not a setting LP Ranger reads");
    oneProblem(problems, "line 2", "NAME=value");
  });

  it("accepts the variables LP Ranger's own tools read, each by its rule", () => {
    /*-
     *  `npm run debug-attach` reads INSPECTOR_PORT and LP_RANGER_PID, and
     *  the verify-compound-usd diagnostic MORALIS_API_KEY. They are LP
     *  Ranger's settings too, so `.env` may hold them and the server
     *  still starts.
     */
    assert.deepEqual(
      problemsOf({
        env: "INSPECTOR_PORT=9230\nLP_RANGER_PID=4242\nMORALIS_API_KEY=k\n",
      }),
      [],
    );
    oneProblem(
      problemsOf({ env: "INSPECTOR_PORT=port\n" }),
      "INSPECTOR_PORT",
      "a port number",
    );
    oneProblem(
      problemsOf({ env: "LP_RANGER_PID=-1\n" }),
      "LP_RANGER_PID",
      "a whole number",
    );
  });

  it("reads an export line by the name it sets, as dotenv does", () => {
    const problems = problemsOf({
      env: "export CHECK_INTERVAL_SEC=300\nexport NODE_OPTIONS=--foo\n",
    });
    oneProblem(problems, "NODE_OPTIONS", "not a setting LP Ranger reads");
    assert.equal(problems.length, 1, problems.join("\n"));
  });

  it("reads a quoted value over several lines as one setting", () => {
    const problems = problemsOf({ env: 'LOG_FILE="./a\nb.json"\n' });
    assert.deepEqual(problems, []);
  });

  it("takes a private key with or without its 0x, as the wallet does", () => {
    const digits = "ab".repeat(32);
    for (const key of [`0x${digits}`, digits])
      assert.deepEqual(problemsOf({ env: `PRIVATE_KEY=${key}\n` }), []);
  });

  it("never quotes the private key or the wallet password back", () => {
    const secret = "0xnotakey-secret-text";
    const problems = problemsOf({ env: `PRIVATE_KEY=${secret}\n` });
    const p = oneProblem(problems, "PRIVATE_KEY");
    assert.ok(!p.includes(secret), p);
  });

  it("lets the environment's own value stand over .env's, as the app does", () => {
    const problems = problemsOf({
      env: "DRY_RUN=yes\n",
      environment: { DRY_RUN: "true" },
    });
    assert.deepEqual(problems, []);
  });
});

describe("bot-config.json", () => {
  it("refuses a file that is not valid JSON", () => {
    const o = install();
    fs.writeFileSync(o.botConfigFile, "{ broken");
    oneProblem(settingsProblems(o), "bot-config.json is not valid JSON");
  });

  it("holds a saved setting to the rule a save is held to", () => {
    const problems = problemsOf({
      botConfig: { positions: { [KEY]: { slippagePctToken0: 99 } } },
    });
    oneProblem(problems, "slippagePctToken0");
  });

  it("refuses a setting, a section or a position key it does not read", () => {
    const problems = problemsOf({
      botConfig: {
        extra: 1,
        global: { mystery: 1 },
        positions: { "not-a-key": {}, [KEY]: { mystery: 2 } },
      },
    });
    oneProblem(problems, "bot-config.json → extra");
    oneProblem(problems, "global.mystery");
    oneProblem(problems, "positions.not-a-key");
    oneProblem(problems, `${KEY}.mystery`);
  });

  it("holds a position's status and the alerts chosen to their own rules", () => {
    const problems = problemsOf({
      botConfig: {
        global: { telegramEvents: { oorTimeout: "yes", noSuchAlert: true } },
        positions: { [KEY]: { status: "paused" } },
      },
    });
    oneProblem(problems, "telegramEvents.oorTimeout must be true or false");
    oneProblem(
      problems,
      "telegramEvents.noSuchAlert must be an alert LP Ranger sends",
    );
    oneProblem(problems, "status", "running or stopped");
  });

  it("leaves a retired key for the next save to drop, and a cleared one alone", () => {
    const problems = problemsOf({
      botConfig: {
        global: { positionManager: PM, factory: PM, triggerType: "x" },
        positions: {
          [KEY]: {
            status: "running",
            slippagePct: 1,
            lifetimeHodlAmounts: {},
            impermanentLossGuardPct: null,
          },
        },
      },
    });
    assert.deepEqual(problems, []);
  });

  it("starts on the single rpc address older releases saved", () => {
    /*-
     *  Releases up to 0.9.2.1 saved `rpcUrl` whenever the rpc field
     *  changed or a preset was clicked, and nothing has removed it
     *  since, so an upgraded install may hold one it never typed.
     */
    const problems = problemsOf({
      botConfig: { global: { rpcUrl: "https://rpc.pulsechain.com" } },
    });
    assert.deepEqual(problems, []);
  });

  it("refuses each value a save refuses, setting by setting", () => {
    /*-
     *  One schema for each setting serves both checks
     *  (src/lib/config-bounds.js), so a value the Save button refuses is one
     *  startup refuses, and the file takes every key a save writes. Text
     *  where a setting wants a number, a list, a date or on or off is
     *  refused by both.
     */
    const bad = "not a value of any setting";
    const saveRefuses = (key) =>
      assert.notEqual(
        checkConfigValues({ [key]: bad }, { compoundMinFeeUsd: 1 }),
        null,
        key,
      );
    for (const key of GLOBAL_KEYS) {
      saveRefuses(key);
      const problems = problemsOf({ botConfig: { global: { [key]: bad } } });
      oneProblem(problems, `global.${key} must be`);
    }
    for (const key of SETTING_POSITION_KEYS) {
      saveRefuses(key);
      const problems = problemsOf({
        botConfig: { positions: { [KEY]: { [key]: bad } } },
      });
      oneProblem(problems, `${KEY}.${key} must be`);
    }
  });

  it("names a record left in it, with the command that moves it to the records file", () => {
    const problems = problemsOf({
      botConfig: {
        positions: { [KEY]: { status: "running", lastCompoundAt: "x" } },
      },
    });
    const p = oneProblem(problems, `${KEY}.lastCompoundAt`);
    assert.match(p, /lastCompoundAt is a record, which LP Ranger now keeps/);
    assert.match(p, /app-data\/position-records\.json/);
    assert.match(p, /node \.\/util\/migration/);
  });

  it("refuses a file that is not a group of settings, naming the file", () => {
    const problems = problemsOf({ botConfig: [] });
    oneProblem(problems, "bot-config.json must be a group of settings");
  });
});

describe("the records file, app-data/position-records.json", () => {
  const POOL = "0x" + "ab".repeat(20);

  it("starts on the records the bot writes", () => {
    const problems = problemsOf({
      records: {
        positions: {
          [KEY]: {
            lastCompoundAt: "2026-10-19T00:00:00.000Z",
            compoundedAmount0: 1.5,
            depositUsedFallback: false,
          },
        },
      },
    });
    assert.deepEqual(problems, []);
  });

  it("holds each record to the shape the bot writes", () => {
    const problems = problemsOf({
      records: {
        positions: {
          [KEY]: { residuals: { [POOL]: { token0: "abc", token1: "1" } } },
        },
      },
    });
    oneProblem(problems, "position-records.json", `${KEY}.residuals`);
  });

  it("refuses a key that is not a record, and a file that is not JSON", () => {
    const problems = problemsOf({
      records: { positions: { [KEY]: { slippagePctToken0: 1 } } },
    });
    oneProblem(problems, "slippagePctToken0", "is not a record");
    const o = install();
    fs.writeFileSync(o.recordsFile, "{ broken");
    oneProblem(settingsProblems(o), "position-records.json is not valid JSON");
  });
});

describe("readEnv, how the app reads a variable", () => {
  it("answers the value its text sets, and nothing for an unset or blank one", () => {
    assert.equal(readEnv("DRY_RUN", { DRY_RUN: "true" }), true);
    assert.equal(readEnv("PORT", { PORT: " 5599 " }), 5599);
    assert.equal(readEnv("PORT", {}), undefined);
    assert.equal(readEnv("PORT", { PORT: "  " }), undefined);
  });

  it("throws naming the variable for text that is not its kind", () => {
    assert.throws(
      () => readEnv("DRY_RUN", { DRY_RUN: "yes" }),
      /DRY_RUN in \.env/,
    );
    assert.throws(() => readEnv("PORT", { PORT: "80a" }), /PORT in \.env/);
  });
});

describe("startup", () => {
  it("prints every problem and exits when there is any", () => {
    const printed = [];
    const exits = [];
    refuseToStartOnBadSettings({
      print: (t) => printed.push(t),
      exit: (c) => exits.push(c),
      where: install({ env: "DRY_RUN=yes\nNODE_OPTIONS=--foo\n" }),
    });
    assert.deepEqual(exits, [1]);
    assert.match(printed.join("\n"), /LP Ranger cannot start/);
    assert.match(printed.join("\n"), /DRY_RUN/);
    assert.match(printed.join("\n"), /NODE_OPTIONS/);
  });

  it("goes on when every setting passes", () => {
    const printed = [];
    const exits = [];
    refuseToStartOnBadSettings({
      print: (t) => printed.push(t),
      exit: (c) => exits.push(c),
      where: install(),
    });
    assert.deepEqual(exits, []);
    assert.deepEqual(printed, []);
  });
});
