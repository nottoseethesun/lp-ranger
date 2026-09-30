/**
 * @file test/rpc-read-retry-pacing.test.js
 * @description
 * Every turn of the read-retry loop must be a real request to a real
 * endpoint.
 *
 * `src/rpc-read-retry.js` carries no backoff of its own and says why:
 * every provider is built by `bot-provider.buildProvider`, which puts
 * each call through the process-wide queue in
 * `src/rpc-request-manager.js`, so attempts are already spaced and the
 * loop cannot spin. That claim holds only while every attempt reaches
 * the wire, because the queue is entered inside the patched `send()`.
 *
 * ethers' own request cache broke it. `AbstractProvider` holds each
 * request's promise briefly and hands the same one back to an identical
 * request arriving inside that window — and a REJECTED promise is
 * cached like any other. The retry loop retries with identical
 * arguments, so a failed read was answered from memory, instantly, for
 * as long as the entry lived.
 *
 * Two things followed. The loop spun, unpaced, because a cached answer
 * never reaches `send()`. And every turn reported another failure to
 * `src/rpc-out-of-service.js`, so one refusal by one endpoint was
 * counted hundreds of times and what decides failover became the loop's
 * iteration count rather than the endpoint's failure rate. Production
 * 2026-09-30 logged 678 numbered retries against one endpoint inside a
 * single second, from one refusal.
 *
 * `buildProvider` now passes `cacheTimeout: -1`.
 *
 * A real socket rather than a stub provider, for the reason the sibling
 * file `rpc-outage-no-unpaced-detection.test.js` gives — the behaviour
 * lives in the seam between ethers' internals and the pacing wrapper,
 * and a stub has no such seam.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const rpcQueue = require("../src/rpc-request-manager");
const sendTx = require("../src/send-transaction");
const outOfService = require("../src/rpc-out-of-service");
const logModule = require("../src/log");

/** PulseChain, matching chains.json, so no provider disputes the network. */
const CHAIN_ID_HEX = "0x171";

/**
 * How long to leave the endpoint refusing before counting.
 *
 * Long enough for a paced loop to get several attempts through — at
 * 222 ms this window allows about nine — and short enough to keep the
 * suite quick. The two outcomes are orders of magnitude apart, so the
 * exact length does not matter.
 */
const WATCH_MS = 2_000;

/**
 * Successful reads to bank before the endpoint starts failing.
 *
 * Not decoration. Selection moves on a failure RATE over a window, so
 * how long a dead endpoint is retried is set by how much it had
 * recently been serving. An endpoint that had been idle is abandoned
 * after a handful of failures and the loop never runs long enough to
 * show whether it is paced; Production reached 678 because a chunked
 * scan had just banked that many successes.
 */
const BANKED_SUCCESSES = 12;

/** Arrival times at the failing endpoint, in epoch ms. */
let arrivals = [];
/** `read retry #N` lines the loop emitted while the endpoint was dead. */
let retryLines = [];
let server = null;
let dead = false;
let restoreLog = null;

/**
 * A node whose `/dead` path answers 502 once the module's `dead` flag is
 * raised, and whose other paths always answer normally — the
 * single-endpoint outage the retry loop exists to ride out.
 * @returns {import('node:http').Server} Not yet listening.
 */
function buildStubNode() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = {};
      }
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      if (req.url === "/dead" && dead) {
        arrivals.push(Date.now());
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("error code: 502\n");
        return;
      }
      const replies = batch.map((one) => ({
        jsonrpc: "2.0",
        id: one.id,
        result:
          one.method === "eth_chainId"
            ? CHAIN_ID_HEX
            : one.method === "eth_blockNumber"
              ? "0x1234"
              : [],
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
}

/**
 * Start the node on an operating-system-chosen port, so parallel test
 * files never collide.
 * @param {import('node:http').Server} srv  The node to start.
 * @returns {Promise<string>}  Its base URL.
 */
function listen(srv) {
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${srv.address().port}`),
    );
  });
}

/** Yield for `ms`, letting the queue's timers and the retry loop run. */
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe("every read retry is a real, paced request", () => {
  before(async () => {
    rpcQueue._resetForTests();
    outOfService._resetForTests();
    arrivals = [];
    retryLines = [];
    server = buildStubNode();
    const base = await listen(server);
    /*- One endpoint that will die and two live ones. The live pair
     *  matter: with somewhere to go, the loop ends by succeeding rather
     *  than by running out of list, which is the ordinary case and the
     *  one Production was in. */
    sendTx.init({
      urls: [`${base}/dead`, `${base}/live-a`, `${base}/live-b`],
    });

    const provider = sendTx.getManagedReadProvider();
    /*- Bank the successes, the way a chunked scan does, so the endpoint
     *  has a denominator when it starts refusing. */
    for (let i = 0; i < BANKED_SUCCESSES; i++) {
      await provider.getLogs({ fromBlock: i, toBlock: i + 1 });
    }

    /*- Captured through the log module's sink rather than by patching
     *  the global console (see [[feedback_no_global_monkey_patch]]).
     *  Installed only for the dead phase, so the banking phase's own
     *  output is not counted. */
    restoreLog = logModule._setSinkForTests({
      warn: (first) => {
        if (typeof first === "string" && first.includes("read retry #")) {
          retryLines.push(first);
        }
      },
      log: () => {},
      error: () => {},
    });

    dead = true;
    /*- Not awaited. It resolves once failover reaches a live endpoint,
     *  and the claim under test is about what happens on the way there,
     *  which the counters record either way. */
    provider.getLogs({ fromBlock: 0, toBlock: 1 }).catch(() => {});
    await tick(WATCH_MS);
  });

  after(async () => {
    /*- Let the endpoint answer again BEFORE anything is torn down. The
     *  retry loop is deliberately unbounded — it exists to outlast an
     *  outage — so it ends only when some endpoint serves the read.
     *  Closing the socket under it instead would leave it retrying a
     *  dead port for as long as the process lived, and the suite would
     *  never exit. */
    dead = false;
    await tick(500);
    if (restoreLog) restoreLog();
    if (server) server.close();
    rpcQueue._resetForTests();
    outOfService._resetForTests();
  });

  it("does not count a retry that never left the process", () => {
    assert.ok(arrivals.length > 0, "the dead endpoint was never called");
    /*- The heart of it. Before `cacheTimeout: -1` this ran twelve
     *  retries against a single request, and on Production 678 — each
     *  one reported to the out-of-service decider as though the
     *  endpoint had refused again. */
    assert.ok(
      retryLines.length <= arrivals.length + 1,
      `${retryLines.length} retries logged but only ${arrivals.length} requests ` +
        `reached the endpoint — the extra ones were answered from ethers' cache ` +
        `and still counted as failures`,
    );
  });

  it("leaves the pacing interval between attempts", () => {
    const interval = rpcQueue.getIntervalMs();
    assert.ok(
      interval > 0,
      "this test is meaningless with pacing disabled; interval was " + interval,
    );
    assert.ok(
      arrivals.length >= 3,
      `only ${arrivals.length} attempts reached the endpoint in ${WATCH_MS}ms; ` +
        "too few to show a rate",
    );
    /*- The median rather than the minimum: the queue releases the first
     *  request immediately when it has been idle, and one fast pair
     *  after that is jitter rather than a spin. */
    const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    assert.ok(
      median >= interval / 2,
      `median gap was ${median}ms against a ${interval}ms interval; ` +
        `gaps: ${gaps.join(", ")}`,
    );
  });

  it("keeps the endpoint's request count near the window's budget", () => {
    const interval = rpcQueue.getIntervalMs();
    const span = arrivals[arrivals.length - 1] - arrivals[0];
    /*- Doubled, plus two, so timer jitter and the first request — which
     *  the queue releases immediately when idle — cannot redden a run
     *  that is behaving. A spin exceeds this by orders of magnitude. */
    const allowed = Math.ceil(span / interval) * 2 + 2;
    assert.ok(
      arrivals.length <= allowed,
      `${arrivals.length} requests in ${span}ms; pacing at ${interval}ms ` +
        `allows about ${allowed}`,
    );
  });
});
