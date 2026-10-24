"use strict";

/**
 * @file test/server-scan-contract-cache.test.js
 * @description A wallet scan reads and writes the position cache of the
 *   contract it scans.
 *
 *   `POST /api/positions/scan` may name a position manager other than the
 *   configured one, and the cache it reads and writes must be the scanned
 *   contract's, as the chain reads are. Named after the configured
 *   contract instead, one contract's positions would be saved where the
 *   other's are looked up, and handed back as the other's on the next
 *   scan.
 *
 *   Drives the real handler against a cache already written for the named
 *   contract: a scan that finds it answers from it, without a full scan.
 *   The endpoint gateway is stubbed to report a head block no newer than
 *   the cache, so the activity check has no window to read.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../src/lib/config");
const sendTx = require("../src/lib/send-transaction");
const { createScanHandlers } = require("../src/lib/server-scan");
const {
  saveLpPositionCache,
  loadLpPositionCache,
} = require("../src/lib/lp-position-cache");

const OTHER_PM = "0x" + "c".repeat(40);
const WALLET = "0x" + "d".repeat(39) + "1";
const HEAD = 500;

const scope = (contract) => ({ blockchain: config.CHAIN_NAME, contract });

describe("a wallet scan that names another position manager", () => {
  const realProvider = sendTx.getManagedReadProvider;
  const realCwd = process.cwd();
  let scratch;

  /*-
   *  The position cache lives in the scan-cache folder, which under
   *  `node --test` is the test process's own (src/lib/scan-cache-dir.js), so
   *  the install's caches are never touched; the case runs in a scratch
   *  directory too. Config is read from beside the code, so moving the
   *  working directory does not move it.
   */
  before(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scan-contract-cache-"));
    process.chdir(scratch);
    saveLpPositionCache(WALLET, [], HEAD, scope(OTHER_PM));
    sendTx.getManagedReadProvider = () => ({
      getBlockNumber: async () => HEAD,
    });
  });

  after(() => {
    sendTx.getManagedReadProvider = realProvider;
    process.chdir(realCwd);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("answers from that contract's cache, and leaves the configured one's alone", async () => {
    const sent = {};
    const handlers = createScanHandlers({
      walletManager: { getStatus: () => ({ loaded: true, address: WALLET }) },
      jsonResponse: (_res, status, body) =>
        Object.assign(sent, { status, body }),
      readJsonBody: async () => ({ positionManagerAddress: OTHER_PM }),
      setGlobalScanStatus: () => {},
      getAllPositionBotStates: () => ({}),
      positionMgr: { getAll: () => [] },
    });
    await handlers._handlePositionsScan({}, {});
    assert.equal(sent.status, 200);
    assert.equal(sent.body.cached, true, "the named contract's cache answered");
    assert.equal(sent.body.positionManagerAddress, OTHER_PM);
    assert.equal(
      loadLpPositionCache(WALLET, scope(config.POSITION_MANAGER)),
      null,
      "nothing was written under the configured contract",
    );
  });
});
