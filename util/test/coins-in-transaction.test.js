"use strict";

/**
 * @file util/test/coins-in-transaction.test.js
 * @description
 * Tests for `util/bookkeeping/coins-in-transaction.js`, the tool that
 * prints what one transaction moved for a wallet: the position manager's
 * liquidity events, the fees of any drain, the wallet's coin transfers
 * and the gas paid.
 *
 * The receipts here are built from the same event declarations the tool
 * decodes, so every log is one a real receipt could hold: a drain's
 * `DecreaseLiquidity` and `Collect`, a mint's NFT `Transfer`, coin
 * `Transfer`s between the wallet and a pool. `main` is handed a provider
 * that answers from those receipts, so no test reaches the network.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { InvalidArgumentError } = require("commander");

const { captureConsole } = require("./_capture");
const CHAINS = require("../../app-config/app-defaults-for-user-configurable/chains.json");
const APP_RUNTIME = require("../../app-config/app-defaults-for-user-configurable/app-runtime.json");
const {
  EVENTS,
  parseHash,
  parseAddress,
  buildProgram,
  liquidityEvent,
  walletTransfer,
  drainFees,
  readReceipt,
  report,
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

/* ---------- building receipts ---------- */

/**
 * A log of one of the events the tool reads, as a receipt holds it.
 * @param {string} address  The contract that emitted it.
 * @param {string} name     The event's name in `EVENTS`.
 * @param {Array} values    The event's values, in order.
 * @returns {{address: string, topics: string[], data: string}}
 */
function eventLog(address, name, values) {
  const { topics, data } = EVENTS.encodeEventLog(name, values);
  return { address, topics, data };
}

/**
 * A 32-byte topic holding an address or a number.
 * @param {string|bigint} value
 * @returns {string}
 */
function topic(value) {
  const hex = typeof value === "bigint" ? ethers.toBeHex(value) : value;
  return ethers.zeroPadValue(hex, 32);
}

/**
 * The position manager's NFT `Transfer`: four topics, no data.
 * @param {string} from
 * @param {string} to
 * @param {bigint} tokenId
 * @returns {{address: string, topics: string[], data: string}}
 */
function nftTransfer(from, to, tokenId) {
  return {
    address: PM,
    topics: [
      EVENTS.getEvent("Transfer").topicHash,
      topic(from),
      topic(to),
      topic(tokenId),
    ],
    data: "0x",
  };
}

/**
 * A receipt as ethers returns one, holding `logs`.
 * @param {object[]} logs
 * @param {object} [fields]  Fields to set instead of the defaults.
 * @returns {object}
 */
function receiptOf(logs, fields = {}) {
  return {
    status: 1,
    blockNumber: 1234,
    to: PM,
    gasUsed: 200000n,
    gasPrice: 5000000000000000n,
    logs,
    ...fields,
  };
}

/** A drain of NFT #7: principal 100 and 0, collected 103 and 9. */
const DRAIN = receiptOf([
  eventLog(PM, "DecreaseLiquidity", [7n, 50n, 100n, 0n]),
  eventLog(COIN0, "Transfer", [POOL, WALLET, 103n]),
  eventLog(COIN1, "Transfer", [POOL, WALLET, 9n]),
  eventLog(PM, "Collect", [7n, WALLET, 103n, 9n]),
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

/* ---------- reading a receipt ---------- */

test("liquidityEvent reads the position manager's three events", () => {
  for (const name of ["IncreaseLiquidity", "DecreaseLiquidity"]) {
    assert.deepEqual(liquidityEvent(eventLog(PM, name, [3n, 1n, 4n, 5n])), {
      name,
      tokenId: 3n,
      amount0: 4n,
      amount1: 5n,
    });
  }
  assert.deepEqual(
    liquidityEvent(eventLog(PM, "Collect", [3n, WALLET, 6n, 7n])),
    { name: "Collect", tokenId: 3n, amount0: 6n, amount1: 7n },
  );
});

test("liquidityEvent skips the NFT's Transfer and events it does not read", () => {
  assert.equal(
    liquidityEvent(nftTransfer(ethers.ZeroAddress, WALLET, 3n)),
    null,
  );
  const approval = {
    address: PM,
    topics: [
      ethers.id("Approval(address,address,uint256)"),
      topic(WALLET),
      topic(OTHER),
      topic(3n),
    ],
    data: "0x",
  };
  assert.equal(liquidityEvent(approval), null);
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
    nftTransfer(ethers.ZeroAddress, WALLET, 3n),
    eventLog(PM, "IncreaseLiquidity", [3n, 1n, 4n, 5n]),
  ];
  for (const log of skipped) assert.equal(walletTransfer(log, WALLET), null);
});

test("drainFees is the Collect less the DecreaseLiquidity, NFT by NFT", () => {
  const fees = drainFees([
    { name: "DecreaseLiquidity", tokenId: 7n, amount0: 100n, amount1: 0n },
    { name: "Collect", tokenId: 7n, amount0: 103n, amount1: 9n },
    { name: "Collect", tokenId: 8n, amount0: 1n, amount1: 2n },
    { name: "IncreaseLiquidity", tokenId: 9n, amount0: 5n, amount1: 5n },
  ]);
  assert.deepEqual(fees, [{ tokenId: "7", fee0: 3n, fee1: 9n }]);
});

test("drainFees adds up an NFT's events when a receipt holds several", () => {
  const fees = drainFees([
    { name: "DecreaseLiquidity", tokenId: 7n, amount0: 60n, amount1: 1n },
    { name: "DecreaseLiquidity", tokenId: 7n, amount0: 40n, amount1: 1n },
    { name: "Collect", tokenId: 7n, amount0: 50n, amount1: 4n },
    { name: "Collect", tokenId: 7n, amount0: 53n, amount1: 5n },
  ]);
  assert.deepEqual(fees, [{ tokenId: "7", fee0: 3n, fee1: 7n }]);
});

test("readReceipt reads a drain: its events, its fees, its coins and its gas", () => {
  const record = readReceipt(DRAIN, {
    wallet: WALLET,
    positionManager: PM.toLowerCase(),
  });
  assert.equal(record.status, 1);
  assert.equal(record.blockNumber, 1234);
  assert.equal(record.to, PM);
  assert.equal(record.gasPaid, 200000n * 5000000000000000n);
  assert.deepEqual(
    record.liquidity.map((e) => e.name),
    ["DecreaseLiquidity", "Collect"],
  );
  assert.deepEqual(record.fees, [{ tokenId: "7", fee0: 3n, fee1: 9n }]);
  assert.deepEqual(record.transfers, [
    { coin: COIN0, direction: "in", amount: 103n },
    { coin: COIN1, direction: "in", amount: 9n },
  ]);
});

test("readReceipt reads liquidity events only from the position manager", () => {
  const record = readReceipt(
    receiptOf([
      nftTransfer(ethers.ZeroAddress, WALLET, 8n),
      eventLog(PM, "IncreaseLiquidity", [8n, 1n, 20n, 30n]),
      eventLog(OTHER, "IncreaseLiquidity", [8n, 1n, 99n, 99n]),
      eventLog(COIN0, "Transfer", [WALLET, POOL, 20n]),
      eventLog(COIN1, "Transfer", [WALLET, POOL, 30n]),
    ]),
    { wallet: WALLET, positionManager: PM },
  );
  assert.deepEqual(record.liquidity, [
    { name: "IncreaseLiquidity", tokenId: 8n, amount0: 20n, amount1: 30n },
  ]);
  assert.deepEqual(record.fees, []);
  assert.deepEqual(
    record.transfers.map((t) => [t.coin, t.direction, t.amount]),
    [
      [COIN0, "out", 20n],
      [COIN1, "out", 30n],
    ],
  );
});

/* ---------- printing ---------- */

const WHERE = { hash: HASH, chainName: CHAIN, nativeSymbol: "PLS" };

test("report prints a drain: events, fees, coins, and the gas in the chain's coin", async () => {
  const record = readReceipt(DRAIN, { wallet: WALLET, positionManager: PM });
  const { out } = await captureConsole(() => report(record, WHERE));
  assert.equal(
    out[0],
    `Transaction ${HASH} on ${CHAIN}, block 1234, sent to ${PM}`,
  );
  assert.equal(out[1], "Gas paid: 1000.0 PLS");
  assert.equal(out[2], "Status: succeeded");
  assert.ok(out.includes("  DecreaseLiquidity NFT #7: amount0 100, amount1 0"));
  assert.ok(out.includes("  Collect NFT #7: amount0 103, amount1 9"));
  assert.ok(out.includes("  Fees in NFT #7's Collect: amount0 3, amount1 9"));
  assert.ok(out.includes(`  in: 103 of coin ${COIN0}`));
  assert.ok(out.includes(`  in: 9 of coin ${COIN1}`));
  assert.equal(
    out.at(-1),
    "Divide each raw amount by 10 to the power of its coin's decimals.",
  );
});

test("report says none where a receipt moved nothing", async () => {
  const record = readReceipt(receiptOf([]), {
    wallet: WALLET,
    positionManager: PM,
  });
  const { out } = await captureConsole(() => report(record, WHERE));
  assert.equal(out.filter((line) => line === "  none").length, 2);
});

test("report prints only the gas of a reverted transaction", async () => {
  const record = readReceipt(receiptOf([], { status: 0 }), {
    wallet: WALLET,
    positionManager: PM,
  });
  const { out } = await captureConsole(() => report(record, WHERE));
  assert.deepEqual(out.slice(1), [
    "Gas paid: 1000.0 PLS",
    "Status: reverted. It moved no coins and paid only its gas.",
  ]);
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

test("main asks the chain's first endpoint for the receipt and prints it", async () => {
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
  assert.equal(
    out[1],
    `Gas paid: 1000.0 ${CHAINS[CHAIN].nativeCurrencySymbol}`,
  );
  assert.ok(out.includes("  Fees in NFT #7's Collect: amount0 3, amount1 9"));
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
    receiptOf([eventLog(OTHER, "Collect", [4n, WALLET, 1n, 2n])]),
  );
  assert.equal(made[0].endpoint, "http://127.0.0.1:8545");
  assert.equal(exitCode, 0);
  assert.ok(out.includes("  Collect NFT #4: amount0 1, amount1 2"));
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
