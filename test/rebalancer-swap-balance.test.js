"use strict";

/**
 * @file test/rebalancer-swap-balance.test.js
 * @description The balance read after a swap has landed
 *   (src/rebalancer-swap-balance.js).
 *
 *   The swap behind that read cannot be undone, so a failed read must
 *   neither end on the first endpoint's say-so nor let `swapIfNeeded`
 *   swap the same balance again through the V3 router. The user,
 *   2026-10-17: "First of all, the rpc-endpoint failover should engage.
 *   If they all fail, then yes, it should work as you made it, with the
 *   stop that you added there." These cases ask the read of the app's
 *   real endpoint selection, stood up over stub providers, and one of
 *   them drives the whole aggregator route through `swapIfNeeded`.
 */

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const sendTx = require("../src/send-transaction");
const {
  balanceDiff,
  _setLandedReadDelayForTests,
} = require("../src/rebalancer-swap-balance");
const { swapIfNeeded } = require("../src/rebalancer-swap");
const { swapViaRouter } = require("../src/rebalancer-router");
const { readBotConfigDefaults } = require("../src/bot-config-defaults");
const { spentGasOf } = require("../src/spent-gas");
const { initSendTx, resetSendTx } = require("./helpers/send-tx-mock");
const { ADDR, ONE_ETH } = require("./helpers/rebalancer-mocks");

const URLS = ["http://first.test", "http://second.test", "http://third.test"];
const BUDGET =
  URLS.length * readBotConfigDefaults().boundedReadAttemptsPerEndpoint;

/** The error an endpoint gives when it answers with an error body. */
const errorBody = () =>
  Object.assign(new Error("could not coalesce error"), {
    code: "UNKNOWN_ERROR",
  });

/*-
 *  The provider the read before the swap is asked of: the signer's, as
 *  both swap routes hand it in. The aggregator route also asks it for
 *  the gas price, and, when a swap stalls, for receipts.
 */
const BEFORE = {
  getFeeData: async () => ({ gasPrice: 1_000_000_000n }),
  getTransactionReceipt: async () => null,
};

/**
 * An ethers stand-in whose token contract answers `balanceOf` by the
 * provider it was built over: `BEFORE` gives `beforeBalance`, and each
 * endpoint gives what `afterBy[url]` says, a figure or an error.
 */
function tokenLib({ beforeBalance, afterBy, asked }) {
  return {
    Contract: class {
      constructor(_address, _abi, runner) {
        this.runner = runner;
      }
      async balanceOf() {
        if (this.runner === BEFORE) return beforeBalance;
        const url = sendTx.urlOf(this.runner);
        asked.push(url);
        const answer = afterBy[url];
        if (answer instanceof Error) throw answer;
        return answer;
      }
    },
  };
}

/** A landed swap's result, with the gas it paid. */
const landed = () => ({ txHash: "0xswap", gasCostWei: 21_000n });

before(() => _setLandedReadDelayForTests(0));

beforeEach(() => {
  resetSendTx();
  initSendTx(URLS);
});

afterEach(() => resetSendTx());

describe("balanceDiff — the read after a landed swap", () => {
  it("asks another endpoint when one answers with an error", async () => {
    const asked = [];
    const lib = tokenLib({
      beforeBalance: 1000n,
      afterBy: { [URLS[0]]: errorBody(), [URLS[1]]: 1500n, [URLS[2]]: 1500n },
      asked,
    });
    const r = await balanceDiff(
      lib,
      ADDR.token1,
      ADDR.signer,
      BEFORE,
      async () => landed(),
    );
    assert.equal(r.amountOut, 500n);
    assert.equal(r.txHash, "0xswap");
    assert.deepEqual(asked, [URLS[0], URLS[1]]);
  });

  it("stops only once every endpoint has failed, marked swapLanded with the swap's gas", async () => {
    const asked = [];
    const lib = tokenLib({
      beforeBalance: 1000n,
      afterBy: Object.fromEntries(URLS.map((u) => [u, errorBody()])),
      asked,
    });
    await assert.rejects(
      () =>
        balanceDiff(lib, ADDR.token1, ADDR.signer, BEFORE, async () =>
          landed(),
        ),
      (err) => {
        assert.equal(err.swapLanded, true);
        assert.equal(spentGasOf(err), 21_000n);
        return true;
      },
    );
    assert.equal(asked.length, BUDGET, "the whole budget was spent");
    for (const url of URLS)
      assert.ok(asked.includes(url), `${url} was asked before the stop`);
  });

  it("does not mark a failure before the swap, which has not happened", async () => {
    let swapped = false;
    const lib = {
      Contract: class {
        async balanceOf() {
          throw errorBody();
        }
      },
    };
    await assert.rejects(
      () =>
        balanceDiff(lib, ADDR.token1, ADDR.signer, BEFORE, async () => {
          swapped = true;
          return landed();
        }),
      (err) => err.swapLanded === undefined,
    );
    assert.equal(swapped, false);
  });
});

describe("swapIfNeeded — a landed aggregator swap whose read fails everywhere", () => {
  it("sends no second swap through the V3 router", async () => {
    /*-
     *  TEST-ONLY global swap: the aggregator's quote is asked through the
     *  global fetch, with no seam for another. Put back pristine in the
     *  `finally` below.
     */
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        to: ADDR.router,
        data: "0xdeadbeef",
        value: "0",
        gas: "500000",
        gasPrice: "1000000000",
        buyAmount: "1000",
        estimatedPriceImpact: "0",
        allowanceTarget: ADDR.router,
        sources: [],
      }),
    });
    const sends = [];
    const receipt = {
      status: 1,
      hash: "0xswap",
      blockNumber: 1,
      gasUsed: 100_000n,
      gasPrice: 1_000_000_000n,
    };
    const signer = {
      getAddress: async () => ADDR.signer,
      sendTransaction: async (req) => {
        sends.push(req);
        return { hash: "0xswap", nonce: 7, wait: async () => receipt };
      },
      provider: BEFORE,
    };
    const asked = [];
    const lib = tokenLib({
      beforeBalance: 0n,
      afterBy: Object.fromEntries(URLS.map((u) => [u, errorBody()])),
      asked,
    });
    lib.Contract.prototype.allowance = async () => 2n ** 255n;
    try {
      await assert.rejects(
        () =>
          swapIfNeeded(signer, lib, {
            amountIn: ONE_ETH,
            tokenIn: ADDR.token0,
            tokenOut: ADDR.token1,
            recipient: ADDR.signer,
            swapRouterAddress: ADDR.router,
            slippagePct: 1,
            fee: 3000,
          }),
        (err) => {
          assert.equal(err.swapLanded, true);
          return true;
        },
      );
      assert.equal(sends.length, 1, "the aggregator swap, and no other");
      assert.equal(asked.length, BUDGET);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("the approval's gas on a landed swap whose read fails everywhere", () => {
  /*-
   *  The read's error carries the swap's own gas, and the route adds the
   *  approval it paid before the swap. Counted inside the swap as well,
   *  it was counted twice. One approval here is 46000 gas and one swap
   *  100000, both at one gwei.
   */
  const GWEI = 1_000_000_000n;
  const APPROVAL = 46_000n * GWEI;
  const SWAP = 100_000n * GWEI;
  const APPROVE_DATA = "0x095ea7b3";

  /** A signer whose approval and swap each confirm, at their own gas. */
  function paying(sends) {
    return {
      getAddress: async () => ADDR.signer,
      provider: BEFORE,
      sendTransaction: async (req) => {
        sends.push(req);
        const approve = req.data === APPROVE_DATA;
        const hash = approve ? "0xapprove" : "0xswap";
        const receipt = {
          status: 1,
          hash,
          blockNumber: 1,
          gasUsed: approve ? 46_000n : 100_000n,
          gasPrice: GWEI,
        };
        return { hash, nonce: sends.length, wait: async () => receipt };
      },
    };
  }

  /**
   * An ethers stand-in for both routes: no allowance yet, so an approval
   * is sent; the router quotes; and the balance read after the swap
   * fails on every endpoint.
   */
  function contracts(asked) {
    return {
      Contract: class {
        constructor(address, _abi, runner) {
          this.runner = runner;
          this.approve = {
            populateTransaction: async () => ({
              to: address,
              data: APPROVE_DATA,
              gasLimit: 60_000n,
            }),
          };
          this.exactInputSingle = {
            staticCall: async () => 990n,
            populateTransaction: async () => ({
              to: address,
              data: "0x414bf389",
              gasLimit: 300_000n,
            }),
          };
        }
        async allowance() {
          return 0n;
        }
        async balanceOf() {
          if (this.runner === BEFORE) return 0n;
          asked.push(sendTx.urlOf(this.runner));
          throw errorBody();
        }
      },
    };
  }

  it("counts it once through the V3 router", async () => {
    const sends = [];
    const asked = [];
    await assert.rejects(
      () =>
        swapViaRouter(
          paying(sends),
          contracts(asked),
          {
            swapRouterAddress: ADDR.router,
            tokenIn: ADDR.token0,
            tokenOut: ADDR.token1,
            fee: 3000,
            amountIn: 1000n,
            slippagePct: 2,
            currentPrice: 1,
            decimalsIn: 18,
            decimalsOut: 18,
            isToken0To1: true,
            recipient: ADDR.signer,
            logCtx: "test",
          },
          balanceDiff,
        ),
      (err) => {
        assert.equal(err.swapLanded, true);
        assert.equal(spentGasOf(err), APPROVAL + SWAP);
        return true;
      },
    );
    assert.equal(sends.length, 2, "the approval, then the swap");
    assert.equal(asked.length, BUDGET);
  });

  it("counts it once through the aggregator", async () => {
    /*-
     *  TEST-ONLY global swap: the aggregator's quote is asked through the
     *  global fetch, with no seam for another. Put back pristine in the
     *  `finally` below.
     */
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        to: ADDR.router,
        data: "0xdeadbeef",
        value: "0",
        gas: "500000",
        gasPrice: "1000000000",
        buyAmount: "1000",
        estimatedPriceImpact: "0",
        allowanceTarget: ADDR.router,
        sources: [],
      }),
    });
    const sends = [];
    const asked = [];
    try {
      await assert.rejects(
        () =>
          swapIfNeeded(paying(sends), contracts(asked), {
            amountIn: ONE_ETH,
            tokenIn: ADDR.token0,
            tokenOut: ADDR.token1,
            recipient: ADDR.signer,
            swapRouterAddress: ADDR.router,
            slippagePct: 1,
            fee: 3000,
          }),
        (err) => {
          assert.equal(err.swapLanded, true);
          assert.equal(spentGasOf(err), APPROVAL + SWAP);
          return true;
        },
      );
      assert.equal(sends.length, 2, "the approval, then the aggregator swap");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
