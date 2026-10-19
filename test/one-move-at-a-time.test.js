"use strict";

/**
 * @file test/one-move-at-a-time.test.js
 * @description Only one position moves at a time. Every managed
 *   position's bot loop is given the same lock (`attachMultiPosDeps`,
 *   src/server-positions.js, for the server and the headless bot alike),
 *   and the loop hands it to each poll. A rebalance or a compound holds
 *   it from its first transaction until its last confirms, so a second
 *   position's move waits rather than starting while the first one's
 *   transactions are still unconfirmed on the same wallet.
 *
 *   The loop itself has no test fixture, so its hand-off is pinned by
 *   the line that makes it, as its stop flag is
 *   (test/stopped-loop-starts-no-move.test.js). The wait is shown with
 *   two positions' compounds run through the real compound code and the
 *   real lock.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");
const { executeCompound } = require("../src/bot-cycle-compound");
const { createRebalanceLock } = require("../src/rebalance-lock");

/**
 * Run a manual compound of one position, recording what it reports.
 *
 * @param {string} tokenId  The position's NFT.
 * @param {object} lock     The lock its loop was handed.
 * @param {object} signer   Its signer; the compound asks it for the
 *   wallet's address once it holds the lock.
 * @param {object[]} reports  Each report, tagged with the NFT.
 * @returns {Promise<void>}
 */
function compound(tokenId, lock, signer, reports) {
  return executeCompound(
    {
      signer,
      address: "0x1111111111111111111111111111111111111111",
      position: {
        tokenId,
        token0: "0x2222222222222222222222222222222222222222",
        token1: "0x3333333333333333333333333333333333333333",
        fee: 3000,
      },
      updateBotState: (u) => reports.push({ tokenId, ...u }),
      _botState: { forceCompound: true },
      _rebalanceLock: lock,
      _getConfig: () => undefined,
      _isStopped: () => false,
    },
    { tick: 0 },
    {},
    "manual",
  );
}

/** Let every pending promise and callback run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("one position moves at a time", () => {
  it("the bot loop hands every poll the lock its position was given", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "bot-loop.js"),
      "utf8",
    );
    assert.match(src, /_rebalanceLock: botState\._rebalanceLock \?\? null,/);
  });

  it("a second position's compound starts only once the first's has finished", async () => {
    const lock = createRebalanceLock();
    const reports = [];
    let endFirst;
    // The first compound waits here, holding the lock, until let go.
    const firstHolds = new Promise((_resolve, reject) => {
      endFirst = reject;
    });
    const first = compound(
      "1",
      lock,
      { getAddress: () => firstHolds },
      reports,
    );
    const second = compound(
      "2",
      lock,
      {
        getAddress: async () => {
          throw new Error("a stand-in signer");
        },
      },
      reports,
    );
    await settle();
    await settle();
    const moving = () =>
      reports
        .filter((r) => r.compoundInProgress !== undefined)
        .map((r) => `#${r.tokenId} ${r.compoundInProgress ? "on" : "off"}`);
    assert.deepEqual(moving(), ["#1 on"], "the second has not started");
    assert.equal(lock.pending(), 1, "the second waits for the lock");

    endFirst(new Error("the first position's move ends"));
    await Promise.all([first, second]);
    assert.deepEqual(moving(), ["#1 on", "#1 off", "#2 on", "#2 off"]);
    assert.equal(lock.pending(), 0);
  });
});
