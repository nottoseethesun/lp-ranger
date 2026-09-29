/**
 * @file test/rpc-failover-reach.test.js
 * @description
 * A failover has to move every read, not only the reads that ask where
 * to go.
 *
 * Endpoint selection lives in `src/send-transaction.js`, and one path
 * consults it properly: the managed read proxy, which resolves the
 * selected provider on every property access and retries a
 * failover-eligible error on the next endpoint. Two other kinds of
 * caller do not.
 *
 * `getPoolState` and the can-reopen balance walk build their own
 * provider per URL and start at `config.RPC_URLS[0]` every time, so a
 * failover does not change where they look first. Reads taken from the
 * signer — `signer.provider`, and the `signer.call` that ethers routes
 * a contract read through — resolve to the raw selected provider, which
 * carries no retry and reports nothing back, so a refusal inside a
 * rebalance or a compound both fails the move and leaves selection
 * believing the endpoint is fine.
 *
 * These tests state the invariant as an operator would: after a
 * failover, requests go to the endpoint that was selected, and a
 * refusal on it moves to the next one. Production, 2026-09-29 00:14:28,
 * shows the cost of not having them — eighteen requests to an endpoint
 * the log had just announced leaving.
 *
 * That ethers routes a signer-bound contract read through `signer.call`
 * and a `queryFilter` through `runner.provider.getLogs` is upstream
 * behaviour, measured against the pinned ethers rather than assumed;
 * the two seams are covered separately below for that reason.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/send-transaction");
const rpcQueue = require("../src/rpc-request-manager");
const config = require("../src/config");
const {
  getPoolState,
  _setRetryDelayForTests,
} = require("../src/rebalancer-pools");
const {
  createCanReopenHandler,
  _setRetryDelayForTests: _setCanReopenRetryDelay,
} = require("../src/server-can-reopen");
const { FailoverNonceManager } = require("../src/nonce-manager-wrapper");
const { condemn } = require("./helpers/send-tx-stubs");

const URLS = ["http://one.test", "http://two.test", "http://three.test"];

const FACTORY = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const TOKEN0 = "0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b";
const TOKEN1 = "0xAEbcD0F8f69ECF9587e292bdfc4d731c1abedB68";
const POOL = "0x3d3fF0F4FD039f8d94effA935678128072B72f6B";

/*- No waiting between a path's own retries.  These tests assert on the
 *  ORDER endpoints are asked in, never on how long the walk took. */
_setRetryDelayForTests(0);
_setCanReopenRetryDelay(0);

/**
 * ethers double for the pool-state walk.  Every provider records the
 * URL it was built for, and `failing` decides which of them refuse.
 *
 * @param {Set<string>} failing  URLs whose reads should throw.
 * @returns {{lib: object, asked: string[]}}  `asked` is every URL a
 *   provider was built for, in the order the walk built them.
 */
function poolStateEthers(failing = new Set()) {
  const asked = [];
  function JsonRpcProvider(url) {
    this.url = url;
    asked.push(url);
  }
  function Contract(address, _abi, provider) {
    const refuse = () => {
      if (failing.has(provider.url)) {
        throw Object.assign(new Error("502 Bad Gateway"), {
          code: "SERVER_ERROR",
        });
      }
    };
    return {
      getPool: async () => (refuse(), POOL),
      feeAmountTickSpacing: async () => (refuse(), 200),
      decimals: async () => (refuse(), address === TOKEN0 ? 8 : 18),
      slot0: async () => (
        refuse(),
        { sqrtPriceX96: 79228162514264337593543950336n, tick: 310280 }
      ),
    };
  }
  return {
    lib: {
      Contract,
      JsonRpcProvider,
      ZeroAddress: "0x0000000000000000000000000000000000000000",
    },
    asked,
  };
}

/** The options every `getPoolState` call in these tests uses. */
const POOL_OPTS = {
  factoryAddress: FACTORY,
  token0: TOKEN0,
  token1: TOKEN1,
  fee: 10000,
};

/*- `init` builds one provider per endpoint up front, so it must not
 *  share the double that records what the walk asked — those three
 *  would land in `asked` before the walk ran.  Selection is read by
 *  URL, so these providers need no behaviour at all. */
const inertEthers = { JsonRpcProvider: class {} };

describe("a failover moves the pool-state read", () => {
  let savedUrls;

  beforeEach(() => {
    savedUrls = [...config.RPC_URLS];
    config.setRpcUrls([...URLS]);
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  afterEach(() => {
    config.setRpcUrls(savedUrls);
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  it("asks the endpoint selection names, not the first in the list", async () => {
    /*- The whole defect in one assertion.  Pool state is the read the
     *  bot performs most — once per position per poll — so an endpoint
     *  it keeps asking after a failover is an endpoint the failover did
     *  not move. */
    const { lib, asked } = poolStateEthers();
    sendTx.init({ urls: URLS }, inertEthers);
    condemn(URLS[0]);
    sendTx.failoverToNextRPC();
    assert.equal(sendTx.getCurrentRPCUrl(), URLS[1], "selection moved");

    await getPoolState(null, lib, POOL_OPTS);

    assert.equal(
      asked[0],
      URLS[1],
      "the first endpoint asked must be the one selection named",
    );
    assert.equal(
      asked.includes(URLS[0]),
      false,
      "the endpoint we failed away from must not be asked at all",
    );
  });

  it("covers the rest of the list from there, wrapping, when all refuse", () => {
    /*- Starting elsewhere must not cost the walk its reach: every
     *  endpoint still gets its attempts, in list order from the
     *  selected one, and none is tried twice. */
    const { lib, asked } = poolStateEthers(new Set(URLS));
    sendTx.init({ urls: URLS }, inertEthers);
    condemn(URLS[0]);
    sendTx.failoverToNextRPC();

    return getPoolState(null, lib, POOL_OPTS).then(
      () => assert.fail("every endpoint refused — this must reject"),
      () => {
        assert.deepEqual(
          [...new Set(asked)],
          [URLS[1], URLS[2], URLS[0]],
          "the walk starts at the selected endpoint and wraps once",
        );
      },
    );
  });

  it("still starts at the first endpoint when nothing has failed over", async () => {
    /*- The ordinary case has to stay ordinary: with selection at the
     *  head of the list, the walk is exactly what it always was. */
    const { lib, asked } = poolStateEthers();
    sendTx.init({ urls: URLS }, inertEthers);

    await getPoolState(null, lib, POOL_OPTS);

    assert.equal(asked[0], URLS[0]);
  });
});

/**
 * Minimal deps for the can-reopen handler.  `readBalance` is the
 * injection point the handler already exposes, so recording the URL of
 * the provider it is handed tells us which endpoint the walk built.
 *
 * @param {object} o
 * @param {string[]} o.seen     Collects each endpoint URL, in order.
 * @param {boolean} [o.refuse]  Make every read throw.
 * @returns {object} deps for `createCanReopenHandler`.
 */
function canReopenDeps({ seen, refuse = false }) {
  return {
    walletManager: { getAddress: () => "0x" + "1".repeat(40) },
    jsonResponse: (res, status, body) => {
      res._status = status;
      res._body = body;
    },
    readJsonBody: async () => ({ token0: TOKEN0, token1: TOKEN1 }),
    getDust: async () => ({ thresholdUsd: 1 }),
    readBalance: async ({ provider }) => {
      seen.push(provider._getConnection().url);
      if (refuse) throw new Error("simulated RPC outage");
      return {
        symbol: "X",
        decimals: 18,
        raw: "1000000000000000000000",
        amount: 1000,
        usd: 5000,
        isDust: false,
      };
    },
  };
}

describe("a failover moves the can-reopen balance read", () => {
  let savedUrls;

  beforeEach(() => {
    savedUrls = [...config.RPC_URLS];
    config.setRpcUrls([...URLS]);
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  afterEach(() => {
    config.setRpcUrls(savedUrls);
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  it("asks the endpoint selection names, not the first in the list", async () => {
    /*- Same defect, second site.  This one is a server route rather
     *  than a poll, so it costs an operator a wrong answer rather than
     *  a wasted request: the Can-Reopen check reports on balances read
     *  from an endpoint the bot has already given up on. */
    const seen = [];
    sendTx.init({ urls: URLS }, { JsonRpcProvider: class {} });
    condemn(URLS[0]);
    sendTx.failoverToNextRPC();

    const handler = createCanReopenHandler(canReopenDeps({ seen }));
    const res = {};
    await handler({}, res);

    assert.equal(res._status, 200, "the read itself succeeded");
    assert.equal(
      seen[0],
      URLS[1],
      "the first endpoint asked must be the one selection named",
    );
  });
});

/**
 * ethers double whose providers refuse `call` for the URLs in
 * `failing`.  Shared by the signer tests below; `failing` is read on
 * every call, so a test can change an endpoint's health mid-run.
 *
 * @param {Set<string>} failing  URLs that should throw.
 * @returns {object} an ethers-shaped library.
 */
function callingEthers(failing) {
  return {
    JsonRpcProvider: class {
      constructor(url) {
        this.url = url;
        this.call = async () => {
          await new Promise((r) => setImmediate(r));
          if (failing.has(url)) {
            throw Object.assign(new Error("502 Bad Gateway"), {
              code: "SERVER_ERROR",
            });
          }
          return `ok:${url}`;
        };
        this.getLogs = async () => {
          if (failing.has(url)) {
            throw Object.assign(new Error("502 Bad Gateway"), {
              code: "SERVER_ERROR",
            });
          }
          return [`logs:${url}`];
        };
      }
    },
  };
}

/** A wallet double: `connect` is all `FailoverNonceManager._sync` uses. */
const fakeWallet = () => ({
  connect: (provider) => ({ provider }),
});

/**
 * NonceManager double shaped like the real one's read surface: ethers'
 * `AbstractSigner.call` goes to the signer's provider, which is what
 * makes the raw provider reachable from a contract read.
 */
const nonceManagerLib = {
  NonceManager: class {
    constructor(wallet) {
      this.signer = wallet;
      this.provider = wallet.provider;
    }
    /*- ethers fills `from` here before a view call; the real one needs
     *  no network to do it, and neither does this. */
    async populateCall(tx) {
      return { from: "0x" + "1".repeat(40), ...tx };
    }
    async call(tx) {
      return this.provider.call(tx);
    }
  },
};

describe("a failover moves the reads taken from the signer", () => {
  beforeEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  afterEach(() => {
    sendTx._resetForTests();
    rpcQueue._resetForTests();
  });

  it("retries a contract read on the next endpoint and reports the refusal", async () => {
    /*- `signer.call` is the seam ethers routes a signer-bound contract
     *  read through, measured against the pinned ethers.  It is how
     *  every balance, allowance and `positions()` read inside a
     *  rebalance or compound reaches the chain, so a refusal here has
     *  to behave like a refusal anywhere else: move to the next
     *  endpoint, and say so. */
    const failing = new Set([URLS[0]]);
    sendTx.init({ urls: URLS }, callingEthers(failing));
    const nm = new FailoverNonceManager(fakeWallet(), {
      ethersLib: nonceManagerLib,
    });

    assert.equal(
      await nm.call({ to: "0x0" }),
      `ok:${URLS[1]}`,
      "the read recovered on the next endpoint",
    );
    assert.equal(
      sendTx.getCurrentRPC().url,
      URLS[1],
      "and the refusal was reported, so every other caller follows",
    );
  });

  it("retries a queryFilter read on the next endpoint", async () => {
    /*- The other seam: ethers resolves a contract's `queryFilter`
     *  through `runner.provider`, so the signer's provider carries the
     *  event scans as well as the calls. */
    const failing = new Set([URLS[0]]);
    sendTx.init({ urls: URLS }, callingEthers(failing));
    const nm = new FailoverNonceManager(fakeWallet(), {
      ethersLib: nonceManagerLib,
    });

    assert.deepEqual(await nm.provider.getLogs({}), [`logs:${URLS[1]}`]);
  });

  it("follows a failover that happens after the provider was taken", async () => {
    /*- Eleven call sites resolve `signer.provider || signer` once at
     *  the top of an operation and hold it.  A rebalance runs long
     *  enough for selection to move underneath it, and the held
     *  provider has to move with it rather than keep addressing the
     *  endpoint that was selected when the operation started. */
    sendTx.init({ urls: URLS }, callingEthers(new Set()));
    const nm = new FailoverNonceManager(fakeWallet(), {
      ethersLib: nonceManagerLib,
    });
    const held = nm.provider;

    condemn(URLS[0]);
    sendTx.failoverToNextRPC();

    assert.equal(
      await held.call({ to: "0x0" }),
      `ok:${URLS[1]}`,
      "a held provider addresses the endpoint selected NOW",
    );
  });
});
