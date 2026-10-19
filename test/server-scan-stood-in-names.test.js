"use strict";

/**
 * @file test/server-scan-stood-in-names.test.js
 * @description When the chain does not answer a token's name, a wallet
 *   scan saves the token under its shortened address, and before this a
 *   scan served from the saved list showed that address as the token's
 *   name until a full rescan. Now a scan served from the saved list gives
 *   each such token one read of its name, through the same reader a full
 *   scan uses, and a name that comes back replaces the address, in the
 *   answer and in the saved list. The user, 2026-10-18: "if the token's
 *   user-friendly name matches its c.a. (do a case-insensitive match),
 *   then attempt one single read of the user-friendly name with no extra
 *   effort given to re-try".
 *
 *   The reader asks the token for `name()`, and for `symbol()` only when
 *   that fails, so "one read" is one pass of the reader: each question
 *   asked at most once.
 *
 *   The cases drive the real handler against a saved list. The endpoint
 *   gateway is stubbed with a head block no newer than the list, so the
 *   activity check has no window to read, and with a contract call that
 *   answers, or refuses, every question a token is asked.
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

/*-
 *  A name this file reads is a fixture. It goes to a symbol cache of this
 *  file's own, not the operator's, which nothing expires. Set before
 *  src/server-scan.js loads src/token-symbol-cache.js, which reads it
 *  once.
 */
const SYMBOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stood-in-sym-"));
process.env.TOKEN_SYMBOL_CACHE_PATH = path.join(
  SYMBOL_DIR,
  "token-symbol-cache.json",
);

const config = require("../src/config");
const sendTx = require("../src/send-transaction");
const { createScanHandlers } = require("../src/server-scan");
const {
  saveLpPositionCache,
  loadLpPositionCache,
} = require("../src/lp-position-cache");

const WALLET = "0x" + "d".repeat(39) + "1";
const TOKEN0 = "0x1234567890abcdef1234567890abcdef12345678";
const TOKEN1 = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const STAND_IN = "0x1234…5678";
const HEAD = 500;
const SCOPE = {
  blockchain: config.CHAIN_NAME,
  contract: config.POSITION_MANAGER,
};
const QUESTION = { "0x06fdde03": "name", "0x95d89b41": "symbol" };

describe("a token saved under its address", () => {
  const realProvider = sendTx.getManagedReadProvider;
  const realCwd = process.cwd();
  let scratch;
  let asked;
  let answer;

  /*-
   *  The saved list lives under the working directory's `tmp/`, so the
   *  cases run in a scratch directory of their own and the install's
   *  caches are never touched.
   */
  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scan-stood-in-"));
    process.chdir(scratch);
    sendTx.getManagedReadProvider = () => ({
      getBlockNumber: async () => HEAD,
      call: async (tx) => {
        asked.push(QUESTION[tx.data.slice(0, 10)] + " " + tx.to);
        if (answer === null) throw new Error("execution reverted");
        return ethers.AbiCoder.defaultAbiCoder().encode(["string"], [answer]);
      },
    });
  });

  after(() => {
    sendTx.getManagedReadProvider = realProvider;
    process.chdir(realCwd);
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(SYMBOL_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    asked = [];
    answer = "Aardvark";
  });

  /** Save one position whose token0 is named `name0`, then scan. */
  async function scanWith(name0) {
    saveLpPositionCache(
      WALLET,
      [
        {
          tokenId: "7",
          token0: TOKEN0,
          token1: TOKEN1,
          token0Symbol: name0,
          token1Symbol: "Bee",
        },
      ],
      HEAD,
      SCOPE,
    );
    const sent = {};
    await createScanHandlers({
      walletManager: { getStatus: () => ({ loaded: true, address: WALLET }) },
      jsonResponse: (_res, status, body) =>
        Object.assign(sent, { status, body }),
      readJsonBody: async () => ({}),
      setGlobalScanStatus: () => {},
      getAllPositionBotStates: () => ({}),
      positionMgr: { getAll: () => [] },
    })._handlePositionsScan({}, {});
    assert.equal(sent.status, 200);
    assert.equal(sent.body.cached, true, "served from the saved list");
    return sent.body.nftPositions[0];
  }

  it("reads the name once, and keeps it in the answer and the saved list", async () => {
    const pos = await scanWith(STAND_IN);
    assert.equal(pos.token0Symbol, "Aardvark");
    assert.equal(pos.token1Symbol, "Bee", "a real name is left alone");
    assert.deepEqual(asked, ["name " + TOKEN0]);
    const saved = loadLpPositionCache(WALLET, SCOPE).positions[0];
    assert.equal(saved.token0Symbol, "Aardvark");
  });

  it("matches the whole address in any case", async () => {
    const pos = await scanWith("0x" + TOKEN0.slice(2).toUpperCase());
    assert.equal(pos.token0Symbol, "Aardvark");
    assert.deepEqual(asked, ["name " + TOKEN0]);
  });

  it("asks each question once and no more when the chain does not answer", async () => {
    answer = null;
    const pos = await scanWith(STAND_IN);
    assert.equal(pos.token0Symbol, STAND_IN, "the address stays");
    assert.deepEqual(asked, ["name " + TOKEN0, "symbol " + TOKEN0]);
    const saved = loadLpPositionCache(WALLET, SCOPE).positions[0];
    assert.equal(saved.token0Symbol, STAND_IN);
  });

  it("reads nothing when every saved name is a real one", async () => {
    const pos = await scanWith("Ant");
    assert.equal(pos.token0Symbol, "Ant");
    assert.deepEqual(asked, []);
  });
});
