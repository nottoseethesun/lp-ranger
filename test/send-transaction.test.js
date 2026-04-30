/**
 * @file test/send-transaction.test.js
 * @description Unit tests for src/send-transaction.js.
 *
 * Covers init / getCurrentRPC / failoverToNextRPC, _resolveGasLimit,
 * _estimateWithFailover, and the public sendTransaction happy path.
 *
 * NOT covered here: phases 2-4 of _waitOrSpeedUp (speed-up, cancel) —
 * those depend on real-time setTimeout windows tied to TX_SPEEDUP_SEC /
 * TX_CANCEL_SEC and have never been unit-tested in the original copy
 * inside rebalancer-pools.js either.  They are exercised end-to-end by
 * the live bot.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/send-transaction");

/*- Stand-in ethers lib: JsonRpcProvider becomes a recognisable stub so
    the tests can assert without touching the network.  buildProvider
    applies the feeData patch in place; we don't exercise that path here
    because it lives in bot-provider.test.js.

    Per-instance estimateGas / send overrides can be installed by reaching
    into the provider returned by getCurrentRPC() — the constructor stores
    `this` references the test can patch directly. */
function mockEthersLib() {
  return {
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.getFeeData = async () => ({
          gasPrice: 1n,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        });
        this.estimateGas = async () => 100_000n;
      }
      send(method) {
        if (method === "eth_gasPrice") return Promise.resolve("0x1");
        return Promise.resolve(null);
      }
    },
    FeeData: class {
      constructor(gasPrice, maxFeePerGas, maxPriorityFeePerGas) {
        this.gasPrice = gasPrice;
        this.maxFeePerGas = maxFeePerGas;
        this.maxPriorityFeePerGas = maxPriorityFeePerGas;
      }
    },
  };
}

/*- Init helper that lets each test pin distinct estimateGas behaviour
    per-URL.  `behaviours` is { url: async () => bigint | () => throw },
    keyed by the URL the JsonRpcProvider was constructed with. */
function initWithEstimates(behaviours) {
  const lib = {
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.getFeeData = async () => ({ gasPrice: 1n });
        this.estimateGas = behaviours[url] || (async () => 100_000n);
      }
      send() {
        return Promise.resolve("0x1");
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
  sendTx.init(
    { primary: "http://primary.test", fallback: "http://fallback.test" },
    lib,
  );
}

/*- Quiet helper: capture console.warn/error/log so failover banners and
    debug lines don't pollute the test runner output.  Returns a restore fn
    plus the captured arrays for assertions. */
function muteConsole() {
  const out = { warn: [], error: [], log: [] };
  const orig = {
    warn: console.warn,
    error: console.error,
    log: console.log,
  };
  console.warn = (...a) => out.warn.push(a);
  console.error = (...a) => out.error.push(a);
  console.log = (...a) => out.log.push(a);
  return {
    out,
    restore: () => {
      console.warn = orig.warn;
      console.error = orig.error;
      console.log = orig.log;
    },
  };
}

describe("send-transaction: init / getCurrentRPC", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("getCurrentRPC throws before init", () => {
    assert.throws(() => sendTx.getCurrentRPC(), /not initialized/);
  });

  it("init builds both providers and returns primary by default", () => {
    sendTx.init(
      { primary: "http://primary.test", fallback: "http://fallback.test" },
      mockEthersLib(),
    );
    const cur = sendTx.getCurrentRPC();
    assert.equal(cur._url, "http://primary.test");
  });

  it("init rejects malformed rpcConfig", () => {
    assert.throws(() => sendTx.init({}, mockEthersLib()), /primary, fallback/);
    assert.throws(
      () => sendTx.init({ primary: "x" }, mockEthersLib()),
      /primary, fallback/,
    );
  });
});

describe("send-transaction: failoverToNextRPC", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("throws when called before init", () => {
    assert.throws(() => sendTx.failoverToNextRPC(), /not initialized/);
  });

  it("switches to fallback after failover and self-heals when window expires", () => {
    sendTx.init(
      { primary: "http://primary.test", fallback: "http://fallback.test" },
      mockEthersLib(),
    );

    /*- Sanity: primary by default. */
    assert.equal(sendTx.getCurrentRPC()._url, "http://primary.test");

    sendTx.failoverToNextRPC();
    assert.equal(sendTx.getCurrentRPC()._url, "http://fallback.test");

    /*- Manually rewind module clock by stubbing Date.now ahead of the
        failover window.  The next getCurrentRPC call must revert to
        primary — self-healing without an explicit "failback" call. */
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 60 * 60 * 1000 + 1;
      assert.equal(sendTx.getCurrentRPC()._url, "http://primary.test");
    } finally {
      Date.now = realNow;
    }
  });

  it("repeated failoverToNextRPC inside window refreshes the timer silently", () => {
    sendTx.init(
      { primary: "http://primary.test", fallback: "http://fallback.test" },
      mockEthersLib(),
    );
    /*- Capture console.warn so we can assert exactly ONE failover banner
        fires across two calls inside the same window. */
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a);
    try {
      sendTx.failoverToNextRPC();
      sendTx.failoverToNextRPC();
    } finally {
      console.warn = origWarn;
    }
    const banners = warns.filter((a) =>
      String(a[0] ?? "").includes("RPC failover engaged"),
    );
    assert.equal(banners.length, 1);
    assert.equal(sendTx.getCurrentRPC()._url, "http://fallback.test");
  });

  it("is a no-op when primary === fallback URL (single-RPC chain config)", () => {
    sendTx.init(
      { primary: "http://only.test", fallback: "http://only.test" },
      mockEthersLib(),
    );
    /*- Should NOT log a banner — there's nothing to fail over to. */
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a);
    try {
      sendTx.failoverToNextRPC();
    } finally {
      console.warn = origWarn;
    }
    assert.equal(
      warns.filter((a) => String(a[0] ?? "").includes("RPC failover engaged"))
        .length,
      0,
    );
    assert.equal(sendTx.getCurrentRPC()._url, "http://only.test");
  });
});

describe("send-transaction: _resolveGasLimit", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("estimate × multiplier when above the floor", async () => {
    /*- Default chain multiplier is 2 (chains.json gasLimitMultiplier).
        200000 × 2 = 400000 > 300000 floor → expect 400000. */
    initWithEstimates({ "http://primary.test": async () => 200_000n });
    const m = muteConsole();
    try {
      const out = await sendTx._resolveGasLimit({}, 300_000n, "test");
      assert.equal(out, 400_000n);
    } finally {
      m.restore();
    }
  });

  it("falls back to the floor when estimate × multiplier is too small", async () => {
    /*- 50000 × 2 = 100000 < 300000 floor → expect 300000. */
    initWithEstimates({ "http://primary.test": async () => 50_000n });
    const m = muteConsole();
    try {
      const out = await sendTx._resolveGasLimit({}, 300_000n, "test");
      assert.equal(out, 300_000n);
    } finally {
      m.restore();
    }
  });

  it("returns populated.gasLimit as-is when the caller pre-set it", async () => {
    let estimateCalled = false;
    initWithEstimates({
      "http://primary.test": async () => {
        estimateCalled = true;
        return 1n;
      },
    });
    const out = await sendTx._resolveGasLimit(
      { gasLimit: 777_777n },
      300_000n,
      "test",
    );
    assert.equal(out, 777_777n);
    assert.equal(estimateCalled, false);
  });

  it("returns the floor when both primary and fallback estimateGas throw", async () => {
    initWithEstimates({
      "http://primary.test": async () => {
        throw new Error("primary down");
      },
      "http://fallback.test": async () => {
        throw new Error("fallback down");
      },
    });
    const m = muteConsole();
    try {
      const out = await sendTx._resolveGasLimit({}, 300_000n, "test");
      assert.equal(out, 300_000n);
    } finally {
      m.restore();
    }
  });
});

describe("send-transaction: _estimateWithFailover", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("returns the primary's estimate without engaging failover on success", async () => {
    initWithEstimates({ "http://primary.test": async () => 123_456n });
    const out = await sendTx._estimateWithFailover({}, "test");
    assert.equal(out, 123_456n);
    /*- Active RPC must still be primary. */
    assert.equal(sendTx.getCurrentRPC()._url, "http://primary.test");
  });

  it("engages sticky failover when primary fails and fallback succeeds", async () => {
    initWithEstimates({
      "http://primary.test": async () => {
        throw new Error("primary down");
      },
      "http://fallback.test": async () => 222_222n,
    });
    const m = muteConsole();
    try {
      const out = await sendTx._estimateWithFailover({}, "test");
      assert.equal(out, 222_222n);
      /*- Active RPC must now be fallback (failover window engaged). */
      assert.equal(sendTx.getCurrentRPC()._url, "http://fallback.test");
    } finally {
      m.restore();
    }
  });

  it("re-throws the primary error when both RPCs fail", async () => {
    initWithEstimates({
      "http://primary.test": async () => {
        const e = new Error("primary down");
        e.shortMessage = "primary down";
        throw e;
      },
      "http://fallback.test": async () => {
        throw new Error("fallback down");
      },
    });
    const m = muteConsole();
    try {
      await assert.rejects(
        () => sendTx._estimateWithFailover({}, "test"),
        /primary down/,
      );
      /*- No failover engaged because the fallback also failed. */
      assert.equal(sendTx.getCurrentRPC()._url, "http://primary.test");
    } finally {
      m.restore();
    }
  });

  it("does not try the fallback when primary === fallback URL", async () => {
    /*- Same-URL config: a single estimateGas call against the only RPC. */
    let calls = 0;
    sendTx.init(
      { primary: "http://only.test", fallback: "http://only.test" },
      {
        JsonRpcProvider: class {
          constructor(url) {
            this._url = url;
            this.estimateGas = async () => {
              calls += 1;
              throw new Error("only down");
            };
            this.getFeeData = async () => ({ gasPrice: 1n });
          }
          send() {
            return Promise.resolve("0x1");
          }
        },
        FeeData: class {
          constructor(gp) {
            this.gasPrice = gp;
          }
        },
      },
    );
    await assert.rejects(
      () => sendTx._estimateWithFailover({}, "test"),
      /only down/,
    );
    /*- Both providers were built from the same URL; getCurrentRPC returns
        the primary instance.  We expect exactly ONE estimate attempt
        because the same-URL guard short-circuits the fallback retry. */
    assert.equal(calls, 1);
  });

  it("does not retry when already on fallback (no further alternate exists)", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    initWithEstimates({
      "http://primary.test": async () => {
        primaryCalls += 1;
        return 1n;
      },
      "http://fallback.test": async () => {
        fallbackCalls += 1;
        throw new Error("fallback down");
      },
    });
    /*- Engage failover so getCurrentRPC returns fallback. */
    const m = muteConsole();
    try {
      sendTx.failoverToNextRPC();
      assert.equal(sendTx.getCurrentRPC()._url, "http://fallback.test");
      await assert.rejects(
        () => sendTx._estimateWithFailover({}, "test"),
        /fallback down/,
      );
      /*- Fallback was tried once; primary was NOT consulted because the
          PRIMARY → FALLBACK direction is one-way. */
      assert.equal(fallbackCalls, 1);
      assert.equal(primaryCalls, 0);
    } finally {
      m.restore();
    }
  });
});

describe("send-transaction: sendTransaction (happy path)", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("populates → estimates → submits → confirms via _waitOrSpeedUp", async () => {
    initWithEstimates({ "http://primary.test": async () => 100_000n });

    /*- Minimal signer stub: getAddress + sendTransaction; the returned
        TX has a synchronous wait() that resolves immediately so phase 1
        of _waitOrSpeedUp completes before its speedup timer fires. */
    const signer = {
      getAddress: async () => "0xabc",
      sendTransaction: async (req) => ({
        hash: "0xdeadbeef",
        nonce: 7,
        to: req.to,
        data: req.data,
        value: req.value,
        gasLimit: req.gasLimit,
        gasPrice: req.gasPrice ?? 1n,
        wait: async () => ({
          _type: "TransactionReceipt",
          gasUsed: 90_000n,
          gasPrice: 1n,
          effectiveGasPrice: 1n,
          blockNumber: 100,
        }),
      }),
    };

    const m = muteConsole();
    try {
      const { tx, receipt } = await sendTx.sendTransaction({
        signer,
        floor: 300_000n,
        label: "happy",
        populate: async () => ({ to: "0xdef", data: "0x", value: 0n }),
      });
      assert.equal(tx.hash, "0xdeadbeef");
      assert.equal(receipt.gasUsed, 90_000n);
      assert.equal(receipt.blockNumber, 100);
      /*- gasLimit must be the bigger of (estimate × multiplier) and floor.
          With our chain config (multiplier=2), 100000×2=200000 < 300000
          floor, so the submitted gasLimit is the floor. */
      assert.equal(tx.gasLimit, 300_000n);
    } finally {
      m.restore();
    }
  });

  it("rejects when opts.populate is not a function", async () => {
    initWithEstimates({});
    await assert.rejects(
      () => sendTx.sendTransaction({ signer: {} }),
      /populate must be a function/,
    );
  });

  it("rejects when opts.signer is missing", async () => {
    initWithEstimates({});
    await assert.rejects(
      () => sendTx.sendTransaction({ populate: async () => ({}) }),
      /signer is required/,
    );
  });
});
