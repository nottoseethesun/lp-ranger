/**
 * @file test/stopped-loop-starts-no-move.test.js
 * @description A bot loop that has been stopped starts no rebalance and
 * no compound, even from a poll that was already under way when the stop
 * came.
 *
 * A stop comes from shutting the server down or from Stop Managing, and
 * the app's stop for good counts too, even for a loop whose start is
 * still under way. A poll can be part way through, reading prices and
 * the pool, when the stop comes. Were it to reach its rebalance, a force-stop (Ctrl+C,
 * `npm stop`) would exit within seconds and cut the rebalance off after
 * its liquidity was removed. So the loop hands every poll `_isStopped`,
 * and a move asks it once it holds the rebalance lock: the wait for the
 * lock, behind another position's move, can span the stop.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
// Before anything that reads a price loads: prices come from a fixed table.
require("./helpers/price-stand-ins");
const { ADDR, _poll } = require("./_bot-loop-helpers");
const { executeCompound } = require("../src/lib/bot-cycle-compound");

/**
 * A rebalance lock that counts its releases, and runs `onAcquire` while
 * the caller waits for it.
 * @param {Function} [onAcquire]
 */
function countingLock(onAcquire = () => {}) {
  const lock = {
    released: 0,
    acquire: async () => {
      onAcquire();
      return () => {
        lock.released += 1;
      };
    },
    pending: () => 0,
  };
  return lock;
}

/**
 * Poll an out-of-range position, recording each transaction the signer
 * is asked to send and each time the rebalance reads who owns the NFT,
 * its first step.
 *
 * The NFT reads as someone else's, so a rebalance that starts stops at
 * that step: it sends nothing, and never reaches the success path, whose
 * price lookups would go to the price services.
 *
 * @param {object} extraDeps  Deps the loop would hand the poll.
 * @returns {Promise<{r: object, sent: object[], ownerReads: number,
 *   botState: object}>}
 */
async function pollOutOfRange(extraDeps) {
  const sent = [];
  let ownerReads = 0;
  const botState = { rebalanceOutOfRangeThresholdPercent: 0 };
  const { r } = await _poll(600, {
    botState,
    getConfig: (k) =>
      ({ slippagePct: 0.5, rebalanceOutOfRangeThresholdPercent: 0 })[k],
    setupDeps: (d) => {
      const send = d.signer.sendTransaction;
      d.signer.sendTransaction = (populated) => {
        sent.push(populated);
        return send(populated);
      };
      d.dispatch[ADDR.pm].ownerOf = async () => {
        ownerReads += 1;
        return "0x4444444444444444444444444444444444444444";
      };
    },
    extraDeps,
  });
  return { r, sent, ownerReads, botState };
}

describe("a stopped bot loop starts no rebalance", () => {
  it("starts none when the loop stopped before the poll reached it", async () => {
    const lock = countingLock();
    const { r, sent, ownerReads, botState } = await pollOutOfRange({
      _rebalanceLock: lock,
      _isStopped: () => true,
    });
    assert.equal(r.rebalanced, false);
    assert.equal(r.stopped, true);
    assert.equal(ownerReads, 0, "the rebalance may not start");
    assert.equal(sent.length, 0, "no transaction may be sent");
    assert.notEqual(botState.rebalanceInProgress, true);
    assert.equal(lock.released, 1, "the lock must be let go");
  });

  it("starts none when the stop came while it waited for the lock", async () => {
    let stopped = false;
    const lock = countingLock(() => {
      stopped = true;
    });
    const { r, sent, ownerReads } = await pollOutOfRange({
      _rebalanceLock: lock,
      _isStopped: () => stopped,
    });
    assert.equal(r.stopped, true);
    assert.equal(ownerReads, 0, "the rebalance may not start");
    assert.equal(sent.length, 0, "no transaction may be sent");
    assert.equal(lock.released, 1);
  });

  it("starts one, as before, on a loop that is running", async () => {
    const lock = countingLock();
    const { r, ownerReads } = await pollOutOfRange({
      _rebalanceLock: lock,
      _isStopped: () => false,
    });
    assert.notEqual(r.stopped, true);
    assert.equal(ownerReads, 1, "the rebalance starts with its first step");
    assert.equal(lock.released, 1);
  });
});

describe("a stopped bot loop starts no compound", () => {
  /**
   * Run a manual compound on a loop whose stop flag `isStopped` reports.
   * @param {Function} isStopped
   */
  async function compound(isStopped) {
    const emitted = [];
    const botState = { forceCompound: true };
    const lock = countingLock();
    await executeCompound(
      {
        signer: {},
        address: "0x1111111111111111111111111111111111111111",
        position: {
          tokenId: "7",
          token0: "0x2222222222222222222222222222222222222222",
          token1: "0x3333333333333333333333333333333333333333",
          fee: 3000,
        },
        updateBotState: (u) => emitted.push(u),
        _botState: botState,
        _rebalanceLock: lock,
        _getConfig: () => undefined,
        _isStopped: isStopped,
      },
      { tick: 0 },
      {},
      "manual",
    );
    return { emitted, botState, lock };
  }

  it("starts none on a stopped loop, and lets the lock go", async () => {
    const { emitted, botState, lock } = await compound(() => true);
    assert.equal(
      emitted.some((u) => u.compoundInProgress === true),
      false,
      "no compound may start",
    );
    assert.equal(
      emitted.some((u) => u.compoundError !== undefined),
      false,
      "nothing may be attempted, so nothing may fail",
    );
    assert.equal(botState.forceCompound, true, "the request is left as is");
    assert.equal(lock.released, 1);
  });

  it("starts one on a running loop", async () => {
    const { emitted } = await compound(() => false);
    assert.ok(emitted.some((u) => u.compoundInProgress === true));
  });
});

/*-
 *  The flag comes from inside `startBotLoop`, which no test here can
 *  start, so this pins that the loop hands it to every poll.
 */
describe("the bot loop's stop flag", () => {
  it("is handed to every poll, and carries the app's stop too", () => {
    /*-
     *  A loop's first poll runs while its start is under way, before
     *  anything holds the handle that stops it, so only the app's stop
     *  (src/lib/app-phase.js) can keep that poll from starting a move.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "bot-loop.js"),
      "utf8",
    );
    assert.match(src, /_isStopped: \(\) => _stopped \|\| isStopping\(\),/);
  });

  it("is set before a stop waits for the poll under way", () => {
    /*-
     *  The server's own shutdown, which `npm run gentle-stop` asks for,
     *  stops each loop and waits for it: set first, the flag keeps a
     *  poll from starting a move, and the wait lets a move already
     *  begun finish rather than be cut off.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "bot-loop.js"),
      "utf8",
    );
    const stop = src.slice(src.indexOf("    stop() {"));
    const flagged = stop.indexOf("_stopped = true;");
    const waits = stop.indexOf("if (!polling) return Promise.resolve();");
    assert.ok(flagged > -1 && waits > flagged, "the flag, then the wait");
    assert.match(
      stop,
      /if \(!polling\) \{\s*clearInterval\(check\);\s*resolve\(\);/,
    );
  });

  it("makes a second stop wait for the poll under way too", () => {
    /*-
     *  Two shutdown requests both stop every loop. Were the second stop
     *  to return at once because the loop is already stopped, the second
     *  request would close the server while the first still waited for a
     *  rebalance to finish, and the exit would cut it off.
     */
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "lib", "bot-loop.js"),
      "utf8",
    );
    const stop = src.slice(
      src.indexOf("    stop() {"),
      src.indexOf("if (!polling) return Promise.resolve();"),
    );
    assert.doesNotMatch(stop, /return/, "nothing returns before the wait");
  });
});
