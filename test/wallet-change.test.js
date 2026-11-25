"use strict";

/**
 * @file test/wallet-change.test.js
 * @description The server tells every open dashboard when its wallet has
 *   been replaced by another (src/server/wallet-change.js): once a wallet
 *   follows another, every status answer carries `walletJustChanged`,
 *   naming the new one, until the next change. Set once for each change,
 *   kept across a clear, and never for letter case alone. Driven through
 *   the tracker, and through the status handler that holds it.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
const { createWalletChangeTracker } = require("../src/server/wallet-change");
const { createApiStatusHandler } = require("./_bot-route-adapters");
const { primaryRouteLabel } = require("../src/bot/rebalancer-swap");
const { moralisEnabledIn } = require("../src/lib/moralis-key");
const config = require("../src/lib/config");
const { _setSinkForTests } = require("../src/lib/log");

const A = "0xAbCdEf0000000000000000000000000000000001";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";
const changedTo = (wallet) => ({
  reloadIfOnPriorWallet: true,
  currentWallet: wallet,
});

/**
 * What a tracker reports for each wallet in turn, its log kept quiet.
 * @param {(string|null)[]} wallets
 * @returns {{reported: (object|null)[], logged: string[]}}
 */
function reportsFor(wallets) {
  const logged = [];
  const restore = _setSinkForTests({
    log: (...args) => logged.push(util.format(...args)),
  });
  try {
    const tracker = createWalletChangeTracker();
    return {
      reported: wallets.map((w) => tracker.walletJustChanged(w)),
      logged,
    };
  } finally {
    restore();
  }
}

describe("the server's wallet changes", () => {
  it("reports none while the server keeps one wallet", () => {
    const { reported } = reportsFor([A, A, null, A]);
    assert.deepEqual(reported, [null, null, null, null]);
  });

  it("takes the first wallet a server holds for no change", () => {
    const { reported } = reportsFor([null, null, B]);
    assert.deepEqual(reported, [null, null, null]);
  });

  it("names the new wallet once one replaces another, in every answer after", () => {
    const { reported } = reportsFor([A, B, B, null]);
    assert.deepEqual(reported, [
      null,
      changedTo(B),
      changedTo(B),
      changedTo(B),
    ]);
  });

  it("takes a clear followed by an import for a change", () => {
    const { reported } = reportsFor([A, null, B]);
    assert.deepEqual(reported, [null, null, changedTo(B)]);
  });

  it("takes letter case alone for no change", () => {
    const { reported } = reportsFor([A, A.toLowerCase(), A.toUpperCase()]);
    assert.deepEqual(reported, [null, null, null]);
  });

  it("names each later change, a return to an earlier wallet included", () => {
    const { reported } = reportsFor([A, B, C, A]);
    assert.deepEqual(reported, [
      null,
      changedTo(B),
      changedTo(C),
      changedTo(A),
    ]);
  });

  it("says so in the server's log, once for each change", () => {
    const { logged } = reportsFor([A, B, B, B]);
    assert.equal(logged.length, 1, logged.join("\n"));
    assert.ok(logged[0].includes(A) && logged[0].includes(B), logged[0]);
  });
});

describe("the status answer", () => {
  it("carries the change in every answer once the server's wallet is replaced", async () => {
    let held = A;
    let body = null;
    const handler = createApiStatusHandler({
      config,
      diskConfig: { global: {}, positions: {} },
      positionMgr: {
        runningCount: () => 0,
        getAll: () => [],
        getPoolDailyCounts: () => ({}),
      },
      walletManager: { getAddress: () => held },
      routeHandlers: { getPositionScanStatus: () => null },
      buildStatusPositions: () => ({}),
      buildGasStatusPayload: async () => ({}),
      actualGasCostUsd: async () => 0,
      getLpProviderDisplayName: () => "9mm v3",
      managedKeys: () => [],
      primaryRouteLabel,
      moralisEnabledIn,
      jsonResponse: (_res, _code, answer) => {
        body = answer;
      },
    });
    const restore = _setSinkForTests({ log: () => {} });
    try {
      await handler({}, {});
      assert.equal(body.global.walletJustChanged, null);
      held = B;
      await handler({}, {});
      assert.equal(body.global.walletAddress, B);
      assert.deepEqual(body.global.walletJustChanged, changedTo(B));
      await handler({}, {});
      assert.deepEqual(body.global.walletJustChanged, changedTo(B));
    } finally {
      restore();
    }
  });
});
