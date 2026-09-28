/**
 * @file test/rpc-outage-no-unpaced-detection.test.js
 * @description
 * What the app must do when every RPC endpoint refuses at once: stop
 * sending, and wait.
 *
 * It did not. On 2026-09-27 all three PulseChain endpoints began
 * answering 502 together, and the process was killed hours later having
 * grown to several gigabytes. These assertions guard against that
 * returning.
 *
 * How it got out is worth following, because it decides how the test has
 * to be built.  Every JSON-RPC request the app makes is meant to pass
 * through one process-wide queue, `src/rpc-request-manager.js`.  The
 * queue paces requests, and when failover runs out of endpoints it holds
 * every one of them for an hour — the halt.  It is wired into ethers at
 * `send()`, the method ethers puts its traffic through, and that single
 * wiring point is the whole of the guarantee.
 *
 * Detecting which chain an endpoint serves is the one call that can go
 * around it.  A provider that has not yet completed a `send()` is not
 * `ready`, and an unready provider detects over `_send`, the raw
 * primitive underneath `send()`.  A total outage makes that state
 * permanent: the halt holds `send()`, and `send()` is what would have
 * made the provider ready, so the provider stays unready and every read
 * detects over the unpaced path.
 *
 * The leak follows from ethers' ordering.  `call()` starts its `eth_call`
 * before it awaits detection.  When detection then fails, the call is
 * abandoned — but its place in the queue is not.  Each abandoned read
 * holds its promise chain and payload, roughly 11 KB, and nothing
 * releases it.
 *
 * `src/bot-provider.js` closes the route by handing every provider a
 * `staticNetwork` from chains.json, so detection answers from config and
 * never reaches the wire.
 *
 * Hence a real socket here rather than a stub provider.  The defect
 * lives in the seam between ethers' internals and the pacing wrapper,
 * and a stub has no such seam — it never detects at all.  Against the
 * unfixed tree the three assertions below fail by orders of magnitude:
 * thousands of requests sent, and thousands of reads left queued, inside
 * a window of a second and a half.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const rpcQueue = require("../src/rpc-request-manager");
const sendTx = require("../src/send-transaction");

/**
 * How long to leave the endpoints refusing before taking the counts.
 *
 * Short, because the failure it looks for is fast: against the unfixed
 * tree this window drew several thousand requests. A correct run sends
 * three in it, one per endpoint, so the two outcomes are never close
 * enough for the exact length to matter.
 */
const OUTAGE_WATCH_MS = 1_500;

/**
 * The chain id the stub node reports while healthy: 369, PulseChain, the
 * same id chains.json carries.
 *
 * It has to match. The fixed app never asks — that is what the first
 * assertion checks — but the unfixed one does, and an id disagreeing
 * with config would fail it on a network mismatch instead of on the
 * runaway traffic this file is about.
 */
const CHAIN_ID_HEX = "0x171";

/** Counts of requests the stub node received, by method, in each phase. */
const seen = { healthy: new Map(), outage: new Map() };

let server = null;
let outage = false;
let queueAfterOutage = 0;

/**
 * Sum one phase's counts across every method.
 * @param {"healthy"|"outage"} phase  Which phase to total.
 * @returns {number}  Requests the stub node received during it.
 */
function total(phase) {
  let n = 0;
  for (const count of seen[phase].values()) n += count;
  return n;
}

/**
 * The reply a healthy node would give to one JSON-RPC method.
 * @param {string} method  The method being answered.
 * @returns {string}  Its hex result; a 32-byte zero word for anything
 *   without a more specific answer, which suits `eth_call`.
 */
function _result(method) {
  if (method === "eth_chainId") return CHAIN_ID_HEX;
  if (method === "eth_blockNumber") return "0x1234";
  return "0x" + "00".repeat(32);
}

/**
 * Build the stub node, which serves every method normally until the
 * module's `outage` flag is raised and answers 502 to everything
 * afterwards — the failure all three PulseChain endpoints showed.
 *
 * It counts what it receives either way, into `seen`, which is where the
 * assertions read their evidence from.
 * @returns {import('node:http').Server}  Not yet listening; see `listen`.
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
      const phase = outage ? "outage" : "healthy";
      for (const one of batch) {
        const method = String(one.method);
        seen[phase].set(method, (seen[phase].get(method) || 0) + 1);
      }
      if (outage) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("error code: 502\n");
        return;
      }
      const replies = batch.map((one) => ({
        jsonrpc: "2.0",
        id: one.id,
        result: _result(one.method),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
    });
  });
}

/**
 * Start the stub node on a port the operating system picks, so parallel
 * test files never collide.
 * @param {import('node:http').Server} srv  The node to start.
 * @returns {Promise<string>}  Its base URL, once it is accepting.
 */
function listen(srv) {
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${srv.address().port}`),
    );
  });
}

/**
 * Yield for `ms`, letting the queue's timers and the retry loop run.
 * @param {number} ms  How long to wait.
 * @returns {Promise<void>}
 */
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe("a total endpoint outage parks reads instead of spinning", () => {
  before(async () => {
    rpcQueue._resetForTests();
    server = buildStubNode();
    const base = await listen(server);
    /*- Three distinct URLs on the one stub node, so failover has a full
     *  list to walk and can reach the end of it. */
    sendTx.init({
      urls: [`${base}/one`, `${base}/two`, `${base}/three`],
    });

    const provider = sendTx.getManagedReadProvider();
    /*- One successful read first, so the outage below begins against a
     *  provider that has already been serving — the state production was
     *  in, and the state that decides whether a provider is ready. */
    await provider.call({
      to: "0x" + "11".repeat(20),
      data: "0x3850c7bd",
    });

    outage = true;
    /*- Not awaited, and it cannot be.  Working correctly, this read sits
     *  in the queue until the halt lifts an hour from now, so awaiting it
     *  would hang the suite.  That it should sit is the whole claim; the
     *  counts taken afterwards are how the sitting gets measured. */
    provider
      .call({ to: "0x" + "22".repeat(20), data: "0x3850c7bd" })
      .catch(() => {});

    await tick(OUTAGE_WATCH_MS);
    queueAfterOutage = rpcQueue.queueLength();
  });

  after(async () => {
    /*- Heal the node before releasing the queue so the parked read can
     *  finish and its retry loop exit.  Closing the socket first would
     *  leave that loop retrying a refused connection forever. */
    outage = false;
    rpcQueue._resetForTests();
    await tick(200);
    if (server !== null) await new Promise((r) => server.close(r));
  });

  it("never asks an endpoint which chain it is on", () => {
    const asked =
      (seen.healthy.get("eth_chainId") || 0) +
      (seen.outage.get("eth_chainId") || 0);
    assert.equal(
      asked,
      0,
      `the chain id comes from chains.json, not the wire — ${asked} eth_chainId ` +
        "request(s) went out. Detection is the one call that skips the global " +
        "queue, so any at all is an unpaced, unhaltable path.",
    );
  });

  it("stops sending once every endpoint has been tried", () => {
    const sent = total("outage");
    assert.ok(
      sent <= 10,
      `${sent} requests went out during the outage. Walking three endpoints ` +
        "costs a handful; thousands means the retry loop is spinning past " +
        "the pause rather than waiting behind it.",
    );
  });

  it("leaves no abandoned reads piling up in the queue", () => {
    assert.ok(
      queueAfterOutage <= 5,
      `${queueAfterOutage} requests were queued. Each one retains its promise ` +
        "chain and payload — roughly 11 KB — so an unbounded count is the OOM.",
    );
  });
});
