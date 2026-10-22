"use strict";

/**
 * @file util/test/bookkeeping-blockchain.test.js
 * @description
 * Tests for the choice of blockchain the bookkeeping tools make before LP
 * Ranger's configuration loads (`util/bookkeeping/blockchain.js`): the
 * option's parser, reading `--blockchain` past every other argument, the
 * line a run prints when the configuration names more than one chain, and,
 * in a process of its own, the CHAIN_NAME the module sets as it loads.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const { InvalidArgumentError } = require("commander");

const { loadMergedDefaults } = require("../../src/load-merged-defaults");
const {
  CHAIN_NAMES,
  parseBlockchain,
  blockchainArgument,
  oneChainNotice,
} = require("../bookkeeping/blockchain");

const MODULE = path.resolve(__dirname, "../bookkeeping/blockchain.js");

test("the chains are those the configuration names", () => {
  assert.deepEqual(CHAIN_NAMES, Object.keys(loadMergedDefaults("chains.json")));
  assert.ok(CHAIN_NAMES.length > 0);
});

test("parseBlockchain takes a chain the configuration names, and no other", () => {
  for (const name of CHAIN_NAMES) assert.equal(parseBlockchain(name), name);
  assert.throws(() => parseBlockchain("no-such-chain"), InvalidArgumentError);
  assert.throws(
    () => parseBlockchain("no-such-chain"),
    (error) => error.message.includes(`It names ${CHAIN_NAMES.join(", ")}.`),
  );
});

test("blockchainArgument reads --blockchain past every other argument", () => {
  const name = CHAIN_NAMES[0];
  assert.equal(
    blockchainArgument([
      "--wallet",
      "0x1111111111111111111111111111111111111111",
      "--blockchain",
      name,
      "--time-zone",
      "UTC",
      "--help",
    ]),
    name,
  );
  assert.equal(blockchainArgument([`--blockchain=${name}`]), name);
  assert.equal(blockchainArgument(["--wallet", "0x11", "--help"]), undefined);
  assert.equal(blockchainArgument([]), undefined);
});

test("a run that could read another chain says it reads one, and which", () => {
  assert.equal(
    oneChainNotice("pulsechain", ["pulsechain", "pulsechain-testnet"]),
    "Only one blockchain at a time is supported: this run reads " +
      "pulsechain. Choose another with --blockchain <name> " +
      "(pulsechain, pulsechain-testnet).",
  );
  assert.equal(oneChainNotice("pulsechain", ["pulsechain"]), null);
  assert.equal(
    oneChainNotice(CHAIN_NAMES[0]),
    oneChainNotice(CHAIN_NAMES[0], CHAIN_NAMES),
  );
});

/**
 * Load the module in a process of its own, with these arguments on its
 * command line, and report the CHAIN_NAME it leaves.
 * @param {string[]} args
 * @returns {{status: number, out: string, err: string}}
 */
function loadWith(args) {
  const code =
    `require(${JSON.stringify(MODULE)});` +
    "process.stdout.write(String(process.env.CHAIN_NAME));";
  const env = { ...process.env };
  delete env.CHAIN_NAME;
  const r = spawnSync(process.execPath, ["-e", code, "x", ...args], {
    env,
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test("loading the module sets CHAIN_NAME to the --blockchain given", () => {
  const name = CHAIN_NAMES.at(-1);
  const chosen = loadWith(["--wallet", "0x11", "--blockchain", name]);
  assert.equal(chosen.status, 0);
  assert.equal(chosen.out, name);
  const none = loadWith(["--wallet", "0x11"]);
  assert.equal(none.status, 0);
  assert.equal(none.out, "undefined");
});

test("loading the module refuses a chain the configuration does not name", () => {
  const refused = loadWith(["--blockchain", "no-such-chain"]);
  assert.equal(refused.status, 1);
  assert.match(refused.err, /not a blockchain the configuration names/);
});
