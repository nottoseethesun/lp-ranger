/**
 * @file test/rpc-failover-idempotent-per-endpoint.test.js
 * @description
 * One endpoint failing must cost the list one endpoint, however many
 * reads it fails at once.
 *
 * The bot runs many reads concurrently — ten positions polling, a
 * pool-state read, a chunked scan — so a single endpoint's blip fails
 * several of them inside the same second. When each failure advanced
 * selection, three endpoints were spent by two or three simultaneous
 * errors, and whichever caller stepped off the end halted every
 * JSON-RPC request in the process for an hour.
 *
 * That is not hypothetical. Production, 2026-09-28 19:34:25, inside one
 * second: two "RPC failover engaged" lines, no failure recorded against
 * the middle endpoint, then "ALL 3 RPC ENDPOINT(S) FAILED". The middle
 * endpoint was never asked. An operator probe against the first one
 * passed four seconds later.
 *
 * `failoverToNextRPC(failedProvider)` makes the report idempotent: it
 * advances only while selection still sits on the endpoint the caller
 * saw fail. These tests pin that, and pin that omitting the argument
 * keeps the unconditional step boot probes rely on.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/send-transaction");
const rpcQueue = require("../src/rpc-request-manager");

const URLS = ["http://one.test", "http://two.test", "http://three.test"];

/** Minimal ethers double: one object per URL, distinguishable by identity. */
function fakeEthers() {
  return {
    JsonRpcProvider: class {
      constructor(url) {
        this.url = url;
      }
    },
  };
}

/** The provider currently selected. */
const at = () => sendTx.getCurrentRPC();

describe("a failure report names its endpoint", () => {
  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
    sendTx.init({ urls: URLS }, fakeEthers());
  });

  afterEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  it("advances once when many reads fail on the same endpoint", () => {
    /*- The production shape: several concurrent reads all holding the
     *  first provider, all failing on the same blip. */
    const first = at();
    assert.equal(first.url, URLS[0]);

    assert.equal(
      sendTx.failoverToNextRPC(first),
      true,
      "the first report moves",
    );
    for (let i = 0; i < 9; i++) {
      assert.equal(
        sendTx.failoverToNextRPC(first),
        false,
        "a later report of the SAME endpoint must not advance again",
      );
    }
    assert.equal(
      at().url,
      URLS[1],
      "ten failures on one endpoint cost exactly one endpoint",
    );
  });

  it("does not reach the end of the list on one endpoint's blip", () => {
    /*- The defect, stated as its consequence: the halt must not engage
     *  while two of three endpoints have never been asked. */
    const first = at();
    for (let i = 0; i < 20; i++) sendTx.failoverToNextRPC(first);
    assert.equal(at().url, URLS[1]);
    assert.equal(
      rpcQueue.haltRemainingMs(),
      0,
      "no endpoint-exhausted pause may fire from a single endpoint failing",
    );
  });

  it("still walks the whole list when each endpoint really fails", () => {
    /*- Idempotence must not cost the genuine case its progress. */
    assert.equal(sendTx.failoverToNextRPC(at()), true);
    assert.equal(at().url, URLS[1]);
    assert.equal(sendTx.failoverToNextRPC(at()), true);
    assert.equal(at().url, URLS[2]);
    /*- Stepping off the last one is the real exhaustion, and pauses. */
    assert.equal(sendTx.failoverToNextRPC(at()), true);
    assert.ok(
      rpcQueue.haltRemainingMs() > 0,
      "three genuinely failed endpoints DO exhaust the list",
    );
  });

  it("a report from an endpoint we already left is spent", () => {
    const first = at();
    sendTx.failoverToNextRPC(first);
    const second = at();
    /*- A slow caller still holding the first provider reports late. */
    assert.equal(sendTx.failoverToNextRPC(first), false);
    assert.equal(at(), second, "selection is unchanged");
  });

  it("omitting the argument keeps the unconditional step", () => {
    /*- Boot probes and tests driving state ask for "step the list",
     *  which is a different request from "this endpoint failed". */
    assert.equal(sendTx.failoverToNextRPC(), true);
    assert.equal(at().url, URLS[1]);
    assert.equal(sendTx.failoverToNextRPC(), true);
    assert.equal(at().url, URLS[2]);
  });

  it("a report held across the sticky window's expiry is spent", () => {
    /*- The snapback inside getCurrentRPC returns selection to the first
     *  endpoint once the window lapses. A caller still holding the
     *  endpoint from before must not be able to advance off that
     *  restored first endpoint — its failure describes a selection that
     *  no longer exists. The guard reads `from` AFTER the snapback,
     *  which is what makes this come out right. */
    const realNow = Date.now;
    let nowMs = realNow();
    Date.now = () => nowMs;
    try {
      sendTx.failoverToNextRPC();
      const stale = at();
      assert.equal(stale.url, URLS[1]);
      /*- Past the sticky window, so the next read snaps back to first. */
      nowMs += 61 * 60 * 1000;
      assert.equal(
        sendTx.failoverToNextRPC(stale),
        false,
        "a stale endpoint's failure must not move the restored selection",
      );
      assert.equal(at().url, URLS[0], "still on the endpoint snapback chose");
    } finally {
      Date.now = realNow;
    }
  });

  it("null counts as no endpoint named, and still steps", () => {
    /*- A guard written as `!== undefined` alone lets null through as a
     *  real provider, which can never equal the selected one — so every
     *  call returns false and that caller's failover is dead for the
     *  life of the process, silently. Both absent forms must behave
     *  like an omitted argument. */
    assert.equal(sendTx.failoverToNextRPC(null), true);
    assert.equal(at().url, URLS[1], "null must not pin the bot in place");
    assert.equal(sendTx.failoverToNextRPC(undefined), true);
    assert.equal(at().url, URLS[2]);
  });
});

/**
 * ethers double whose providers refuse `call` for the URLs in `failing`
 * and answer for the rest.
 *
 * @param {Set<string>} failing  URLs that should throw.
 * @param {object} [seen]        Collects each URL as it is called.
 */
function ethersFailing(failing, seen = { urls: [] }) {
  return {
    lib: {
      JsonRpcProvider: class {
        constructor(url) {
          this.url = url;
          this.call = async () => {
            seen.urls.push(url);
            /*- Yield once, so concurrent callers genuinely interleave
             *  here rather than running to completion one at a time. */
            await new Promise((r) => setImmediate(r));
            if (failing.has(url)) {
              throw Object.assign(new Error("502 Bad Gateway"), {
                code: "SERVER_ERROR",
              });
            }
            return `ok:${url}`;
          };
        }
      },
    },
    seen,
  };
}

describe("concurrent reads through the managed provider", () => {
  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });
  afterEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  it("eight reads failing together on one endpoint cost one endpoint", async () => {
    /*- The production shape, driven through the real proxy and the real
     *  retry loop rather than by calling failover directly: every read
     *  is holding the first provider when it fails, and they interleave
     *  at the await inside `call`. */
    const { lib, seen } = ethersFailing(new Set([URLS[0]]));
    sendTx.init({ urls: URLS }, lib);
    const p = sendTx.getManagedReadProvider();

    const out = await Promise.all(
      Array.from({ length: 8 }, () => p.call({ to: "0x0" })),
    );

    assert.deepEqual(
      [...new Set(out)],
      [`ok:${URLS[1]}`],
      "every read succeeded on the SECOND endpoint",
    );
    assert.equal(
      sendTx.getCurrentRPC().url,
      URLS[1],
      "selection advanced exactly one endpoint",
    );
    assert.equal(
      seen.urls.includes(URLS[2]),
      false,
      "the third endpoint was never asked — it never failed",
    );
    assert.equal(
      rpcQueue.haltRemainingMs(),
      0,
      "no hour-long pause from one endpoint blinking",
    );
  });

  it("still reaches the pause when every endpoint refuses", async () => {
    /*- Idempotence must not cost the genuine outage its halt.  One read
     *  is enough to walk all three; it then parks in the queue, which is
     *  why this asserts on the halt rather than awaiting the read. */
    const { lib } = ethersFailing(new Set(URLS));
    sendTx.init({ urls: URLS }, lib);
    const p = sendTx.getManagedReadProvider();

    p.call({ to: "0x0" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(
      rpcQueue.haltRemainingMs() > 0,
      "three genuinely dead endpoints DO exhaust the list and pause",
    );
  });
});

describe("the retry loop reports the endpoint it actually used", () => {
  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });
  afterEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  it("names each attempt's own provider, not the first one", async () => {
    /*- Without this the loop would keep reporting the provider it
     *  started on, so every later report would be spent and the list
     *  would never advance past the second endpoint. */
    const { retryRead } = require("../src/rpc-read-retry");
    const providers = [{ id: 0 }, { id: 1 }, { id: 2 }];
    let idx = 0;
    const reported = [];
    let calls = 0;

    const failoverErr = Object.assign(new Error("boom"), {
      code: "SERVER_ERROR",
    });
    for (const p of providers) {
      p.call = async () => {
        calls++;
        /*- The third provider answers; the first two refuse. */
        if (p.id < 2) throw failoverErr;
        return "ok";
      };
    }

    const out = await retryRead({
      prop: "call",
      args: [{}],
      err: failoverErr,
      isFailoverable: (e) => e.code === "SERVER_ERROR",
      failover: (failed) => {
        reported.push(failed);
        if (idx < providers.length - 1) idx++;
        return true;
      },
      current: () => providers[idx],
      failedProvider: providers[0],
    });

    assert.equal(out, "ok");
    assert.equal(calls, 2, "attempted the second, then the third");
    assert.deepEqual(
      reported.map((p) => (p === undefined ? "—" : p.id)),
      [0, 1],
      "each report names the provider that attempt used",
    );
  });
});
