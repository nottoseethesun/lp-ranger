/**
 * @file test/rpc-429-backoff.test.js
 * @description
 * A 429 is waited out, not failed over.
 *
 * It says this process is sending too fast; the endpoint is up and
 * answering. Moving would carry the same request rate to the next
 * endpoint and collect its refusal too, walk the list, and reach the
 * all-endpoints-down hold — the one failure where moving makes things
 * worse rather than better.
 *
 * The wait is per endpoint and shared: a schedule that lived on the
 * refused request alone would restart at its first delay for every
 * caller, so under a sustained refusal each one would rediscover the
 * limit from scratch.
 *
 * The schedule is injected rather than the clock being patched, so
 * these cases neither wait ten seconds nor touch a JS global.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const botProvider = require("../src/bot-provider");
const rpcQueue = require("../src/rpc-request-manager");
const { readBotConfigDefaults } = require("../src/bot-config-defaults");

const URL_A = "http://limited.test";

/** An ethers-shaped 429, matching what a refused request carries. */
function refusal() {
  return Object.assign(new Error("429 Too Many Requests"), {
    code: "SERVER_ERROR",
    info: { responseStatus: "429 Too Many Requests" },
  });
}

/**
 * A provider double carrying only what the pacing patch needs, whose
 * `send` refuses the first `refuseCount` calls.
 */
function fakeProvider(refuseCount) {
  const calls = [];
  return {
    calls,
    send: async (method) => {
      calls.push(method);
      if (calls.length <= refuseCount) throw refusal();
      return "ok";
    },
  };
}

describe("an RPC 429 is waited out", () => {
  beforeEach(() => {
    botProvider._reset429ForTests();
    rpcQueue._resetForTests();
    /*- A schedule short enough to run, long enough to keep its three
     *  steps distinguishable from the pacer's own gap. */
    botProvider._setDelaysForTests([2, 4, 8]);
  });
  afterEach(() => {
    botProvider._reset429ForTests();
    rpcQueue._resetForTests();
  });

  it("ships a retry schedule and a penalty ceiling as config", () => {
    const d = readBotConfigDefaults();
    assert.deepEqual(d.rpcRetryOn429DelaysMs, [10_000, 30_000, 60_000]);
    assert.equal(d.rpcMax429PenaltyMs, 120_000);
  });

  it("retries the refused request rather than throwing", async () => {
    const p = fakeProvider(1);
    botProvider._patchRequestPacing(p, URL_A);

    assert.equal(await p.send("eth_call", []), "ok");
    assert.deepEqual(
      p.calls,
      ["eth_call", "eth_call"],
      "refused once, retried",
    );
  });

  it("gives up once the schedule is spent, and throws the 429", async () => {
    /*- Waiting is not the same as waiting forever.  A refusal that
     *  outlasts the schedule is the caller's to handle. */
    const p = fakeProvider(99);
    botProvider._patchRequestPacing(p, URL_A);

    await assert.rejects(() => p.send("eth_call", []), /429/);
    assert.equal(p.calls.length, 4, "the first attempt plus three retries");
  });

  it("leaves a deadline that later requests to that endpoint wait out", async () => {
    /*- The reason this state is per endpoint rather than per request: a
     *  second caller pays the penalty the first one earned.  Asserted
     *  against the deadline rather than against elapsed time, so it
     *  cannot flake and cannot be satisfied by the pacer's own gap. */
    const refuser = fakeProvider(99);
    botProvider._patchRequestPacing(refuser, URL_A);
    await assert.rejects(() => refuser.send("eth_call", []));

    const deadline = botProvider._penaltyUntilMs(URL_A);
    assert.ok(deadline > Date.now(), "a penalty stands after the refusals");

    const healthy = fakeProvider(0);
    botProvider._patchRequestPacing(healthy, URL_A);
    await healthy.send("eth_blockNumber", []);
    assert.ok(
      Date.now() >= deadline,
      "a different caller to the same endpoint waited the deadline out",
    );
  });

  it("clears the endpoint's penalty once it answers", async () => {
    /*- A success is the endpoint saying it has stopped refusing, which
     *  is the only direct evidence available.  Holding the cool-down
     *  past that makes every later call wait out a limit already
     *  lifted. */
    const p = fakeProvider(1);
    botProvider._patchRequestPacing(p, URL_A);

    await p.send("eth_call", []);
    assert.equal(botProvider._penaltyUntilMs(URL_A), 0);
  });

  it("escalates the penalty while refusals continue", async () => {
    /*- Doubling per consecutive refusal is what makes the process as a
     *  whole back off, rather than each caller rediscovering the limit
     *  at the first delay. */
    const p = fakeProvider(99);
    botProvider._patchRequestPacing(p, URL_A);

    await assert.rejects(() => p.send("eth_call", []));
    const afterThree = botProvider._penaltyUntilMs(URL_A) - Date.now();
    assert.ok(
      afterThree > 8,
      `three refusals outlast one delay: ${afterThree}`,
    );
  });

  it("leaves errors that are not a 429 alone", async () => {
    /*- A 502 is the endpoint being broken, which the failover decider
     *  handles.  Retrying it here would delay that and hide it. */
    const p = {
      send: async () => {
        throw Object.assign(new Error("502 Bad Gateway"), {
          info: { responseStatus: "502 Bad Gateway" },
        });
      },
    };
    botProvider._patchRequestPacing(p, URL_A);
    await assert.rejects(() => p.send("eth_call", []), /502/);
  });
});
