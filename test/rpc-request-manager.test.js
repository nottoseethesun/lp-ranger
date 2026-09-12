/**
 * @file test/rpc-request-manager.test.js
 * @description Tests for the Global RPC Request Manager.
 *
 * The guarantee under test is narrow but load-bearing: no two requests
 * leave this process closer together than the configured interval, no
 * matter how many callers ask at once. Endpoints publish limits per IP,
 * so a limiter that is correct per-caller and wrong in aggregate buys
 * nothing.
 *
 * Timing tests are kept to the minimum that can actually demonstrate
 * that, and asserted with a tolerance — a loaded machine can stretch a
 * timer, but it can never make one fire early, so the floor is the side
 * worth asserting.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");

const mgr = require("../src/rpc-request-manager");
const SHIPPED = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");

const INTERVAL = mgr.getIntervalMs();

/*- Timers fire no earlier than asked but can drift late.  Allow a few
 *  ms of slack below the nominal interval so the suite does not go
 *  flaky on a busy machine, while still catching a gap that is
 *  materially too short. */
const SLACK_MS = 15;

describe("rpc-request-manager — configuration", () => {
  it("takes its interval from the single shipped literal", () => {
    assert.strictEqual(INTERVAL, SHIPPED.globalRPCRequestRateIntervalMS);
  });

  it("is slow enough for the tightest published endpoint limit", () => {
    /*- rpc.pulsechain.box free tier: 50 requests per 10 seconds, i.e.
     *  one per 200 ms.  The configured interval must not be faster. */
    assert.ok(
      INTERVAL >= 200,
      `interval ${INTERVAL}ms would exceed 50 requests / 10 s`,
    );
  });
});

describe("rpc-request-manager — pacing", () => {
  beforeEach(() => mgr._resetForTests());

  it("releases concurrent requests one at a time, at least an interval apart", async () => {
    const t0 = Date.now();
    const at = [];
    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await mgr.acquire();
        at[i] = Date.now() - t0;
      }),
    );
    for (let i = 1; i < at.length; i++) {
      const gap = at[i] - at[i - 1];
      assert.ok(
        gap >= INTERVAL - SLACK_MS,
        `release ${i} came ${gap}ms after ${i - 1}, under the ${INTERVAL}ms interval`,
      );
    }
  });

  it("preserves arrival order", async () => {
    /*- FIFO is what keeps a long scan from starving the bot's poll
     *  cycle: whatever asked first goes first, with no queue-jumping. */
    mgr._resetForTests();
    const order = [];
    await Promise.all(
      [0, 1, 2].map(async (i) => {
        await mgr.acquire();
        order.push(i);
      }),
    );
    assert.deepStrictEqual(order, [0, 1, 2]);
  });

  it("does not make an idle caller wait", async () => {
    /*- A bot polling every five minutes must not pay a pacing penalty
     *  on its first request. */
    mgr._resetForTests();
    const t0 = Date.now();
    await mgr.acquire();
    assert.ok(Date.now() - t0 < INTERVAL, "first request should be immediate");
  });

  it("drains its queue completely", async () => {
    mgr._resetForTests();
    await Promise.all([mgr.acquire(), mgr.acquire(), mgr.acquire()]);
    assert.strictEqual(mgr.queueLength(), 0);
  });

  it("reports how many callers are waiting", async () => {
    mgr._resetForTests();
    await mgr.acquire();
    const pending = [mgr.acquire(), mgr.acquire()];
    assert.strictEqual(mgr.queueLength(), 2);
    await Promise.all(pending);
    assert.strictEqual(mgr.queueLength(), 0);
  });
});

describe("rpc-request-manager — errors belong to the consumer", () => {
  /*- The manager queues and releases. It must not inspect, wrap,
   *  classify or absorb what happens after release. Retry lives in
   *  send-transaction.js, classification in rpc-error-classifier.js,
   *  and range-cap detection in get-logs-chunked.js — each needs the
   *  original error object to do its job, so anything the manager did
   *  to an error would break one of them silently. */
  const { buildProvider } = require("../src/bot-provider");

  /** A provider whose `send` fails for one method and succeeds otherwise. */
  function stubProvider(sentinel) {
    class Stub {
      constructor(url) {
        this._url = url;
      }
      async send(method) {
        if (method === "boom") throw sentinel;
        return method;
      }
    }
    return buildProvider("http://errors.test", { JsonRpcProvider: Stub });
  }

  function capError() {
    return Object.assign(new Error("could not coalesce error"), {
      code: "UNKNOWN_ERROR",
      error: {
        code: -32602,
        message: "eth_getLogs is limited to a 10000 block range",
      },
    });
  }

  it("hands the caller the identical error object", async () => {
    /*- Identity, not just an equal message: get-logs-chunked reads the
     *  nested err.error.code to recognise a range-cap rejection, and a
     *  re-wrapped error would lose it. */
    const sentinel = capError();
    const provider = stubProvider(sentinel);
    mgr._resetForTests();
    await assert.rejects(
      () => provider.send("boom", []),
      (err) => {
        assert.strictEqual(err, sentinel, "must be the same object");
        assert.strictEqual(err.error.code, -32602, "nested code intact");
        return true;
      },
    );
  });

  it("does not stall the queue when a request fails", async () => {
    /*- A failure releases its slot like any other. If it did not, one
     *  bad request would wedge every later one behind it. */
    const provider = stubProvider(capError());
    mgr._resetForTests();
    await assert.rejects(() => provider.send("boom", []));
    assert.strictEqual(mgr.queueLength(), 0);
    assert.strictEqual(
      await provider.send("eth_blockNumber", []),
      "eth_blockNumber",
    );
  });

  it("gives each concurrent caller its own outcome, still paced", async () => {
    const sentinel = capError();
    const provider = stubProvider(sentinel);
    mgr._resetForTests();
    const t0 = Date.now();
    const results = await Promise.allSettled([
      provider.send("boom", []),
      provider.send("a", []),
      provider.send("boom", []),
      provider.send("b", []),
    ]);
    assert.deepStrictEqual(
      results.map((r) => r.status),
      ["rejected", "fulfilled", "rejected", "fulfilled"],
    );
    assert.ok(
      results
        .filter((r) => r.status === "rejected")
        .every((r) => r.reason === sentinel),
      "each rejection carries the original error",
    );
    assert.ok(
      Date.now() - t0 >= 3 * INTERVAL - SLACK_MS,
      "failures still occupy a slot; pacing must hold",
    );
    assert.strictEqual(mgr.queueLength(), 0);
  });
});

describe("rpc-request-manager — provider wiring", () => {
  it("paces every JSON-RPC method, not a chosen few", async () => {
    /*- The manager is deliberately content-agnostic: it must not be
     *  possible for a method to opt out, because one exempt caller is
     *  enough to breach the published rate.  buildProvider wraps
     *  `send`, which is the single funnel ethers routes everything
     *  through. */
    const { buildProvider } = require("../src/bot-provider");
    const sent = [];
    class StubProvider {
      constructor(url) {
        this._url = url;
      }
      async send(method, params) {
        sent.push(method);
        return params;
      }
    }
    const provider = buildProvider("http://paced.test", {
      JsonRpcProvider: StubProvider,
    });

    mgr._resetForTests();
    const t0 = Date.now();
    await provider.send("eth_getLogs", []);
    await provider.send("eth_blockNumber", []);
    const elapsed = Date.now() - t0;

    assert.deepStrictEqual(sent, ["eth_getLogs", "eth_blockNumber"]);
    assert.ok(
      elapsed >= INTERVAL - SLACK_MS,
      `two sends completed in ${elapsed}ms, under the ${INTERVAL}ms interval`,
    );
  });
});
