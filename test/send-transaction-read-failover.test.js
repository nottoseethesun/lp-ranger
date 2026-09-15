"use strict";

/**
 * @file test/send-transaction-read-failover.test.js
 * @description Tests for the read-side RPC failover surface added to
 *   `src/send-transaction.js`:
 *
 *     - `init()` idempotency (same URLs → no-op; different URLs → throws)
 *     - `ensureReachable()` boot-time reachability probe + failover engagement
 *     - `getManagedReadProvider()` — Proxy that routes every property
 *       access through `getCurrentRPC()` and retries on failover-eligible
 *       errors by engaging `failoverToNextRPC()` and re-invoking against
 *       the new active provider.
 *     - `_isReadFailoverable(err)` — classifier for which error shapes
 *       indicate the active RPC is the problem.
 *
 *   Companion to `test/send-transaction.test.js` which covers
 *   `getCurrentRPC` / `failoverToNextRPC` / `sendTransaction` itself.
 *   Kept in a separate file so neither exceeds the 500-line cap.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/send-transaction");
const logModule = require("../src/log");
/*- Real ethers, for the queryFilter regression test: the bug lives in
 *  how ethers resolves a Contract runner, so a stub cannot exercise it. */
const { ethers: realEthers } = require("ethers");

/*- Per-test ethers mock factory.  Lets callers stub getBlockNumber
    per-URL (success / throw with a given error shape).  Mirrors the
    pattern used in test/send-transaction.test.js. */
function makeLib(behaviours = {}) {
  return {
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.getFeeData = async () => ({ gasPrice: 1n });
        this.estimateGas = async () => 100_000n;
        const b = behaviours[url] || {};
        this.getBlockNumber = b.getBlockNumber || (async () => 12345);
        this.getLogs = b.getLogs || (async () => []);
        this._customSend = b.send;
      }
      send(method, params) {
        if (this._customSend) return this._customSend(method, params);
        if (method === "eth_gasPrice") return Promise.resolve("0x1");
        return Promise.resolve(null);
      }
    },
    FeeData: class {
      constructor(gp, mf, mp) {
        this.gasPrice = gp;
        this.maxFeePerGas = mf;
        this.maxPriorityFeePerGas = mp;
      }
    },
  };
}

/*- Capture log output via the `src/log.js` sink injector so the global
 *  `console` is never patched (see [[feedback-no-global-monkey-patch]]).
 *  Strip the `[YYYY-MM-DD HH:MM:SS] ` timestamp prefix from each
 *  captured first arg so substring assertions like `.includes("[bot]
 *  RPC:")` keep matching the original tag+message contiguously. */
const _TS = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /g;
function _stripTs(args) {
  if (typeof args[0] === "string") {
    const stripped = args[0].replace(_TS, "");
    return [stripped, ...args.slice(1)];
  }
  return args;
}
function muteConsole() {
  const out = { warn: [], log: [] };
  const restore = logModule._setSinkForTests({
    warn: (...a) => out.warn.push(_stripTs(a)),
    log: (...a) => out.log.push(_stripTs(a)),
  });
  return { out, restore };
}

const PRI = "http://primary.test";
const FALL = "http://fallback.test";

describe("send-transaction: init idempotency", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("re-init with the SAME URLs is a no-op (providers preserved)", () => {
    const lib = makeLib();
    sendTx.init({ urls: [PRI, FALL] }, lib);
    const provFirst = sendTx.getCurrentRPC();
    sendTx.init({ urls: [PRI, FALL] }, lib);
    const provSecond = sendTx.getCurrentRPC();
    assert.strictEqual(provFirst, provSecond);
  });

  it("re-init with the SAME URLs preserves an active failover window", () => {
    const lib = makeLib();
    sendTx.init({ urls: [PRI, FALL] }, lib);
    const m = muteConsole();
    try {
      sendTx.failoverToNextRPC();
    } finally {
      m.restore();
    }
    assert.equal(sendTx.getCurrentRPC()._url, FALL);
    /*- Re-init must NOT wipe the sticky failover state, otherwise a
        second boot path (server.js running after bot-loop.js) would
        silently revert us to a known-broken primary. */
    sendTx.init({ urls: [PRI, FALL] }, lib);
    assert.equal(sendTx.getCurrentRPC()._url, FALL);
  });

  it("re-init with DIFFERENT URLs throws", () => {
    sendTx.init({ urls: [PRI, FALL] }, makeLib());
    assert.throws(
      () => sendTx.init({ urls: ["http://other.test", FALL] }, makeLib()),
      /different URLs/,
    );
  });
});

describe("send-transaction: ensureReachable", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("throws when called before init", async () => {
    await assert.rejects(() => sendTx.ensureReachable(), /not initialised/);
  });

  it("returns silently when primary is reachable (no failover)", async () => {
    sendTx.init({ urls: [PRI, FALL] }, makeLib());
    const m = muteConsole();
    try {
      await sendTx.ensureReachable();
    } finally {
      m.restore();
    }
    assert.equal(sendTx.getCurrentRPC()._url, PRI);
    /*- Exactly one [bot] RPC: line for the primary; no fallback banner. */
    const rpcLogs = m.out.log.filter((a) =>
      String(a[0] ?? "").includes("[bot] RPC:"),
    );
    assert.equal(rpcLogs.length, 1);
    assert.ok(String(rpcLogs[0][0] ?? "").includes(PRI));
  });

  it("engages failover when primary throws and fallback works", async () => {
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: {
          getBlockNumber: async () => {
            throw new Error("primary down");
          },
        },
      }),
    );
    const m = muteConsole();
    try {
      await sendTx.ensureReachable();
    } finally {
      m.restore();
    }
    assert.equal(sendTx.getCurrentRPC()._url, FALL);
    /*- Logs reflect the boot-time fallback engagement. */
    const fallbackBanners = m.out.log.filter((a) =>
      String(a[0] ?? "").includes("Falling back to"),
    );
    assert.equal(fallbackBanners.length, 1);
  });

  it("propagates the primary error when fallback ALSO fails", async () => {
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
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
      }),
    );
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

  it("propagates the primary error when primary === fallback URL", async () => {
    sendTx.init(
      { urls: [PRI] },
      makeLib({
        [PRI]: {
          getBlockNumber: async () => {
            throw new Error("only-RPC down");
          },
        },
      }),
    );
    const m = muteConsole();
    try {
      await assert.rejects(() => sendTx.ensureReachable(), /only-RPC down/);
    } finally {
      m.restore();
    }
  });
});

describe("send-transaction: getManagedReadProvider", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("returns a proxy that defers init-required errors to first use", async () => {
    /*- getManagedReadProvider itself does NOT throw before init() — it
     *  returns a Proxy whose first property access drives getCurrentRPC()
     *  and throws there.  This lets tests that obtain the proxy without
     *  exercising RPC behaviour succeed without a full init. */
    const proxy = sendTx.getManagedReadProvider();
    assert.ok(proxy);
    assert.throws(() => proxy.getBlockNumber, /not initialized/);
  });

  it("routes method calls through the currently-active RPC", async () => {
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: { getBlockNumber: async () => 100 },
        [FALL]: { getBlockNumber: async () => 200 },
      }),
    );
    const managed = sendTx.getManagedReadProvider();
    assert.equal(await managed.getBlockNumber(), 100);
    const m = muteConsole();
    try {
      sendTx.failoverToNextRPC();
    } finally {
      m.restore();
    }
    assert.equal(await managed.getBlockNumber(), 200);
  });

  it("returns non-function properties straight from the active provider", () => {
    sendTx.init({ urls: [PRI, FALL] }, makeLib());
    const managed = sendTx.getManagedReadProvider();
    assert.equal(managed._url, PRI);
  });

  it("returns ITSELF for `provider`, so ethers cannot escape the wrapper", () => {
    /*- ethers resolves a Contract's provider via `runner.provider`
     *  (getProvider in its contract.js), and a provider's own
     *  `.provider` getter returns itself.  Handing back the raw provider
     *  there put every queryFilter in the app outside this retry —
     *  one transient 502 then dropped a whole block window. */
    sendTx.init({ urls: [PRI, FALL] }, makeLib());
    const managed = sendTx.getManagedReadProvider();
    assert.strictEqual(managed.provider, managed);
  });

  it("retries a real ethers Contract's queryFilter (the regression)", async () => {
    let priCalls = 0;
    const lib = makeLib({
      [PRI]: {
        getLogs: async () => {
          priCalls++;
          const err = new Error("upstream 502");
          err.code = "SERVER_ERROR";
          err.info = { responseStatus: "502 Bad Gateway" };
          throw err;
        },
      },
      [FALL]: { getLogs: async () => [] },
    });
    sendTx.init({ urls: [PRI, FALL] }, lib);
    const managed = sendTx.getManagedReadProvider();
    const c = new realEthers.Contract(
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      [
        "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
      ],
      managed,
    );
    const m = muteConsole();
    let logs;
    try {
      logs = await c.queryFilter(c.filters.Transfer(), 1, 2);
    } finally {
      m.restore();
    }
    assert.deepEqual(logs, []);
    assert.equal(priCalls, 1, "primary should have been tried exactly once");
    assert.equal(sendTx.getCurrentRPC()._url, FALL);
  });

  it("engages failover on SERVER_ERROR and retries against the fallback", async () => {
    let primaryCalls = 0;
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: {
          getBlockNumber: async () => {
            primaryCalls++;
            const err = new Error("upstream 502");
            err.code = "SERVER_ERROR";
            err.info = { responseStatus: "502 Bad Gateway" };
            throw err;
          },
        },
        [FALL]: { getBlockNumber: async () => 999 },
      }),
    );
    const managed = sendTx.getManagedReadProvider();
    const m = muteConsole();
    let result;
    try {
      result = await managed.getBlockNumber();
    } finally {
      m.restore();
    }
    assert.equal(result, 999);
    assert.equal(primaryCalls, 1);
    /*- After the failover-retry path, sticky window engaged → fallback. */
    assert.equal(sendTx.getCurrentRPC()._url, FALL);
  });

  it("does NOT failover on non-failover-eligible errors", async () => {
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: {
          getBlockNumber: async () => {
            const err = new Error("nonce too low");
            err.code = "NONCE_EXPIRED";
            throw err;
          },
        },
        [FALL]: { getBlockNumber: async () => 999 },
      }),
    );
    const managed = sendTx.getManagedReadProvider();
    await assert.rejects(() => managed.getBlockNumber(), /nonce too low/);
    /*- Failover never engaged — still on primary. */
    assert.equal(sendTx.getCurrentRPC()._url, PRI);
  });

  it("keeps retrying a sole endpoint until it heals", async () => {
    /*- A sole endpoint is retried like any other.  Having no alternate
     *  to move to is not a reason to drop the read: for a chunked log
     *  scan a dropped read is a block window that is never read, and a
     *  history short by that window is indistinguishable from a complete
     *  one at every layer above it. */
    let calls = 0;
    sendTx.init(
      { urls: [PRI] },
      makeLib({
        [PRI]: {
          getBlockNumber: async () => {
            calls++;
            if (calls >= 4) return 777;
            const err = new Error("upstream 522");
            err.code = "SERVER_ERROR";
            err.info = { responseStatus: "522 <none>" };
            throw err;
          },
        },
      }),
    );
    const managed = sendTx.getManagedReadProvider();
    const m = muteConsole();
    let result;
    try {
      result = await managed.getBlockNumber();
    } finally {
      m.restore();
    }
    assert.equal(result, 777);
    assert.equal(calls, 4);
  });

  it("logs one retry line per failed attempt", async () => {
    let calls = 0;
    sendTx.init(
      { urls: [PRI] },
      makeLib({
        [PRI]: {
          getBlockNumber: async () => {
            calls++;
            if (calls >= 3) return 1;
            const err = new Error("upstream 522");
            err.code = "SERVER_ERROR";
            throw err;
          },
        },
      }),
    );
    const managed = sendTx.getManagedReadProvider();
    const m = muteConsole();
    try {
      await managed.getBlockNumber();
    } finally {
      m.restore();
    }
    /*- The first failure is what enters the loop; attempt #1 inside it
     *  also throws and IS logged, attempt #2 succeeds.  So exactly one
     *  retry line.  The sink stores raw args, so the format string is
     *  `a[0]` and the substitutions follow it. */
    const lines = m.out.warn.filter((a) =>
      String(a[0] ?? "").includes("read retry #"),
    );
    assert.equal(lines.length, 1);
    assert.equal(lines[0][1], 1, "attempt number");
    assert.equal(lines[0][2], "getBlockNumber", "method name");
  });

  it("propagates a non-failoverable error raised by a later attempt", async () => {
    let calls = 0;
    sendTx.init(
      { urls: [PRI, FALL] },
      makeLib({
        [PRI]: {
          getBlockNumber: async () => {
            calls++;
            const err = new Error("upstream 502");
            err.code = "SERVER_ERROR";
            throw err;
          },
        },
        [FALL]: {
          getBlockNumber: async () => {
            calls++;
            const err = new Error("execution reverted");
            err.code = "CALL_EXCEPTION";
            throw err;
          },
        },
      }),
    );
    const managed = sendTx.getManagedReadProvider();
    const m = muteConsole();
    try {
      await assert.rejects(
        () => managed.getBlockNumber(),
        /execution reverted/,
      );
    } finally {
      m.restore();
    }
    assert.equal(calls, 2);
  });
});

describe("send-transaction: _isReadFailoverable", () => {
  it("classifies SERVER_ERROR as failover-eligible", () => {
    assert.equal(sendTx._isReadFailoverable({ code: "SERVER_ERROR" }), true);
  });
  it("classifies TIMEOUT as failover-eligible", () => {
    assert.equal(sendTx._isReadFailoverable({ code: "TIMEOUT" }), true);
  });
  it("classifies NETWORK_ERROR as failover-eligible", () => {
    assert.equal(sendTx._isReadFailoverable({ code: "NETWORK_ERROR" }), true);
  });
  it("classifies a 5xx responseStatus as failover-eligible", () => {
    assert.equal(
      sendTx._isReadFailoverable({
        info: { responseStatus: "502 Bad Gateway" },
      }),
      true,
    );
    assert.equal(
      sendTx._isReadFailoverable({ info: { responseStatus: "522 <none>" } }),
      true,
    );
  });
  it("rejects a 4xx responseStatus (request is the problem, not the RPC)", () => {
    assert.equal(
      sendTx._isReadFailoverable({
        info: { responseStatus: "400 Bad Request" },
      }),
      false,
    );
  });
  it("rejects NONCE_EXPIRED and other terminal errors", () => {
    assert.equal(sendTx._isReadFailoverable({ code: "NONCE_EXPIRED" }), false);
    assert.equal(sendTx._isReadFailoverable({ code: "CALL_EXCEPTION" }), false);
  });
  it("rejects null/undefined input", () => {
    assert.equal(sendTx._isReadFailoverable(null), false);
    assert.equal(sendTx._isReadFailoverable(undefined), false);
    assert.equal(sendTx._isReadFailoverable({}), false);
  });
});
