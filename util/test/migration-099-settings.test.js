/**
 * @file util/test/migration-099-settings.test.js
 * @description Tests for the migration's two steps for release 0.9.9's
 *   settings (util/migration/from-0.9.9/update-099-setting-copies.js and
 *   update-099-env.js): an install updated from 0.9.9 starts on this
 *   release once the migration has run.
 *
 *   The install a case builds is shaped as 0.9.9 left it: a whole copy
 *   of each settings file 0.9.9 shipped, as its README suggested, with
 *   the keys 0.9.9 read and this release does not; its ui-defaults.json;
 *   and a `.env` in 0.9.9's spellings. Each is made from the files this
 *   release ships with 0.9.9's differences put back, so the test needs
 *   no copy of the old release. Each case's install is in a temp folder
 *   of its own, so no operator file is in reach.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTestTempFolder } = require("../../src/lib/test-temp-folders");
const { settingsProblems } = require("../../src/lib/settings-check");
const { runMigration, report } = require("../migration");

const SHIPPED = path.join(
  __dirname,
  "..",
  "..",
  "app-config",
  "app-defaults-for-user-configurable",
);
const USER = "app-config/user-configurable";

/** A file this release ships, parsed afresh, so a case may change it. */
const shipped = (file) =>
  JSON.parse(fs.readFileSync(path.join(SHIPPED, file), "utf8"));

/** Write `value` to `rel` in `root`, as JSON unless it is text. */
function put(root, rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value, null, 2),
  );
}

const read = (root, rel) =>
  JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

/** A file's lines. */
const lines = (text) => text.split("\n");

// A key a whole-file copy of 0.9.9's app-runtime.json held.
const API_KEY = "the-aggregator-key-0.9.9-read";

/** Whole copies of each settings file, as 0.9.9 shipped it. */
function copiesFrom099() {
  const botDefaults = shipped("bot-config-defaults.json");
  Object.assign(botDefaults, {
    gasFeePctMin: 0.1,
    gasFeePctMax: 15,
    impermanentLossGuardPctMin: 1,
    impermanentLossGuardPctMax: 100,
  });
  const runtime = shipped("app-runtime.json");
  runtime.aggregator = { url: "https://api.9mm.pro/swap/v1", apiKey: API_KEY };
  // Retired since (util/migration/from-0.9.10/retire-price-move-retries.js).
  runtime.tx.retrySwapLimit = 8;
  const chains = shipped("chains.json");
  for (const chain of Object.values(chains)) {
    if (chain === null || typeof chain !== "object") continue;
    chain.contracts.swapRouter = chain.contracts.swapRouter.address;
    chain.aggregator.blockchain = "pulsechain";
  }
  const dust = shipped("dust-threshold.json");
  for (const t of dust.priceSourceTokens) {
    t.chain = t.moralisChain;
    delete t.moralisChain;
  }
  const labels = shipped("setting-labels.json");
  labels.checkIntervalSec = { label: "Check Interval", unit: "s" };
  labels.gasStrategy = { label: "Gas Strategy", unit: "" };
  return {
    "bot-config-defaults.json": botDefaults,
    "app-runtime.json": runtime,
    "chains.json": chains,
    "dust-threshold.json": dust,
    "setting-labels.json": labels,
    "ui-defaults.json": {
      dialogMaxHeightPx: 700,
      soundsEnabled: false,
      privacyModeEnabled: true,
      privacyBlurWalletAddresses: true,
      privacyBlurUsdAmounts: false,
      privacyUsdAmountThreshold: 50,
    },
  };
}

const ENV_099 = [
  "# The operator's own note stays.",
  "DRY_RUN=1",
  "VERBOSE=yes",
  "SLIPPAGE_PCT=0.5",
  `AGGREGATOR_API_KEY=${API_KEY}`,
  "CHECK_INTERVAL_SEC=300",
  "",
].join("\n");

/** An install as 0.9.9 left it. */
function installFrom099() {
  const root = makeTestTempFolder("migration-099");
  for (const [file, value] of Object.entries(copiesFrom099()))
    put(root, `${USER}/${file}`, value);
  put(root, ".env", ENV_099);
  fs.chmodSync(path.join(root, ".env"), 0o600);
  return root;
}

/** Every problem the startup check finds in the install at `root`. */
const problemsAt = (root) =>
  settingsProblems({
    userDir: path.join(root, USER),
    envFile: path.join(root, ".env"),
    env: {},
    botConfigFile: path.join(root, USER, "bot-config.json"),
    recordsFile: path.join(root, "app-data", "position-records.json"),
  });

describe("an install updated from 0.9.9", () => {
  it("would not start before the migration, and starts after it", () => {
    const root = installFrom099();
    assert.ok(problemsAt(root).length >= 10, problemsAt(root).join("\n"));
    runMigration({ root });
    assert.deepEqual(problemsAt(root), []);
  });

  it("keeps every value the operator set, in the file that reads it now", () => {
    const root = installFrom099();
    runMigration({ root });
    assert.deepEqual(read(root, `${USER}/ui-defaults_layout.json`), {
      dialogMaxHeightPx: 700,
    });
    assert.deepEqual(
      read(root, `${USER}/ui-defaults_non-layout_for-server-up-scenario.json`),
      {
        soundsEnabled: false,
        privacyModeEnabled: true,
        privacyBlurWalletAddresses: true,
        privacyBlurUsdAmounts: false,
        privacyUsdAmountThreshold: 50,
      },
    );
    const chains = read(root, `${USER}/chains.json`);
    assert.deepEqual(chains.pulsechain.contracts.swapRouter, {
      address: shipped("chains.json").pulsechain.contracts.swapRouter.address,
    });
    const tokens = read(root, `${USER}/dust-threshold.json`).priceSourceTokens;
    assert.deepEqual(
      tokens.map((t) => t.moralisChain),
      shipped("dust-threshold.json").priceSourceTokens.map(
        (t) => t.moralisChain,
      ),
    );
  });

  it("keeps a copy of each file it changes, and moves ui-defaults.json aside", () => {
    const root = installFrom099();
    runMigration({ root });
    const kept = fs.readdirSync(path.join(root, "tmp"));
    for (const name of [
      "bot-config-defaults",
      "app-runtime",
      "chains",
      "dust-threshold",
      "setting-labels",
      "ui-defaults",
    ])
      assert.ok(
        kept.some((f) => f.startsWith(`${name}.pre-migration-`)),
        `${name}: ${kept.join(", ")}`,
      );
    assert.equal(
      fs.existsSync(path.join(root, USER, "ui-defaults.json")),
      false,
    );
  });

  it("keeps a value the operator already set in a file ui-defaults.json splits into", () => {
    const root = installFrom099();
    put(root, `${USER}/ui-defaults_layout.json`, { dialogMaxHeightPx: 800 });
    runMigration({ root });
    assert.deepEqual(read(root, `${USER}/ui-defaults_layout.json`), {
      dialogMaxHeightPx: 800,
    });
  });

  it("changes nothing on a dry run, and nothing more when run again", () => {
    const root = installFrom099();
    const before = fs.readFileSync(path.join(root, ".env"), "utf8");
    const dry = report(runMigration({ root, dryRun: true }), true);
    assert.match(dry, /would remove gasFeePctMin/);
    assert.match(dry, /would write DRY_RUN as true/);
    assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), before);
    assert.equal(
      fs.existsSync(path.join(root, USER, "ui-defaults.json")),
      true,
    );
    runMigration({ root });
    assert.equal(
      report(runMigration({ root }), false),
      "Nothing to change: this install is up to date.",
    );
  });
});

describe(".env, as 0.9.9 read it", () => {
  /** `.env` after the migration, from `text`. */
  function migrated(text) {
    const root = makeTestTempFolder("migration-099-env");
    put(root, ".env", text);
    const said = report(runMigration({ root }), false);
    return { text: fs.readFileSync(path.join(root, ".env"), "utf8"), said };
  }

  it("writes DRY_RUN as 0.9.9 read it: on for 1, true or yes in any case", () => {
    for (const [was, now] of [
      ["1", "true"],
      ["yes", "true"],
      ["TRUE", "true"],
      ["Yes", "true"],
      ["0", "false"],
      ["no", "false"],
      ["on", "false"],
    ])
      assert.ok(
        lines(migrated(`DRY_RUN=${was}\n`).text).includes(`DRY_RUN=${now}`),
        was,
      );
  });

  it("writes VERBOSE as 0.9.9 read it: on for 1 alone", () => {
    for (const [was, now] of [
      ["1", "true"],
      ["yes", "false"],
      ["TRUE", "false"],
    ])
      assert.ok(
        lines(migrated(`VERBOSE=${was}\n`).text).includes(`VERBOSE=${now}`),
        was,
      );
  });

  it("leaves a value already true or false, or unset, as it was", () => {
    const text = "DRY_RUN=false\nVERBOSE=true\nDRY_RUN=\n";
    assert.equal(migrated(text).text, text);
  });

  it("makes a variable it reads no more a comment, and never quotes its value", () => {
    const { text, said } = migrated(ENV_099);
    assert.match(text, /^# SLIPPAGE_PCT=0\.5$/m);
    assert.ok(lines(text).includes(`# AGGREGATOR_API_KEY=${API_KEY}`), text);
    assert.match(text, /^# The operator's own note stays\.$/m);
    assert.match(text, /^CHECK_INTERVAL_SEC=300$/m);
    assert.match(said, /made AGGREGATOR_API_KEY a comment/);
    assert.ok(!said.includes(API_KEY), said);
  });

  it("keeps the file's permissions", () => {
    const root = installFrom099();
    runMigration({ root });
    assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);
  });
});
