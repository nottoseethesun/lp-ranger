"use strict";

/**
 * @file util/test/coins-in-transaction.test.js
 * @description
 * Tests for `util/bookkeeping/coins-in-transaction.js`, the tool that
 * reads what one transaction moved for a wallet and returns it as a json
 * object: its kind, the position manager's liquidity events and NFT
 * transfers, the fees of any drain, the wallet's coin transfers and
 * approvals, and the gas paid.
 *
 * The receipts here are built from the same event declarations the tool
 * decodes, so every log is one a real receipt could hold. `main` and
 * `coinsInTransaction` are handed a provider that answers from those
 * receipts, so no test reaches the network.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { InvalidArgumentError } = require("commander");

const { captureConsole } = require("./_capture");
const {
  eventLog,
  nftLog: nftEvent,
  receiptOf: receipt,
} = require("./_bookkeeping-chain");
const CHAINS = require("../../app-config/app-defaults-for-user-configurable/chains.json");
const APP_RUNTIME = require("../../app-config/app-defaults-for-user-configurable/app-runtime.json");
const {
  parseHash,
  parseAddress,
  buildProgram,
  liquidityEvent,
  nftTransfer,
  walletTransfer,
  walletApproval,
  drainFees,
  liquidityKind,
  walletKind,
  readReceipt,
  coinsInTransaction,
  makeProvider,
  main,
} = require("../bookkeeping/coins-in-transaction");

const CHAIN = APP_RUNTIME.defaults.chain;
const PM = CHAINS[CHAIN].contracts.positionManager.address;
const WALLET = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const COIN0 = "0x3333333333333333333333333333333333333333";
const COIN1 = "0x4444444444444444444444444444444444444444";
const OTHER = "0x5555555555555555555555555555555555555555";
const HASH = "0x" + "ab".repeat(32);
const ZERO = ethers.ZeroAddress;

/* ---------- building receipts ---------- */

/** One of the position manager's NFT events (see `_bookkeeping-chain`). */
const nftLog = (from, to, tokenId, name) =>
  nftEvent(PM, from, to, tokenId, name);

/**
 * A receipt sent from the wallet to the position manager, unless `fields`
 * says otherwise.
 * @param {object[]} logs
 * @param {object} [fields]
 * @returns {object}
 */
const receiptOf = (logs, fields = {}) =>
  receipt(logs, { hash: HASH, from: WALLET, to: PM, ...fields });

/** A drain of NFT #7: principal 100 and 0, collected 103 and 9. */
const DRAIN = receiptOf([
  eventLog(PM, "DecreaseLiquidity", [7n, 50n, 100n, 0n]),
  eventLog(COIN0, "Transfer", [POOL, WALLET, 103n]),
  eventLog(COIN1, "Transfer", [POOL, WALLET, 9n]),
  eventLog(PM, "Collect", [7n, WALLET, 103n, 9n]),
]);

/** A mint of NFT #8, whose first coin spends its allowance as it moves. */
const MINT = receiptOf([
  eventLog(COIN0, "Approval", [WALLET, PM, 5n]),
  eventLog(COIN0, "Transfer", [WALLET, POOL, 20n]),
  eventLog(COIN1, "Transfer", [WALLET, POOL, 30n]),
  nftLog(ZERO, WALLET, 8n),
  eventLog(PM, "IncreaseLiquidity", [8n, 1n, 20n, 30n]),
]);

/* ---------- arguments ---------- */

/** Parse an argument list through the tool's Commander declaration. */
function parsed(argv) {
  return buildProgram().parse(argv, { from: "user" });
}

/** A program that throws instead of exiting, and prints nothing. */
function quiet() {
  return buildProgram()
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
}

test("parseHash takes a 32-byte hash and refuses anything else", () => {
  assert.equal(parseHash(HASH), HASH);
  assert.throws(() => parseHash("0x123"), InvalidArgumentError);
  assert.throws(() => parseHash("ab".repeat(32)), /not a transaction hash/);
});

test("parseAddress checksums an address and refuses anything else", () => {
  assert.equal(parseAddress(PM.toLowerCase()), PM);
  assert.throws(() => parseAddress("0x12"), /not an address: 0x12/);
});

test("the hash and the wallet are read, and the chain defaults to the app's", () => {
  const program = parsed([HASH, "--wallet", WALLET.toLowerCase()]);
  assert.equal(program.processedArgs[0], HASH);
  assert.equal(program.opts().wallet, WALLET);
  assert.equal(program.opts().chain, CHAIN);
  assert.equal(program.opts().rpcEndpoint, undefined);
  assert.equal(program.opts().positionManager, undefined);
});

test("the command line refuses a missing wallet or a bad value", () => {
  assert.throws(() => quiet().parse([HASH], { from: "user" }), {
    code: "commander.missingMandatoryOptionValue",
  });
  for (const argv of [
    ["0x12", "--wallet", WALLET],
    [HASH, "--wallet", "0x12"],
    [HASH, "--wallet", WALLET, "--chain", "no-such-chain"],
    [HASH, "--wallet", WALLET, "--rpc-endpoint", "ftp://example.com"],
    [HASH, "--wallet", WALLET, "--position-manager", "0x12"],
  ]) {
    assert.throws(() => quiet().parse(argv, { from: "user" }), {
      code: "commander.invalidArgument",
    });
  }
});

/* ---------- reading logs ---------- */

test("liquidityEvent reads the position manager's three events", () => {
  for (const name of ["IncreaseLiquidity", "DecreaseLiquidity"]) {
    assert.deepEqual(liquidityEvent(eventLog(PM, name, [3n, 1n, 4n, 5n])), {
      event: name,
      nftId: 3n,
      amount0: 4n,
      amount1: 5n,
    });
  }
  assert.deepEqual(
    liquidityEvent(eventLog(PM, "Collect", [3n, WALLET, 6n, 7n])),
    { event: "Collect", nftId: 3n, amount0: 6n, amount1: 7n },
  );
});

test("liquidityEvent skips NFT transfers and NFT approvals", () => {
  assert.equal(liquidityEvent(nftLog(ZERO, WALLET, 3n)), null);
  assert.equal(liquidityEvent(nftLog(WALLET, OTHER, 3n, "Approval")), null);
});

test("nftTransfer reads a mint and a burn, and nothing else", () => {
  assert.deepEqual(nftTransfer(nftLog(ZERO, WALLET, 9n)), {
    nftId: 9n,
    from: ZERO,
    to: WALLET,
  });
  assert.equal(nftTransfer(nftLog(WALLET, ZERO, 9n)).to, ZERO);
  assert.equal(nftTransfer(nftLog(WALLET, OTHER, 9n, "Approval")), null);
  assert.equal(
    nftTransfer(eventLog(COIN0, "Transfer", [WALLET, POOL, 1n])),
    null,
  );
});

test("walletTransfer keeps the coins the wallet sent and received", () => {
  assert.deepEqual(
    walletTransfer(eventLog(COIN0, "Transfer", [WALLET, POOL, 11n]), WALLET),
    { coin: COIN0, direction: "out", amount: 11n },
  );
  assert.deepEqual(
    walletTransfer(
      eventLog(COIN1.toLowerCase(), "Transfer", [POOL, WALLET, 12n]),
      WALLET.toLowerCase(),
    ),
    { coin: COIN1, direction: "in", amount: 12n },
  );
});

test("walletTransfer skips others' transfers, the wallet's to itself, and NFTs", () => {
  const skipped = [
    eventLog(COIN0, "Transfer", [POOL, OTHER, 13n]),
    eventLog(COIN0, "Transfer", [WALLET, WALLET, 14n]),
    nftLog(ZERO, WALLET, 3n),
    eventLog(PM, "IncreaseLiquidity", [3n, 1n, 4n, 5n]),
  ];
  for (const log of skipped) assert.equal(walletTransfer(log, WALLET), null);
});

test("walletApproval keeps the wallet's own allowances, and nothing else", () => {
  assert.deepEqual(
    walletApproval(eventLog(COIN0, "Approval", [WALLET, OTHER, 15n]), WALLET),
    { coin: COIN0, spender: OTHER, amount: 15n },
  );
  const skipped = [
    eventLog(COIN0, "Approval", [OTHER, WALLET, 16n]),
    nftLog(WALLET, OTHER, 3n, "Approval"),
    eventLog(COIN0, "Transfer", [WALLET, OTHER, 17n]),
  ];
  for (const log of skipped) assert.equal(walletApproval(log, WALLET), null);
});

/* ---------- fees and kinds ---------- */

test("drainFees is the Collect less the DecreaseLiquidity, NFT by NFT", () => {
  const fees = drainFees([
    { event: "DecreaseLiquidity", nftId: 7n, amount0: 60n, amount1: 0n },
    { event: "DecreaseLiquidity", nftId: 7n, amount0: 40n, amount1: 0n },
    { event: "Collect", nftId: 7n, amount0: 103n, amount1: 9n },
    { event: "Collect", nftId: 8n, amount0: 1n, amount1: 2n },
    { event: "IncreaseLiquidity", nftId: 9n, amount0: 5n, amount1: 5n },
  ]);
  assert.deepEqual(fees, [{ nftId: 7n, amount0: 3n, amount1: 9n }]);
});

test("liquidityKind names what the position manager did", () => {
  const e = (event) => ({ event });
  const minted = [{ from: ZERO, to: WALLET }];
  const burned = [{ from: WALLET, to: ZERO }];
  const cases = [
    [[e("DecreaseLiquidity"), e("Collect")], [], "drain"],
    [[e("DecreaseLiquidity"), e("Collect")], burned, "drain"],
    [[e("IncreaseLiquidity")], minted, "mint"],
    [[e("IncreaseLiquidity")], [], "deposit"],
    [[e("Collect")], [], "collect"],
    [[e("DecreaseLiquidity")], [], "decrease"],
    [[], burned, "burn"],
    [[], [], null],
  ];
  for (const [liquidity, nfts, kind] of cases)
    assert.equal(liquidityKind(liquidity, nfts), kind);
});

test("walletKind names what any other transaction did to the wallet", () => {
  const out = { direction: "out" };
  const into = { direction: "in" };
  const base = { from: WALLET, to: OTHER, transfers: [], approvals: [] };
  const cases = [
    [{ ...base, to: WALLET.toLowerCase() }, "cancel"],
    [{ ...base, transfers: [out, into] }, "swap"],
    [{ ...base, transfers: [out] }, "transfer out"],
    [{ ...base, transfers: [into] }, "transfer in"],
    [{ ...base, approvals: [{}] }, "approval"],
    [base, "other"],
    [{ ...base, to: null }, "other"],
  ];
  for (const [parts, kind] of cases) assert.equal(walletKind(parts), kind);
});

/* ---------- the record ---------- */

test("readReceipt reads a drain as json: strings throughout, fees and all", () => {
  const record = readReceipt(DRAIN, {
    wallet: WALLET,
    positionManager: PM.toLowerCase(),
  });
  assert.deepEqual(record, {
    hash: HASH,
    blockNumber: 1234,
    from: WALLET,
    to: PM,
    status: "succeeded",
    kind: "drain",
    gasPaid: "1000000000000000000000",
    liquidity: [
      {
        event: "DecreaseLiquidity",
        nftId: "7",
        amount0: "100",
        amount1: "0",
      },
      { event: "Collect", nftId: "7", amount0: "103", amount1: "9" },
    ],
    nftTransfers: [],
    fees: [{ nftId: "7", amount0: "3", amount1: "9" }],
    transfers: [
      { coin: COIN0, direction: "in", amount: "103" },
      { coin: COIN1, direction: "in", amount: "9" },
    ],
    approvals: [],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test("readReceipt reads a mint, whose allowance spend leaves it a mint", () => {
  const record = readReceipt(MINT, { wallet: WALLET, positionManager: PM });
  assert.equal(record.kind, "mint");
  assert.deepEqual(record.nftTransfers, [
    { nftId: "8", from: ZERO, to: WALLET },
  ]);
  assert.deepEqual(record.approvals, [
    { coin: COIN0, spender: PM, amount: "5" },
  ]);
  assert.deepEqual(
    record.transfers.map((t) => [t.coin, t.direction, t.amount]),
    [
      [COIN0, "out", "20"],
      [COIN1, "out", "30"],
    ],
  );
});

test("readReceipt reads liquidity events only from the position manager", () => {
  const record = readReceipt(
    receiptOf([eventLog(OTHER, "IncreaseLiquidity", [8n, 1n, 9n, 9n])]),
    { wallet: WALLET, positionManager: PM },
  );
  assert.deepEqual(record.liquidity, []);
  assert.equal(record.kind, "other");
});

test("readReceipt names approvals, cancels and reverted tries", () => {
  const who = { wallet: WALLET, positionManager: PM };
  const approval = readReceipt(
    receiptOf([eventLog(COIN0, "Approval", [WALLET, OTHER, 1n])], {
      to: COIN0,
    }),
    who,
  );
  assert.equal(approval.kind, "approval");
  assert.equal(readReceipt(receiptOf([], { to: WALLET }), who).kind, "cancel");
  const reverted = readReceipt(receiptOf([], { status: 0, to: OTHER }), who);
  assert.equal(reverted.kind, "reverted");
  assert.equal(reverted.status, "reverted");
  assert.equal(reverted.gasPaid, "1000000000000000000000");
});

test("readReceipt reads a burn, which clears the NFT's approval as it goes", () => {
  const record = readReceipt(
    receiptOf([nftLog(WALLET, ZERO, 9n, "Approval"), nftLog(WALLET, ZERO, 9n)]),
    { wallet: WALLET, positionManager: PM },
  );
  assert.equal(record.kind, "burn");
  assert.deepEqual(record.liquidity, []);
  assert.deepEqual(record.nftTransfers, [
    { nftId: "9", from: WALLET, to: ZERO },
  ]);
});

test("coinsInTransaction asks for the receipt, and says null without one", async () => {
  const asked = [];
  const provider = {
    async getTransactionReceipt(hash) {
      asked.push(hash);
      return hash === HASH ? DRAIN : null;
    },
  };
  const who = { wallet: WALLET, positionManager: PM };
  const record = await coinsInTransaction(provider, { hash: HASH, ...who });
  assert.equal(record.kind, "drain");
  const other = "0x" + "cd".repeat(32);
  assert.equal(
    await coinsInTransaction(provider, { hash: other, ...who }),
    null,
  );
  assert.deepEqual(asked, [HASH, other]);
});

/* ---------- the whole run ---------- */

/**
 * Run `main` with a provider that answers from `receipt`, keeping the
 * exit status it sets out of the test process's own.
 * @param {string[]} argv
 * @param {object|null} receipt  What the provider answers.
 * @returns {Promise<{out: string[], err: string[], exitCode: number, made: object[]}>}
 */
async function run(argv, receipt) {
  const made = [];
  const standIn = (endpoint, chainId) => {
    made.push({ endpoint, chainId });
    return {
      async getTransactionReceipt(hash) {
        made.at(-1).hash = hash;
        return receipt;
      },
    };
  };
  const prior = process.exitCode;
  try {
    const { out, err } = await captureConsole(() =>
      main(argv, { makeProvider: standIn }),
    );
    return { out, err, exitCode: process.exitCode, made };
  } finally {
    process.exitCode = prior;
  }
}

test("main asks the chain's first endpoint and prints the record as json", async () => {
  const { out, err, exitCode, made } = await run(
    [HASH, "--wallet", WALLET],
    DRAIN,
  );
  assert.deepEqual(made, [
    {
      endpoint: CHAINS[CHAIN].rpc.urls[0],
      chainId: CHAINS[CHAIN].chainId,
      hash: HASH,
    },
  ]);
  assert.equal(exitCode, 0);
  assert.deepEqual(err, []);
  const printed = JSON.parse(out.join("\n"));
  assert.equal(printed.kind, "drain");
  assert.deepEqual(printed.fees, [{ nftId: "7", amount0: "3", amount1: "9" }]);
});

test("main asks the endpoint and position manager the options name", async () => {
  const { out, exitCode, made } = await run(
    [
      HASH,
      "--wallet",
      WALLET,
      "--rpc-endpoint",
      "http://127.0.0.1:8545",
      "--position-manager",
      OTHER,
    ],
    receiptOf([eventLog(OTHER, "Collect", [4n, WALLET, 1n, 2n])], {
      to: OTHER,
    }),
  );
  assert.equal(made[0].endpoint, "http://127.0.0.1:8545");
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(out.join("\n")).kind, "collect");
});

test("main says so, and exits 1, when there is no receipt", async () => {
  const { out, err, exitCode } = await run([HASH, "--wallet", WALLET], null);
  assert.equal(exitCode, 1);
  assert.deepEqual(out, []);
  assert.match(err[0], /^No receipt for 0xabab/);
  assert.match(err[0], /not mined yet, or not on/);
});

test("main refuses a chain with no position manager unless one is named", async () => {
  const noManager = Object.keys(CHAINS).find(
    (name) =>
      !name.startsWith("_") &&
      CHAINS[name].contracts.positionManager.address === "",
  );
  assert.ok(noManager, "chains.json has a chain with no position manager");
  const refused = await run(
    [HASH, "--wallet", WALLET, "--chain", noManager],
    DRAIN,
  );
  assert.equal(refused.exitCode, 1);
  assert.deepEqual(refused.made, []);
  assert.match(refused.err[0], /pass --position-manager <address>/);
  const named = await run(
    [HASH, "--wallet", WALLET, "--chain", noManager, "--position-manager", PM],
    DRAIN,
  );
  assert.equal(named.exitCode, 0);
  assert.equal(named.made[0].chainId, CHAINS[noManager].chainId);
});

test("makeProvider knows its chain without asking the endpoint", async () => {
  const provider = makeProvider("http://127.0.0.1:9", 369);
  try {
    assert.ok(provider instanceof ethers.JsonRpcProvider);
    const network = await provider.getNetwork();
    assert.equal(network.chainId, 369n);
  } finally {
    provider.destroy();
  }
});
