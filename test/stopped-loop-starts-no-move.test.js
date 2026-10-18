/**
 * @file test/stopped-loop-starts-no-move.test.js
 * @description A bot loop that has been stopped starts no rebalance and
 * no compound, even from a poll that was already under way when the stop
 * came.
 *
 * A stop comes from shutting the server down or from Stop Managing.
 * `npm run gentle-stop` asks whether a rebalance or compound is under
 * way and stops the server once none is, but a poll can be part way
 * through, reading prices and the pool, when the answer goes out. That
 * poll then reaches its rebalance, the shutdown exits within seconds,
 * and the rebalance is cut off after its liquidity was removed. So the
 * loop hands every poll `_isStopped`, and a move asks it once it holds
 * the rebalance lock: the wait for the lock, behind another position's
 * move, can span the stop.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ADDR, _poll } = require("./_bot-loop-helpers");
const { executeCompound } = require("../src/bot-cycle-compound");

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
  it("is handed to every poll", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "bot-loop.js"),
      "utf8",
    );
    assert.match(src, /_isStopped: \(\) => _stopped,/);
  });
});
