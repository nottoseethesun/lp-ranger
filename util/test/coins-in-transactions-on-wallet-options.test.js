"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet-options.test.js
 * @description
 * Tests for how the wallet bookkeeping report reads its command line
 * (`util/bookkeeping/coins-in-transactions-on-wallet/index.js`): the
 * refusals of a missing or bad option, `--list-valid-timezones` on its
 * own, the whole `--help`, and the csv's name. The runs themselves are in
 * coins-in-transactions-on-wallet.test.js.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { captureConsole } = require("./_capture");
const { makeTestTempFolder } = require("../../src/lib/test-temp-folders");
const {
  buildProgram,
  readOptions,
  reportPath,
  main,
} = require("../bookkeeping/coins-in-transactions-on-wallet");
const {
  validTimeZones,
  isValidTimeZone,
} = require("../bookkeeping/coins-in-transactions-on-wallet/dates");

const WALLET = "0x1111111111111111111111111111111111111111";

/**
 * A program that throws instead of exiting, and keeps what it prints to
 * stdout and to stderr.
 */
function quiet() {
  const printed = [];
  const shown = [];
  const program = buildProgram()
    .exitOverride()
    .configureOutput({
      writeErr: (s) => printed.push(s),
      writeOut: (s) => shown.push(s),
    });
  return { program, printed, shown };
}

const ARGS = [
  "--wallet",
  WALLET,
  "--start-date",
  "2026-10-19",
  "--end-date",
  "2026-10-19",
];

test("a missing time zone is refused, offering the computer's own", () => {
  const { program, printed } = quiet();
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.throws(() => readOptions(ARGS, program), { exitCode: 1 });
  const message = printed.join("");
  assert.match(message, /required option '--time-zone <zone>' not specified/);
  assert.match(message, /Run with --list-valid-timezones/);
  assert.equal(
    message.includes(`pass --time-zone ${local}.`),
    isValidTimeZone(local),
  );
});

test("a designation or an unknown zone is refused, pointing to the list", () => {
  for (const zone of ["CDT", "EST", "Mars/Olympus"]) {
    const { program, printed } = quiet();
    const argv = [...ARGS, "--time-zone", zone];
    assert.throws(() => readOptions(argv, program), { exitCode: 1 });
    assert.match(
      printed.join(""),
      /not a valid time zone: .*--list-valid-timezones/,
    );
  }
});

test("each required option is refused by name when it is missing", () => {
  for (const [i, flags] of [
    [0, "--wallet <address>"],
    [2, "--start-date <YYYY-MM-DD>"],
    [4, "--end-date <YYYY-MM-DD>"],
  ]) {
    const { program, printed } = quiet();
    const argv = [
      ...ARGS.slice(0, i),
      ...ARGS.slice(i + 2),
      "--time-zone",
      "UTC",
    ];
    assert.throws(() => readOptions(argv, program), { exitCode: 1 });
    assert.equal(
      printed.join(""),
      `error: required option '${flags}' not specified\n`,
    );
  }
});

test("a blockchain the configuration does not name is refused", () => {
  const { program, printed } = quiet();
  const argv = [...ARGS, "--time-zone", "UTC", "--blockchain", "no-such"];
  assert.throws(() => readOptions(argv, program), { exitCode: 1 });
  assert.match(printed.join(""), /not a blockchain the configuration names/);
});

test("--list-valid-timezones needs no other option", () => {
  const opts = readOptions(["--list-valid-timezones"], quiet().program);
  assert.equal(opts.listValidTimezones, true);
});

test("--list-valid-timezones prints every valid zone, one a line, and writes nothing", async () => {
  const dir = makeTestTempFolder("bookkeeping-wallet");
  const prior = process.exitCode;
  try {
    const { out, err } = await captureConsole(() =>
      main(["--list-valid-timezones"], { appDataDir: dir }),
    );
    assert.equal(process.exitCode, 0);
    assert.deepEqual(err, []);
    assert.deepEqual(out.join("\n").split("\n"), validTimeZones());
  } finally {
    process.exitCode = prior;
  }
  assert.equal(fs.existsSync(path.join(dir, "util")), false);
});

test("--help names --list-valid-timezones and gives the whole reference", () => {
  const { program, shown } = quiet();
  assert.throws(() => program.parse(["--help"], { from: "user" }), {
    code: "commander.helpDisplayed",
    exitCode: 0,
  });
  const help = shown.join("");
  for (const part of [
    "--list-valid-timezones",
    "--blockchain <name>",
    "Time zones:",
    "Blockchain and configuration:",
    "The csv:",
    "token0_principal,",
    "gas_paid_usd",
    "Prices:",
    "Which transactions:",
    "What stops a run:",
    "Example:",
    "Exit status:",
  ]) {
    assert.ok(help.includes(part), part);
  }
});

test("a range that ends before it starts is refused", () => {
  const { program, printed } = quiet();
  const argv = [
    ...ARGS.slice(0, 3),
    "2026-10-20",
    "--end-date",
    "2026-10-19",
    "--time-zone",
    "UTC",
  ];
  assert.throws(() => readOptions(argv, program), { exitCode: 1 });
  assert.match(
    printed.join(""),
    /--start-date 2026-10-20 is after --end-date 2026-10-19/,
  );
});

test("the options are read, the time zone's as the list spells it", () => {
  const opts = readOptions(
    [...ARGS, "--time-zone", "asia/tokyo"],
    quiet().program,
  );
  assert.equal(opts.wallet, WALLET);
  assert.equal(opts.timeZone, "Asia/Tokyo");
  assert.equal(opts.blockchain, undefined);
});

test("reportPath names the csv for the wallet, the dates and the zone", () => {
  const file = reportPath("/data", {
    wallet: WALLET,
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    timeZone: "America/Los_Angeles",
  });
  assert.equal(
    file,
    path.join(
      "/data",
      "util",
      "bookkeeping",
      `${WALLET}_2026-10-01-to-2026-10-31_America-Los_Angeles_coins-in-transactions.csv`,
    ),
  );
});
