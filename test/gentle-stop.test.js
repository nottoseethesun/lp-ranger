"use strict";

/**
 * @file test/gentle-stop.test.js
 * @description `npm run gentle-stop` (scripts/gentle-stop.js): ask the
 *   server to stop once nothing is under way, a stop the server holds
 *   until then; keep asking, printing what the stop still waits for; and
 *   once the server stops answering, wait until it has exited.
 *
 *   The loop is driven with scripted answers and a scripted clock, its
 *   log lines caught through the log module's test sink. The stop request
 *   is sent to real local HTTP servers: one per kind of answer, one that
 *   never answers, and a port nothing listens on.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { format } = require("node:util");
const { _setSinkForTests } = require("../src/log");
const {
  askToStop,
  waitForServerExit,
  runGentleStop,
} = require("../scripts/gentle-stop");

const POLL_MS = 2_000;

/** A stop the server holds, waiting for what `waitingFor` names. */
const holding = (...waitingFor) => ({ state: "holding", waitingFor });
const scanOf = (position) => ({ position, activity: "scan" });

/**
 * Run the loop over `answers`, one per request, then refused connections:
 * the server gone. Each request moves the clock on by `askTakesMs`.
 */
async function runOver(answers, askTakesMs = 0) {
  let clock = 1_000_000;
  const sleeps = [];
  const said = [];
  let exits = 0;
  const left = [...answers];
  const restore = _setSinkForTests({
    log: (...a) => said.push(format(...a)),
  });
  try {
    const outcome = await runGentleStop({
      stop: async () => {
        clock += askTakesMs;
        return left.shift() ?? { state: "refused" };
      },
      waitForExit: async () => {
        exits++;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
      pollMs: POLL_MS,
      address: "127.0.0.1:5555",
    });
    return { outcome, sleeps, said, exits };
  } finally {
    restore();
  }
}

/** The lines that say a given thing. */
const saying = (said, text) => said.filter((l) => l.includes(text));

describe("runGentleStop", () => {
  it("asks the server to stop, says what it waits for, then waits for it to exit", async () => {
    const r = await runOver([
      holding(scanOf("PulseX/WPLS NFT #167040")),
      holding(scanOf("PulseX/WPLS NFT #167040")),
      holding(),
    ]);
    assert.equal(r.outcome, "stopped");
    assert.equal(r.exits, 1);
    assert.equal(
      saying(r.said, "Waiting for: scan of PulseX/WPLS NFT #167040").length,
      1,
      "the same answer is said once",
    );
    assert.equal(saying(r.said, "the server is exiting").length, 1);
    assert.equal(saying(r.said, "✔ Stopped").length, 1);
  });

  it("says a long wait again once a minute", async () => {
    // Thirty-one answers two seconds apart: a minute and two seconds.
    const r = await runOver(
      Array.from({ length: 31 }, () => holding(scanOf("A/B NFT #7"))),
    );
    const lines = saying(r.said, "Waiting for: scan of A/B NFT #7");
    assert.equal(lines.length, 2);
    assert.match(lines[1], /\(1 min so far\)/);
  });

  it("stops nothing when no server is listening", async () => {
    const r = await runOver([]);
    assert.equal(r.outcome, "absent");
    assert.equal(r.exits, 0);
    assert.equal(saying(r.said, "nothing to stop").length, 1);
  });

  it("asks again when the server gives no answer, and stops once it takes the stop", async () => {
    const r = await runOver([
      { state: "silent", detail: "no answer within 2000 ms" },
      holding(),
    ]);
    assert.equal(r.outcome, "stopped");
    assert.equal(saying(r.said, "The server gave no answer").length, 1);
    assert.equal(saying(r.said, "The server took the stop").length, 1);
  });

  it("asks one interval after the last request, however long its answer took", async () => {
    const r = await runOver([holding(), holding()], 500);
    assert.deepEqual(r.sleeps, [POLL_MS - 500, POLL_MS - 500]);
  });
});

/** Start a local server answering every request with `handler`. */
async function serverAnswering(handler) {
  const srv = http.createServer(handler);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  return srv;
}

const json = (status, body) => (req, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

/** A server that gives a CSRF token, and answers the stop with `stop`. */
function stopServer(stop, seen = []) {
  return serverAnswering((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers["x-csrf-token"]}`);
    if (req.url === "/api/csrf-token") json(200, { token: "t0k" })(req, res);
    else stop(req, res);
  });
}

/** Ask the server `srv` once, with a short time limit. */
function askOf(srv, timeoutMs = 2000) {
  return askToStop({
    host: "127.0.0.1",
    port: srv.address().port,
    timeoutMs,
  });
}

describe("askToStop", () => {
  it("asks the server to stop once all is clear, with a CSRF token, and reads what it waits for", async () => {
    const seen = [];
    const srv = await stopServer(
      json(200, {
        ok: true,
        stopping: true,
        waitingFor: [scanOf("A/B NFT #7"), { junk: true }],
      }),
      seen,
    );
    try {
      assert.deepEqual(await askOf(srv), holding(scanOf("A/B NFT #7")));
      assert.deepEqual(seen, [
        "GET /api/csrf-token undefined",
        "POST /api/stop-when-all-clear t0k",
      ]);
    } finally {
      srv.close();
    }
  });

  it("takes anything else as no answer", async () => {
    const servers = [
      await stopServer(json(403, { ok: false })),
      await stopServer(json(200, "<!doctype html>")),
      await stopServer(json(200, { ok: true })),
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
    const srv = await serverAnswering(json(200, {}));
    const port = srv.address().port;
    await new Promise((resolve) => srv.close(resolve));
    const answer = await askToStop({
      host: "127.0.0.1",
      port,
      timeoutMs: 2000,
    });
    assert.deepEqual(answer, { state: "refused" });
  });
});

describe("waitForServerExit", () => {
  it("returns only once the server has exited", async () => {
    let checks = 0;
    const slept = [];
    await waitForServerExit({
      isRunning: () => ++checks < 4,
      sleep: async (ms) => slept.push(ms),
      intervalMs: 100,
    });
    assert.equal(checks, 4);
    assert.deepEqual(slept, [100, 100, 100]);
  });
});
