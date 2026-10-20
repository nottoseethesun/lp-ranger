"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet.test.js
 * @description
 * Tests for the wallet bookkeeping report's command line and whole run
 * (`util/bookkeeping/coins-in-transactions-on-wallet/index.js`). The run
 * reads a stand-in `app-data/` in a temp folder and a stand-in chain
 * (`_bookkeeping-chain.js`) holding one day of a wallet's moves: a
 * rebalance whose blocks also hold another position's deposit and another
 * sender's transaction, a compound with a cancel in it, coins the owner
 * added with no collect before them, a compound mined just after the
 * range, and one the chain has no receipt for. The csv it writes is read
 * back row by row. No case reads the install's own `app-data/` or reaches
 * the network.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const { captureConsole } = require("./_capture");
const {
  eventLog,
  nftLog,
  receiptOf,
  standInChain,
} = require("./_bookkeeping-chain");
const { makeTestTempFolder } = require("../../src/test-temp-folders");
const CHAINS = require("../../app-config/app-defaults-for-user-configurable/chains.json");
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

const CHAIN = "pulsechain";
const { cacheTag: CACHE_TAG, nativeCurrencySymbol: NATIVE } = CHAINS[CHAIN];
const PM = CHAINS[CHAIN].contracts.positionManager.address;
const WALLET = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const COIN0 = "0x3333333333333333333333333333333333333333";
const COIN1 = "0x4444444444444444444444444444444444444444";
const ROUTER = "0x6666666666666666666666666666666666666666";
const ELSEWHERE = "0x7777777777777777777777777777777777777777";
const STRANGER = "0x9999999999999999999999999999999999999999";
const hash = (n) => "0x" + String(n).padStart(64, "0");
const units0 = (s) => ethers.parseUnits(s, 18);
const units1 = (s) => ethers.parseUnits(s, 6);

/** Ten-second blocks; block `NOON` is mined at 2026-10-19 12:00:00 UTC. */
const BLOCK_TIME = 10;
const NOON = Date.UTC(2026, 9, 19, 12) / 1000 / BLOCK_TIME;
const at = (block) => new Date(block * BLOCK_TIME * 1000).toISOString();

const [D, A, S, X, R, Y, M, C, K, P, E, F, G] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
].map(hash);

/**
 * One transaction of the stand-in chain.
 * @param {string} txHash
 * @param {number} offset  Its block, counted from `NOON`.
 * @param {number} nonce
 * @param {string} to
 * @param {object[]} logs
 * @param {object} [extra]  Other receipt fields, or `from`.
 * @returns {object}
 */
function tx(txHash, offset, nonce, to, logs, extra = {}) {
  const from = extra.from ?? WALLET;
  return {
    hash: txHash,
    blockNumber: NOON + offset,
    from,
    nonce,
    receipt: receiptOf(logs, { to, ...extra }),
  };
}

/** The day: a rebalance of #10 into #11, then moves on #11. */
const DAY = [
  tx(D, 0, 40, PM, [
    eventLog(PM, "DecreaseLiquidity", [10n, 5n, units0("1"), 0n]),
    eventLog(COIN0, "Transfer", [POOL, WALLET, units0("1.25")]),
    eventLog(COIN1, "Transfer", [POOL, WALLET, units1("3")]),
    eventLog(PM, "Collect", [10n, WALLET, units0("1.25"), units1("3")]),
  ]),
  tx(A, 1, 41, COIN0, [
    eventLog(COIN0, "Approval", [WALLET, ROUTER, ethers.MaxUint256]),
  ]),
  tx(S, 3, 42, ROUTER, [
    eventLog(COIN0, "Transfer", [WALLET, POOL, units0("0.5")]),
    eventLog(COIN1, "Transfer", [POOL, ROUTER, units1("2")]),
    eventLog(COIN1, "Transfer", [ROUTER, WALLET, units1("2")]),
  ]),
  tx(X, 4, 43, PM, [
    eventLog(ELSEWHERE, "Transfer", [WALLET, POOL, 1n]),
    eventLog(PM, "IncreaseLiquidity", [99n, 1n, 1n, 0n]),
  ]),
  tx(R, 5, 44, ROUTER, [], { status: 0 }),
  tx(Y, 5, 7, ROUTER, [], { from: STRANGER }),
  tx(M, 10, 45, PM, [
    eventLog(COIN0, "Approval", [WALLET, PM, 1n]),
    eventLog(COIN0, "Transfer", [WALLET, POOL, units0("0.75")]),
    eventLog(COIN1, "Transfer", [WALLET, POOL, units1("5")]),
    nftLog(PM, ethers.ZeroAddress, WALLET, 11n),
    eventLog(PM, "IncreaseLiquidity", [11n, 7n, units0("0.75"), units1("5")]),
  ]),
  tx(C, 115, 46, PM, [
    eventLog(COIN0, "Transfer", [POOL, WALLET, units0("0.01")]),
    eventLog(COIN1, "Transfer", [POOL, WALLET, units1("0.02")]),
    eventLog(PM, "Collect", [11n, WALLET, units0("0.01"), units1("0.02")]),
  ]),
  tx(K, 116, 47, WALLET, []),
  tx(P, 120, 48, PM, [
    eventLog(COIN0, "Transfer", [WALLET, POOL, units0("0.01")]),
    eventLog(COIN1, "Transfer", [WALLET, POOL, units1("0.02")]),
    eventLog(PM, "IncreaseLiquidity", [
      11n,
      1n,
      units0("0.01"),
      units1("0.02"),
    ]),
  ]),
  tx(E, 200, 49, PM, [
    eventLog(COIN0, "Transfer", [WALLET, POOL, units0("1")]),
    eventLog(PM, "IncreaseLiquidity", [11n, 1n, units0("1"), 0n]),
  ]),
  tx(F, 4321, 50, PM, [
    eventLog(COIN0, "Transfer", [WALLET, POOL, 1n]),
    eventLog(PM, "IncreaseLiquidity", [11n, 1n, 1n, 0n]),
  ]),
];

/**
 * Write a file under the stand-in `app-data/`, as json.
 * @param {string} dir
 * @param {string} name
 * @param {*} data
 */
function put(dir, name, data) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

/**
 * A stand-in `app-data/` recording the day's moves: the rebalance in the
 * event cache and the log, and four deposits into #11 in its records.
 * @returns {string}  The folder.
 */
function appData() {
  const dir = makeTestTempFolder("bookkeeping-wallet");
  const short = (a) => a.slice(2, 8).toLowerCase();
  const pool = `${COIN0}-${COIN1}-2500`.toLowerCase();
  const key = `rebalance:${WALLET.toLowerCase()}:${PM.toLowerCase()}:${pool}`;
  put(
    dir,
    `scan-cache/event-cache-${CACHE_TAG}-${short(PM)}-${short(WALLET)}-33333333-44444444-2500.json`,
    {
      [key]: {
        value: {
          chainFirstTokenId: "10",
          chainFirstMintBlock: NOON - 1000,
          events: [
            {
              oldTokenId: "10",
              newTokenId: "11",
              txHash: M,
              blockNumber: NOON + 10,
              timestamp: (NOON + 10) * BLOCK_TIME,
            },
          ],
        },
      },
    },
  );
  put(dir, "rebalance_log.json", [
    {
      wallet: WALLET,
      contract: PM,
      oldTokenId: "10",
      newTokenId: "11",
      txHashes: [D, S, M],
      loggedAt: at(NOON + 11),
      token0: COIN0,
      token1: COIN1,
      decimals0: 18,
      decimals1: 6,
    },
  ]);
  const deposit = (txHash, timestamp) => ({ txHash, tokenId: "11", timestamp });
  put(dir, "position-records.json", {
    positions: {
      [`${CHAIN}-${WALLET}-${PM}-11`]: {
        compoundHistory: [
          deposit(P, at(NOON + 120)),
          deposit(E, at(NOON + 200)),
          deposit(F, "2026-10-19T23:59:30.000Z"),
          deposit(G, at(NOON + 300)),
        ],
      },
    },
  });
  put(
    dir,
    `scan-cache/lp-position-cache-${CACHE_TAG}-${short(PM)}-${short(WALLET)}.json`,
    {
      positions: [
        {
          tokenId: "11",
          token0: COIN0,
          token1: COIN1,
          token0Symbol: "AAA",
          token1Symbol: "BBB",
        },
      ],
    },
  );
  return dir;
}

/**
 * Run `main` for 2026-10-19 in UTC against the stand-in chain and
 * `app-data/`, keeping the exit status it sets out of the test process's.
 * @param {string[]} [extra]  More arguments.
 * @returns {Promise<{out: string[], err: string[], exitCode: number,
 *   dir: string, chain: object}>}
 */
async function run(extra = []) {
  const dir = appData();
  const chain = standInChain({
    wallet: WALLET,
    blockTime: BLOCK_TIME,
    txs: DAY,
  });
  const argv = [
    "--wallet",
    WALLET,
    "--start-date",
    "2026-10-19",
    "--end-date",
    "2026-10-19",
    "--time-zone",
    "UTC",
    ...extra,
  ];
  const deps = { makeProvider: () => chain, appDataDir: dir, spacingMs: 0 };
  const prior = process.exitCode;
  try {
    const { out, err } = await captureConsole(() => main(argv, deps));
    return { out, err, exitCode: process.exitCode, dir, chain };
  } finally {
    process.exitCode = prior;
  }
}

/**
 * The csv a run wrote, as rows of cells keyed by column name.
 * @param {string} file
 * @returns {Array<Object<string, string>>}
 */
function readCsv(file) {
  const [names, ...lines] = fs.readFileSync(file, "utf8").trim().split("\n");
  const columns = names.split(",");
  return lines.map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(columns.map((c, i) => [c, cells[i]]));
  });
}

test("the run writes one row per transaction of each move, in order", async () => {
  const { out, err, exitCode, dir } = await run();
  assert.equal(exitCode, 0);
  assert.deepEqual(err, []);
  const file = path.join(
    dir,
    "util",
    "bookkeeping",
    `${WALLET}_2026-10-19-to-2026-10-19_UTC_coins-in-transactions.csv`,
  );
  assert.equal(
    out.at(-1),
    `Wrote 9 transactions, from 1 rebalances, 1 compounds and 1 deposits, to ${file}`,
  );
  const rows = readCsv(file);
  assert.deepEqual(
    rows.map((r) => [r.transaction, r.move, r.nfts, r.kind, r.status]),
    [
      [D, "rebalance", "10 to 11", "drain", "succeeded"],
      [A, "rebalance", "10 to 11", "approval", "succeeded"],
      [S, "rebalance", "10 to 11", "swap", "succeeded"],
      [R, "rebalance", "10 to 11", "reverted", "reverted"],
      [M, "rebalance", "10 to 11", "mint", "succeeded"],
      [C, "compound", "11", "collect", "succeeded"],
      [K, "compound", "11", "cancel", "succeeded"],
      [P, "compound", "11", "deposit", "succeeded"],
      [E, "deposit", "11", "deposit", "succeeded"],
    ],
  );
  assert.ok(out.includes(`Compound of NFT #11: no receipt for ${G}; skipped`));
});

test("each row holds the coins in coins, the drain split, and the gas", async () => {
  const { dir } = await run();
  const [drain, approval, swap, , mint, collect] = readCsv(
    path.join(
      dir,
      "util",
      "bookkeeping",
      `${WALLET}_2026-10-19-to-2026-10-19_UTC_coins-in-transactions.csv`,
    ),
  );
  assert.equal(drain.date, "2026-10-19 12:00:00");
  assert.equal(drain.date_utc, "2026-10-19T12:00:00Z");
  assert.equal(drain.block, String(NOON));
  assert.deepEqual(
    [drain.token0, drain.token0_address, drain.token1, drain.token1_address],
    ["AAA", COIN0, "BBB", COIN1],
  );
  assert.deepEqual(
    [drain.token0_in, drain.token1_in, drain.token0_out, drain.token1_out],
    ["1.25", "3.0", "", ""],
  );
  assert.deepEqual(
    [
      drain.token0_principal,
      drain.token1_principal,
      drain.token0_fees,
      drain.token1_fees,
    ],
    ["1.0", "", "0.25", "3.0"],
  );
  assert.equal(drain[`gas_paid_${NATIVE}`], "1000.0");
  assert.equal(drain[`value_sent_${NATIVE}`], "");
  assert.equal(approval.token0_out, "");
  assert.deepEqual([swap.token0_out, swap.token1_in], ["0.5", "2.0"]);
  assert.deepEqual([mint.token0_out, mint.token1_out], ["0.75", "5.0"]);
  assert.deepEqual(
    [collect.token0_in, collect.token0_fees, collect.token1_fees],
    ["0.01", "0.01", "0.02"],
  );
});

test("the run writes the dates in the zone it is given", async () => {
  const { dir } = await run([
    "--time-zone",
    "America/Chicago",
    "--end-date",
    "2026-10-20",
  ]);
  const file = path.join(
    dir,
    "util",
    "bookkeeping",
    `${WALLET}_2026-10-19-to-2026-10-20_America-Chicago_coins-in-transactions.csv`,
  );
  const rows = readCsv(file);
  assert.equal(rows[0].date, "2026-10-19 07:00:00");
  assert.equal(rows.at(-1).transaction, F);
});

test("the run refuses a chain with no position manager", async () => {
  const noManager = Object.keys(CHAINS).find(
    (name) =>
      !name.startsWith("_") &&
      CHAINS[name].contracts.positionManager.address === "",
  );
  const { err, exitCode, chain } = await run(["--chain", noManager]);
  assert.equal(exitCode, 1);
  assert.match(err[0], /pass --position-manager <address>/);
  assert.equal(chain.asked.receipts, 0);
});

/* ---------- arguments ---------- */

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
    "Time zones:",
    "The csv:",
    "token0_principal,",
    "Which transactions:",
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
  assert.equal(opts.chain, CHAIN);
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
