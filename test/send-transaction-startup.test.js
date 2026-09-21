"use strict";

/**
 * @file test/send-transaction-startup.test.js
 * @description What `ensureReachable()` tells the operator, and what it
 *   does not do.
 *
 * The probe walks the configured endpoints once at startup and commits
 * to the first that answers. When none does it throws the last
 * endpoint's error, and the caller logs that error with a stack — which
 * names a single endpoint and reads like a crash rather than like "this
 * machine cannot reach the chain". The summary line covered here says
 * the latter, in one sentence, before the stack arrives.
 *
 * It also pins the boundary between startup and the all-endpoints-down
 * wait. They are separate by construction: the wait belongs to
 * `failoverToNextRPC`, which the probe does not call. Nothing is held at
 * startup, so a failed one can be retried as soon as the connection is
 * back rather than sitting out an hour first.
 *
 * Companion to `send-transaction-read-failover.test.js`, which covers
 * the probe's success paths. Split so neither exceeds the 500-line cap.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/send-transaction");
const rpcQueue = require("../src/rpc-request-manager");
const { PRI, FALL, makeLib, muteConsole } = require("./helpers/send-tx-stubs");

/** Both endpoints refuse to answer the boot probe. */
function bothDown() {
  return makeLib({
    [PRI]: {
      getBlockNumber: async () => {
        throw new Error("primary down");
      },
    },
    [FALL]: {
      getBlockNumber: async () => {
        throw new Error("fallback also down");
      },
    },
  });
}

describe("send-transaction: what startup says when nothing answers", () => {
  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });
  afterEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  it("says plainly, once, that no endpoint answered", async () => {
    sendTx.init({ urls: [PRI, FALL] }, bothDown());
    const m = muteConsole();
    try {
      await assert.rejects(() => sendTx.ensureReachable());
    } finally {
      m.restore();
    }
    const summary = m.out.error
      .map((a) => String(a[0] ?? ""))
      .filter((s) => s.includes("STARTUP: no RPC endpoint answered"));
    assert.equal(summary.length, 1, "exactly one summary line");
    assert.ok(
      summary[0].includes("tried all 2"),
      `it must say how many were tried, got: ${summary[0]}`,
    );
    assert.ok(
      summary[0].includes(FALL),
      `it must name the endpoint it gave up on, got: ${summary[0]}`,
    );
  });

  it("numbers each probe so the walk reads as a sequence", async () => {
    sendTx.init({ urls: [PRI, FALL] }, bothDown());
    const m = muteConsole();
    try {
      await assert.rejects(() => sendTx.ensureReachable());
    } finally {
      m.restore();
    }
    const numbered = m.out.warn
      .map((a) => String(a[0] ?? ""))
      .filter((s) => s.includes("RPC unreachable at startup"));
    assert.equal(numbered.length, 2, "one numbered line per endpoint");
    assert.ok(numbered[0].includes("(1 of 2)"), numbered[0]);
    assert.ok(numbered[1].includes("(2 of 2)"), numbered[1]);
  });

  it("does not engage the outage wait", async () => {
    /*- The probe walks the list itself and commits only on success, so
     *  it never reaches `failoverToNextRPC` and never starts the wait.
     *  That is what lets an operator retry the moment the connection is
     *  back rather than sitting out an hour first. */
    sendTx.init({ urls: [PRI, FALL] }, bothDown());
    const m = muteConsole();
    try {
      await assert.rejects(() => sendTx.ensureReachable());
    } finally {
      m.restore();
    }
    assert.equal(
      rpcQueue.haltRemainingMs(),
      0,
      "a failed startup must not hold the queue",
    );
  });

  it("still throws the last endpoint's error for the caller", async () => {
    /*- The summary line is additional, not a replacement: the caller
     *  decides what a failed start means, and needs the error to do it. */
    sendTx.init({ urls: [PRI, FALL] }, bothDown());
    const m = muteConsole();
    try {
      await assert.rejects(
        () => sendTx.ensureReachable(),
        /fallback also down/,
      );
    } finally {
      m.restore();
    }
  });
});
