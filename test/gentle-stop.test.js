"use strict";

/**
 * @file test/gentle-stop.test.js
 * @description `npm run gentle-stop` (scripts/gentle-stop.js): ask the
 *   server whether a rebalance or compound is under way, and stop it the
 *   way `npm stop` does only once the answer is no.
 *
 *   The loop is driven with scripted answers and a scripted clock. The
 *   question itself is asked of real local HTTP servers: one per kind of
 *   answer, one that never answers, and a port nothing listens on.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { askAdjusting, runGentleStop } = require("../scripts/gentle-stop");

const POLL_MS = 300_000;

/**
 * Run the loop over `answers`, one per question, on a clock that each
 * question moves on by `askTakesMs`.
 */
async function runOver(answers, askTakesMs = 0) {
  let clock = 1_000_000;
  const sleeps = [];
  let stops = 0;
  const left = [...answers];
  const outcome = await runGentleStop({
    ask: async () => {
      clock += askTakesMs;
      return left.shift();
    },
    stop: async () => {
      stops++;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    pollMs: POLL_MS,
    address: "127.0.0.1:5555",
  });
  return { outcome, sleeps, stops, unasked: left.length };
}

describe("runGentleStop", () => {
  it("waits while a rebalance or compound is under way, then stops the server once", async () => {
    const r = await runOver([
      { state: "busy" },
      { state: "busy" },
      { state: "clear" },
    ]);
    assert.equal(r.outcome, "stopped");
    assert.equal(r.stops, 1);
    assert.deepEqual(r.sleeps, [POLL_MS, POLL_MS]);
  });

  it("stops at once when nothing is under way at the first question", async () => {
    const r = await runOver([{ state: "clear" }]);
    assert.equal(r.stops, 1);
    assert.deepEqual(r.sleeps, []);
  });

  it("never takes no answer as the all-clear", async () => {
    /*-
     *  A server too busy to answer may be busy with a rebalance, so a
     *  silent server is asked again rather than stopped.
     */
    const r = await runOver([
      { state: "silent", detail: "no answer within 300000 ms" },
      { state: "silent", detail: "HTTP 500" },
      { state: "busy" },
      { state: "clear" },
    ]);
    assert.equal(r.stops, 1);
    assert.equal(r.sleeps.length, 3);
  });

  it("stops nothing when no server is listening", async () => {
    const r = await runOver([{ state: "refused" }, { state: "clear" }]);
    assert.equal(r.outcome, "absent");
    assert.equal(r.stops, 0);
    assert.equal(r.unasked, 1, "asks nothing after the refusal");
  });

  it("asks one interval after the last question, however long its answer took", async () => {
    const r = await runOver([{ state: "busy" }, { state: "clear" }], 40_000);
    assert.deepEqual(r.sleeps, [POLL_MS - 40_000]);
  });
});

/** Start a local server answering every request with `handler`. */
async function serverAnswering(handler) {
  const srv = http.createServer(handler);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return srv;
}

/** Ask the server `srv` once, with a short time limit. */
function askOf(srv, timeoutMs = 2000) {
  return askAdjusting({
    host: "127.0.0.1",
    port: srv.address().port,
    timeoutMs,
  });
}

const json = (status, body) => (req, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

describe("askAdjusting", () => {
  it("asks the being-adjusted route and reads both answers", async () => {
    let path = null;
    const busy = await serverAnswering((req, res) => {
      path = req.url;
      json(200, { adjusting: true })(req, res);
    });
    const clear = await serverAnswering(json(200, { adjusting: false }));
    try {
      assert.deepEqual(await askOf(busy), { state: "busy" });
      assert.equal(path, "/api/is-position-being-adjusted");
      assert.deepEqual(await askOf(clear), { state: "clear" });
    } finally {
      busy.close();
      clear.close();
    }
  });

  it("takes anything else as no answer", async () => {
    const servers = [
      await serverAnswering(json(404, { ok: false })),
      await serverAnswering(json(200, "<!doctype html>")),
      await serverAnswering(json(200, { ok: true })),
    ];
    try {
      for (const srv of servers)
        assert.equal((await askOf(srv)).state, "silent");
    } finally {
      for (const srv of servers) srv.close();
    }
  });

  it("gives up on a server that does not answer in time", async () => {
    const held = [];
    const mute = await serverAnswering((req, res) => held.push(res));
    try {
      const answer = await askOf(mute, 50);
      assert.equal(answer.state, "silent");
      assert.match(answer.detail, /no answer within 50 ms/);
    } finally {
      for (const res of held) res.destroy();
      mute.close();
    }
  });

  it("reports a refused connection where nothing listens", async () => {
    const srv = await serverAnswering(json(200, { adjusting: false }));
    const port = srv.address().port;
    await new Promise((resolve) => srv.close(resolve));
    const answer = await askAdjusting({
      host: "127.0.0.1",
      port,
      timeoutMs: 2000,
    });
    assert.deepEqual(answer, { state: "refused" });
  });
});
