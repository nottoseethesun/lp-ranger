/**
 * @file util/test/migration-from-0.9.10-deposit-lists.test.js
 * @description Tests for the migration step that takes out each deposit
 *   list 0.9.10 built in a way this release does not, with the Total
 *   Lifetime Deposit priced from it
 *   (util/migration/from-0.9.10/drop-old-deposit-lists.js).
 *
 *   0.9.10 built such a list two ways. It summed the deposits each
 *   rebalance's mint took in into one entry at the mint's block, so they
 *   were priced at the mint's day, which leaves the total of those
 *   deposits the list keeps beside it larger than its entries naming a
 *   transaction. And it filed an addition of liquidity to a position NFT
 *   as money put in once the NFT's additions passed its fees, at the
 *   NFT's mint block with nothing to mark it, so a compound whose swap
 *   took in the wallet's coins counted them a second time; such a list
 *   adds up to more than its first mint plus that total. The step removes
 *   either kind's two copies, and the saved Total Lifetime Deposit of each
 *   position the pool's saved rebalance history names, so the first start
 *   builds the list again and prices it. A list holding only its first
 *   mint stays.
 *
 *   Each case's install is in a temp folder of its own, with a copy of
 *   the chains file this release ships, so no operator file is in reach.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeTestTempFolder } = require("../../src/lib/test-temp-folders");
const { runMigration, report } = require("../migration");
const {
  dropOldDepositLists,
  countsCoinsTwice,
  sumsDepositsAtAMint,
} = require("../migration/from-0.9.10/drop-old-deposit-lists");

const CHAINS = "app-config/app-defaults-for-user-configurable/chains.json";
const CACHE = "app-data/scan-cache/pnl-epochs-cache.json";
const SYMBOLS = "app-data/scan-cache/token-symbol-cache.json";
const RECORDS = "app-data/position-records.json";

const PM = "0xcc05bf158202b4f461ede8843d76dcd7bbad07f2";
const WALLET = "0x4e44847675763d5540b32bee8a713cfdcb4be61a";
const PLSX = "0x95b303987a60c71504d99aa1b13b4da07b0790ab";
const WPLS = "0xa1077a294dde1b09bb078844df40758a5d0f9a27";
const GOLD = "0xd826a77a9473c159b7b486903acff1a8357b6251";

/** A pool's key in the epoch cache. */
const poolKey = (chain, t0, t1, fee) =>
  `${chain}.${PM}.${WALLET}.${t0}.${t1}.${fee}`;

/** The PulseX/WPLS pool, whose list 0.9.10 built otherwise in these cases. */
const OLD = poolKey("pulsechain", PLSX, WPLS, 2500);
/** The WPLS/Gold Pieces pool, whose list holds only its first mint. */
const RIGHT = poolKey("pulsechain", WPLS, GOLD, 20000);

/** The step's words for each kind of list it removes. */
const TWICE =
  "counted coins the wallet paid with as money put in a second time";
const SUMMED =
  "priced the deposits each rebalance took in at that rebalance's day";

/** A position's key in the records, as the app writes it. */
const positionKey = (chain, tokenId) =>
  `${chain}-0x4E44847675763D5540B32Bee8a713CfDcb4bE61A-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-${tokenId}`;

/** A deposit entry, its coins in their smallest units. */
const entry = (block, raw0, raw1, extra = {}) => ({
  raw0: String(raw0),
  raw1: String(raw1),
  block,
  ...extra,
});

/**
 * A pool's deposit list as 0.9.10 saved it: the first mint at block 10,
 * a rebalance's deposits summed into one entry at its mint block, 500,
 * and, when `addition` is given, an addition filed at the mint block of
 * the NFT it was made to.
 */
function list0910(addition) {
  const deposits = [entry(10, 100, 200), entry(500, 0, 300)];
  if (addition !== undefined) deposits.push(addition);
  return { raw0: "0", raw1: "300", lastBlock: 500, deposits };
}

/** A list as 0.9.10 saved it for a pool whose mints took in no deposit. */
const firstMintOnly = () => ({
  raw0: "0",
  raw1: "0",
  lastBlock: 0,
  deposits: [entry(10, 100, 200)],
});

/** A list whose only addition 0.9.10 filed at the first mint's block. */
const additionOnly = () => ({
  raw0: "0",
  raw1: "0",
  lastBlock: 0,
  deposits: [entry(10, 100, 200), entry(10, 3, 3)],
});

/** A pool's entry: both copies of its list and its per-day P&L history. */
const poolEntry = (list) => ({
  lifetimeHodlAmounts: { ...list, amount0: 1, amount1: 2 },
  freshDeposits: list,
  closedEpochs: [{ entryValue: 5 }],
  liveEpoch: { entryValue: 6 },
  cachedAt: 1234,
});

/** The file holding the PulseX/WPLS pool's saved rebalance history. */
const HISTORY =
  "app-data/scan-cache/event-cache-pulse-cc05bf-4e4484-95b30398-a1077a29-2500.json";

/** A saved rebalance history: #100 rebalanced into #101. */
const history = () => ({
  [`rebalance:${WALLET}:${PM}:${PLSX}-${WPLS}-2500`]: {
    value: {
      events: [{ oldTokenId: "100", newTokenId: "101", blockNumber: 500 }],
      firstMintTokenId: "100",
      chainFirstTokenId: "100",
    },
    expiresAt: 0,
  },
});

/** A position's records with a saved Total Lifetime Deposit. */
const recordWith = (usd) => ({
  totalLifetimeDepositUsd: usd,
  depositUsedFallback: false,
  compoundHistory: [{ txHash: "0xc", trigger: "auto" }],
});

/**
 * An install for the step: the chains file this release ships, and each
 * file `files` gives, by its path in the install.
 */
function installWith(files) {
  const root = makeTestTempFolder("migration-deposit-lists");
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(
    CHAINS,
    fs.readFileSync(path.join(__dirname, "..", "..", CHAINS), "utf8"),
  );
  for (const [rel, value] of Object.entries(files))
    write(
      rel,
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
  return root;
}

/** An install whose PulseX/WPLS pool holds `list`, its history saved. */
function installHolding(list) {
  return installWith({
    [CACHE]: { [OLD]: poolEntry(list) },
    [HISTORY]: history(),
    [RECORDS]: {
      positions: { [positionKey("pulsechain", "101")]: recordWith(50) },
    },
  });
}

/**
 * The install of the main cases: one pool whose list 0.9.10 built
 * otherwise, both ways, and one whose list holds only its first mint.
 */
function mainInstall({ symbols = false } = {}) {
  const files = {
    [CACHE]: {
      [OLD]: poolEntry(list0910(entry(500, 7, 9))),
      [RIGHT]: poolEntry(firstMintOnly()),
    },
    [HISTORY]: history(),
    [RECORDS]: {
      positions: {
        [positionKey("pulsechain", "101")]: recordWith(50),
        [positionKey("pulsechain", "164743")]: recordWith(21),
      },
    },
  };
  if (symbols)
    files[SYMBOLS] = {
      [`pulsechain-${PLSX}`]: "PulseX",
      [`pulsechain-${WPLS}`]: "Wrapped Pulse",
    };
  return installWith(files);
}

/** A file of the install, parsed. */
const read = (root, rel) =>
  JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));

/** A list as this release builds it, each deposit naming its transaction. */
const thisRelease = () => ({
  raw0: "20",
  raw1: "300",
  lastBlock: 500,
  deposits: [
    entry(10, 100, 200, { kind: "fresh" }),
    entry(450, 0, 300, { kind: "fresh", txHash: "0xs" }),
    entry(600, 20, 0, { kind: "fresh", txHash: "0xc" }),
    entry(650, 9, 9, { kind: "external", txHash: "0xa" }),
  ],
});

describe("a deposit list that counts coins twice", () => {
  it("is one adding up to more than its first mint and its rebalances' deposits", () => {
    assert.equal(countsCoinsTwice(list0910(entry(500, 7, 9))), true);
    assert.equal(countsCoinsTwice(list0910()), false);
  });

  it("is found when the addition was filed at the first NFT's own mint block", () => {
    /*- 0.9.10 filed it after the mint's own deposit, at the same block. */
    assert.equal(countsCoinsTwice(list0910(entry(10, 3, 3))), true);
  });
});

describe("a deposit list that sums a rebalance's deposits at its mint", () => {
  it("is one whose rebalances' deposits total more than its entries naming a transaction", () => {
    assert.equal(sumsDepositsAtAMint(list0910()), true);
    assert.equal(sumsDepositsAtAMint(firstMintOnly()), false);
    assert.equal(sumsDepositsAtAMint(additionOnly()), false);
  });

  it("is found when the summed entry is tagged, as an earlier build of this release tagged it", () => {
    const list = {
      raw0: "0",
      raw1: "300",
      lastBlock: 500,
      deposits: [
        entry(10, 100, 200, { kind: "fresh" }),
        entry(500, 0, 300, { kind: "fresh" }),
      ],
    };
    assert.equal(sumsDepositsAtAMint(list), true);
  });

  it("is found in such a list this release has since added to", () => {
    /*- An addition another wallet paid for names its transaction but is
     *  no part of the rebalances' deposits, so it cannot make up for the
     *  summed entry. */
    const list = list0910();
    list.deposits.push(entry(650, 9, 400, { kind: "external", txHash: "0xa" }));
    assert.equal(sumsDepositsAtAMint(list), true);
  });

  it("is not one whose total the deposit count's entries make up", () => {
    const list = {
      raw0: "20",
      raw1: "0",
      lastBlock: 0,
      deposits: [
        entry(10, 100, 200),
        entry(600, 20, 0, { kind: "fresh", txHash: "0xc" }),
      ],
    };
    assert.equal(sumsDepositsAtAMint(list), false);
  });
});

describe("a deposit list this release built", () => {
  it("is neither, with the deposit count's entries and an addition another wallet paid for", () => {
    /*- This release enters each deposit a rebalance's mint took in at its
     *  own block, naming its transaction, as the deposit count does. */
    assert.equal(countsCoinsTwice(thisRelease()), false);
    assert.equal(sumsDepositsAtAMint(thisRelease()), false);
  });

  it("stays, as a list holding only its first mint does", () => {
    const root = installWith({
      [CACHE]: {
        [OLD]: poolEntry(thisRelease()),
        [RIGHT]: poolEntry(firstMintOnly()),
      },
      [HISTORY]: history(),
    });
    assert.deepEqual(dropOldDepositLists({ root, dryRun: false }), []);
  });
});

describe("the migration step for deposit lists", () => {
  it("removes such a list and its position's saved Total Lifetime Deposit, and nothing else", () => {
    const root = mainInstall({ symbols: true });
    const lines = dropOldDepositLists({ root, dryRun: false });
    const cache = read(root, CACHE);
    assert.equal(cache[OLD].lifetimeHodlAmounts, undefined);
    assert.equal(cache[OLD].freshDeposits, undefined);
    assert.deepEqual(cache[OLD].closedEpochs, [{ entryValue: 5 }]);
    assert.deepEqual(cache[OLD].liveEpoch, { entryValue: 6 });
    assert.equal(cache[OLD].cachedAt, 1234);
    assert.deepEqual(cache[RIGHT], poolEntry(firstMintOnly()));
    const { positions } = read(root, RECORDS);
    const moved = positions[positionKey("pulsechain", "101")];
    assert.equal(moved.totalLifetimeDepositUsd, undefined);
    assert.equal(moved.depositUsedFallback, undefined);
    assert.deepEqual(moved.compoundHistory, [
      { txHash: "0xc", trigger: "auto" },
    ]);
    assert.deepEqual(
      positions[positionKey("pulsechain", "164743")],
      recordWith(21),
    );
    assert.match(
      lines[0],
      /removed the deposit list of PulseX\/Wrapped Pulse, fee 0\.25%, wallet 0x4e44…e61a/,
    );
    assert.match(lines[1], /saved Total Lifetime Deposit of NFT #101/);
  });

  it("says each thing a list holds that this release would not build", () => {
    const [both] = dropOldDepositLists({ root: mainInstall(), dryRun: true });
    assert.ok(
      both.includes(`, which ${TWICE} and ${SUMMED}; the first start builds`),
      both,
    );
    const [summed] = dropOldDepositLists({
      root: installHolding(list0910()),
      dryRun: true,
    });
    assert.ok(summed.includes(`, which ${SUMMED}; the first start`), summed);
    const [twice] = dropOldDepositLists({
      root: installHolding(additionOnly()),
      dryRun: true,
    });
    assert.ok(twice.includes(`, which ${TWICE}; the first start`), twice);
  });

  it("removes a list that summed a rebalance's deposits, though it adds up", () => {
    const root = installHolding(list0910());
    const lines = dropOldDepositLists({ root, dryRun: false });
    assert.equal(read(root, CACHE)[OLD].lifetimeHodlAmounts, undefined);
    assert.equal(
      read(root, RECORDS).positions[positionKey("pulsechain", "101")]
        .totalLifetimeDepositUsd,
      undefined,
    );
    assert.match(lines[1], /saved Total Lifetime Deposit of NFT #101/);
  });

  it("names a pool's coins by address when the token-symbol cache does not have them", () => {
    const [line] = dropOldDepositLists({
      root: mainInstall(),
      dryRun: false,
    });
    assert.match(line, /0x95b303…\/0xa1077a…, fee 0\.25%/);
  });

  it("leaves a list whose positions no saved rebalance history names, saying so", () => {
    const root = installWith({
      [CACHE]: { [OLD]: poolEntry(list0910(entry(500, 7, 9))) },
      [RECORDS]: {
        positions: { [positionKey("pulsechain", "101")]: recordWith(50) },
      },
    });
    const [line] = dropOldDepositLists({ root, dryRun: false });
    assert.ok(line.includes(`${TWICE} and ${SUMMED}, but no saved`), line);
    assert.match(line, /left as it was; click Reload Current Position/);
    assert.deepEqual(
      read(root, CACHE)[OLD],
      poolEntry(list0910(entry(500, 7, 9))),
    );
    assert.equal(
      read(root, RECORDS).positions[positionKey("pulsechain", "101")]
        .totalLifetimeDepositUsd,
      50,
    );
  });

  it("reads past a saved rebalance history that is not JSON, leaving its pool's list", () => {
    const root = installWith({
      [CACHE]: { [OLD]: poolEntry(list0910(entry(500, 7, 9))) },
      [HISTORY]: "{ not json",
    });
    const [line] = dropOldDepositLists({ root, dryRun: false });
    assert.match(line, /no saved rebalance history names its position/);
  });

  it("matches a history to its own chain only", () => {
    /*- The testnet's tag begins as the main chain's does. */
    const root = installWith({
      [CACHE]: { [OLD]: poolEntry(list0910(entry(500, 7, 9))) },
      "app-data/scan-cache/event-cache-pulsetest-cc05bf-4e4484-95b30398-a1077a29-2500.json":
        history(),
    });
    const [line] = dropOldDepositLists({ root, dryRun: false });
    assert.match(line, /no saved rebalance history names its position/);
  });

  it("keeps a copy of each file it changes in tmp/", () => {
    const root = mainInstall();
    const before = {
      cache: fs.readFileSync(path.join(root, CACHE), "utf8"),
      records: fs.readFileSync(path.join(root, RECORDS), "utf8"),
    };
    const lines = dropOldDepositLists({ root, dryRun: false });
    const kept = (name) =>
      lines.find((l) => l.includes(`old ${name}`)).match(/tmp\/(\S+)$/)[1];
    assert.equal(
      fs.readFileSync(
        path.join(root, "tmp", kept("pnl-epochs-cache.json")),
        "utf8",
      ),
      before.cache,
    );
    assert.equal(
      fs.readFileSync(
        path.join(root, "tmp", kept("position-records.json")),
        "utf8",
      ),
      before.records,
    );
  });

  it("changes nothing on a dry run, and nothing more when run again", () => {
    const root = mainInstall();
    const before = { cache: read(root, CACHE), records: read(root, RECORDS) };
    const dry = dropOldDepositLists({ root, dryRun: true });
    assert.match(dry[0], /would remove the deposit list/);
    assert.match(dry[1], /would remove the saved Total Lifetime Deposit/);
    assert.deepEqual(read(root, CACHE), before.cache);
    assert.deepEqual(read(root, RECORDS), before.records);
    dropOldDepositLists({ root, dryRun: false });
    const once = { cache: read(root, CACHE), records: read(root, RECORDS) };
    assert.deepEqual(dropOldDepositLists({ root, dryRun: false }), []);
    assert.deepEqual(read(root, CACHE), once.cache);
    assert.deepEqual(read(root, RECORDS), once.records);
  });

  it("does nothing without the cache, and leaves one that is not JSON as it was", () => {
    const bare = makeTestTempFolder("migration-deposit-lists");
    assert.deepEqual(dropOldDepositLists({ root: bare, dryRun: false }), []);
    const root = installWith({ [CACHE]: "{ not json" });
    const [line] = dropOldDepositLists({ root, dryRun: false });
    assert.match(line, /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(root, CACHE), "utf8"), "{ not json");
  });

  it("runs as one of the migration's steps", () => {
    const out = report(
      runMigration({ root: mainInstall(), dryRun: true }),
      true,
    );
    assert.match(
      out,
      /A deposit list that priced each rebalance's deposits at that rebalance's day, or counted coins the wallet paid with as money put in a second time, comes out, with the Total Lifetime Deposit priced from it/,
    );
  });
});
