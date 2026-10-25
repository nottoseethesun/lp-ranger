"use strict";

/**
 * @file test/server-scan-full-scan-cache.test.js
 * @description A full wallet scan saves what it found under the position
 *   manager it scanned.
 *
 *   `POST /api/positions/scan` may name a position manager other than the
 *   configured one. Saved under the configured contract instead, the other
 *   contract's positions would be where the configured one's are looked
 *   up, and the next scan of the configured contract would answer with
 *   them. test/server-scan-contract-cache.test.js pins the cache a scan
 *   reads; this pins the one a full scan writes.
 *
 *   The chain's answer is the position detector's, stubbed in the module
 *   cache; the token names go unanswered, which the scan survives. The
 *   position cache and the symbol cache are the test's own, in temporary
 *   directories, so the install's are never touched.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "scan-full-cache-"));
process.env.TOKEN_SYMBOL_CACHE_PATH = path.join(SCRATCH, "symbols.json");

const DETECTOR = require.resolve("../src/lib/position-detector");
const OTHER_PM = "0x" + "c".repeat(40);
const WALLET = "0x" + "d".repeat(39) + "1";
const HEAD = 500;
const FOUND = {
  tokenId: "7",
  token0: "0x" + "a".repeat(40),
  token1: "0x" + "b".repeat(40),
  // No fee, so the scan reads no pool's tick: there is no chain here.
  fee: 0,
  liquidity: "5",
  tickLower: 0,
  tickUpper: 10,
};

require.cache[DETECTOR] = {
  id: DETECTOR,
  filename: DETECTOR,
  loaded: true,
  exports: {
    detectPositionType: async () => ({
      type: "nft",
      nftPositions: [FOUND],
      erc20Positions: [],
    }),
    refreshLpPositionLiquidity: async () => {},
  },
};

const config = require("../src/lib/config");
const sendTx = require("../src/lib/send-transaction");
const { createScanHandlers } = require("../src/lib/server-scan");
const { loadLpPositionCache } = require("../src/lib/lp-position-cache");

const scope = (contract) => ({ blockchain: config.CHAIN_NAME, contract });

describe("a full wallet scan of another position manager", () => {
  const realProvider = sendTx.getManagedReadProvider;
  const realCwd = process.cwd();

  /*-
   *  The position cache lives in the scan-cache folder, which under
   *  `node --test` is the test process's own (src/lib/scan-cache-dir.js); the
   *  case runs in the scratch directory too.
   */
  before(() => {
    process.chdir(SCRATCH);
    sendTx.getManagedReadProvider = () => ({
      getBlockNumber: async () => HEAD,
    });
  });

  after(() => {
    sendTx.getManagedReadProvider = realProvider;
    process.chdir(realCwd);
    delete require.cache[DETECTOR];
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });

  it("saves the positions under that contract, not the configured one", async () => {
    const sent = {};
    const handlers = createScanHandlers({
      walletManager: { getStatus: () => ({ loaded: true, address: WALLET }) },
      jsonResponse: (_res, status, body) =>
        Object.assign(sent, { status, body }),
      readJsonBody: async () => ({
        positionManagerAddress: OTHER_PM,
        force: true,
      }),
      setGlobalScanStatus: () => {},
      getAllPositionBotStates: () => ({}),
      positionMgr: { getAll: () => [] },
    });
    await handlers._handlePositionsScan({}, {});
    assert.equal(sent.status, 200);
    assert.equal(sent.body.cached, false, "a full scan ran");
    const saved = loadLpPositionCache(WALLET, scope(OTHER_PM));
    assert.deepEqual(
      saved?.positions.map((p) => p.tokenId),
      [FOUND.tokenId],
      "saved under the scanned contract",
    );
    assert.equal(saved.lastBlock, HEAD);
    assert.equal(
      loadLpPositionCache(WALLET, scope(config.POSITION_MANAGER)),
      null,
      "nothing was written under the configured contract",
    );
  });
});
