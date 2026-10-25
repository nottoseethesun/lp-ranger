"use strict";

/**
 * @file test/failed-move-step-gas.test.js
 * @description The gas each step of a rebalance or compound paid travels
 *   with the outcome, including the steps that confirmed before a later
 *   one failed.
 *
 *   A rebalance is a drain, a swap, approvals and a mint; a compound a
 *   collect, approvals and a deposit. Each step that confirmed was mined
 *   and paid for, whatever happens after it. Before, a step that failed
 *   took only its own gas with it, if any, so the approvals before a
 *   reverted mint, the drain before a failed mint, and the collect before
 *   a failed deposit went unrecorded. Each case here gives every
 *   transaction a receipt with its own gas, fails a later step, and
 *   checks the failure carries the sum.
 *
 *   `carryingGas` (src/lib/spent-gas.js) is the piece the steps share.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const logModule = require("../src/lib/log");
const { carryingGas, spentGasOf } = require("../src/lib/spent-gas");
const { mintPosition, executeRebalance } = require("../src/lib/rebalancer");
const { swapViaRouter } = require("../src/lib/rebalancer-router");
const {
  ADDR,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
  makeMintTx,
} = require("./helpers/rebalancer-mocks");
const {
  initSendTx,
  resetSendTx,
  withPopulate,
  POPULATED,
} = require("./helpers/send-tx-mock");
const { executeCompound } = require("../src/lib/compounder");

/** A transaction whose receipt says it used `gasUsed` at a gas price of 1. */
const paid = (hash, gasUsed) => ({
  wait: async () => ({ hash, logs: [], gasUsed, gasPrice: 1n, status: 1 }),
});

/** A transaction mined and reverted, as ethers' wait reports one. */
const reverted = (hash, gasUsed) => ({
  wait: async () => {
    const e = new Error("transaction execution reverted");
    e.code = "CALL_EXCEPTION";
    e.receipt = { hash, logs: [], gasUsed, gasPrice: 1n, status: 0 };
    throw e;
  },
});

/** A mint whose receipt carries both its event and its gas. */
function paidMint(gasUsed) {
  const tx = makeMintTx("0xmint");
  return {
    wait: async () => ({
      ...(await tx.wait()),
      gasUsed,
      gasPrice: 1n,
      status: 1,
    }),
  };
}

const MINT_ARGS = {
  positionManagerAddress: ADDR.pm,
  token0: ADDR.token0,
  token1: ADDR.token1,
  fee: 3000,
  tickLower: -600,
  tickUpper: 600,
  amount0Desired: 1000000n,
  amount1Desired: 1000000n,
  recipient: ADDR.signer,
};

/** Dispatch whose approvals pay 100 and 200. */
function approvalsPaying() {
  const d = defaultDispatch();
  d[ADDR.token0] = {
    ...d[ADDR.token0],
    approve: async () => paid("0xapprove0", 100n),
  };
  d[ADDR.token1] = {
    ...d[ADDR.token1],
    approve: async () => paid("0xapprove1", 200n),
  };
  return d;
}

let restoreLog;
beforeEach(() => {
  restoreLog = logModule._setSinkForTests({
    log: () => {},
    warn: () => {},
    error: () => {},
  });
});
afterEach(() => {
  restoreLog();
  resetSendTx();
});

describe("carryingGas", () => {
  it("hands back the work's answer untouched", async () => {
    assert.equal(await carryingGas(5n, async () => "done"), "done");
  });

  it("adds the gas to the error the work throws", async () => {
    const err = Object.assign(new Error("boom"), { gasCostWei: 3n });
    await assert.rejects(
      carryingGas(5n, async () => {
        throw err;
      }),
      (thrown) => thrown === err && spentGasOf(thrown) === 8n,
    );
  });
});

describe("mintPosition", () => {
  it("counts both approvals into a minted result's gas", async () => {
    const d = approvalsPaying();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => paidMint(400n) };
    const r = await mintPosition(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      MINT_ARGS,
    );
    assert.equal(r.gasCostWei, 700n);
  });

  it("carries the approvals' gas on a mint that reverted", async () => {
    const d = approvalsPaying();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => reverted("0xmint", 400n) };
    await assert.rejects(
      mintPosition(
        mockSigner(),
        buildMockEthersLib({ contractDispatch: d }),
        MINT_ARGS,
      ),
      (err) => {
        assert.equal(err.code, "CALL_EXCEPTION");
        assert.equal(err.gasCostWei, 700n);
        return true;
      },
    );
  });

  it("carries the mint's and approvals' gas when its receipt names no new NFT", async () => {
    // Mined and paid for, but with no IncreaseLiquidity event to read.
    const d = approvalsPaying();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => paid("0xmint", 400n) };
    await assert.rejects(
      mintPosition(
        mockSigner(),
        buildMockEthersLib({ contractDispatch: d }),
        MINT_ARGS,
      ),
      (err) => {
        assert.match(err.message, /no tokenId was returned/);
        assert.equal(err.gasCostWei, 700n);
        return true;
      },
    );
  });
});

/** A position to rebalance, as the mocks know it. */
const REBALANCE_OPTS = {
  position: {
    tokenId: 1n,
    token0: ADDR.token0,
    token1: ADDR.token1,
    fee: 3000,
    liquidity: 5000n,
    tickLower: -600,
    tickUpper: 600,
  },
  factoryAddress: ADDR.factory,
  positionManagerAddress: ADDR.pm,
  swapRouterAddress: ADDR.router,
};

describe("executeRebalance", () => {
  it("reports the drain's gas when it collected nothing", async () => {
    /*-
     *  The drain was mined and paid for, but the wallet's balances did
     *  not move, so the rebalance stops before an empty mint.
     */
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      multicall: async () => paid("0xmulticall", 300n),
    };
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      REBALANCE_OPTS,
    );
    assert.equal(r.success, false);
    assert.match(r.error, /Collected 0 tokens/);
    assert.equal(r.gasCostWei, 300n);
  });

  it("reports the drain's gas when the mint after it fails", async () => {
    const d = defaultDispatch();
    const collect = d[ADDR.pm].collect;
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      /*-
       *  The drain goes out as one multicall. Running the collect mock
       *  turns the wallet's balances to what it would hold afterwards.
       */
      multicall: async () => {
        await collect();
        return paid("0xmulticall", 300n);
      },
      mint: async () => reverted("0xmint", 400n),
    };
    const r = await executeRebalance(
      mockSigner(),
      buildMockEthersLib({ contractDispatch: d }),
      {
        position: {
          tokenId: 1n,
          token0: ADDR.token0,
          token1: ADDR.token1,
          fee: 3000,
          liquidity: 5000n,
          tickLower: -600,
          tickUpper: 600,
        },
        factoryAddress: ADDR.factory,
        positionManagerAddress: ADDR.pm,
        swapRouterAddress: ADDR.router,
      },
    );
    assert.equal(r.success, false);
    assert.equal(r.gasCostWei, 300n + 400n);
  });
});

describe("executeCompound", () => {
  /** A collect whose receipt says it used 10 gas at a price of 1. */
  const collectTx = {
    hash: "0xcollect",
    nonce: 1,
    type: 2,
    wait: async () => ({
      hash: "0xcollect",
      gasUsed: 10n,
      gasPrice: 1n,
      blockNumber: 1,
      logs: [],
      status: 1,
    }),
  };

  /** A position manager and tokens, the deposit doing as `deposit` says. */
  function compoundLib({ balances, deposit }) {
    let balanceCalls = 0;
    return {
      /*-
       *  `runner` as ethers v6 keeps it: the approvals send through the
       *  signer a token contract was built with.
       */
      Contract: function (_address, _abi, runner) {
        return {
          runner,
          interface: { encodeFunctionData: () => "0x" },
          collect: withPopulate(async () => collectTx, POPULATED),
          balanceOf: async () => {
            balanceCalls++;
            return balances(balanceCalls);
          },
          allowance: async () => 0n,
          approve: withPopulate(
            async () => ({
              hash: "0xapprove",
              nonce: 2,
              type: 2,
              wait: async () => ({ gasUsed: 20n, gasPrice: 1n, status: 1 }),
            }),
            POPULATED,
          ),
          increaseLiquidity: withPopulate(deposit, POPULATED),
        };
      },
    };
  }

  const signer = (sends) => ({
    provider: { getFeeData: async () => ({ gasPrice: 1n }) },
    getAddress: async () => "0x1234567890123456789012345678901234567890",
    sendTransaction: sends,
  });

  const OPTS = {
    positionManagerAddress: "0xPM",
    tokenId: "123",
    token0: "0xA",
    token1: "0xB",
    recipient: "0x1234567890123456789012345678901234567890",
    decimals0: 8,
    decimals1: 8,
    price0: 0.001,
    price1: 0.001,
    trigger: "manual",
  };

  beforeEach(() => initSendTx());

  it("carries the collect's gas when reading what it collected fails", async () => {
    await assert.rejects(
      executeCompound(
        signer(async () => collectTx),
        compoundLib({
          balances: (calls) => {
            if (calls <= 2) return 0n;
            throw new Error("balance read failed");
          },
          deposit: async () => assert.fail("never reached"),
        }),
        OPTS,
      ),
      (err) => {
        assert.match(err.message, /balance read failed/);
        assert.equal(err.gasCostWei, 10n);
        return true;
      },
    );
  });

  it("reports the collect's gas when it found no fees to put back", async () => {
    const r = await executeCompound(
      signer(async () => collectTx),
      compoundLib({ balances: () => 0n, deposit: async () => assert.fail() }),
      OPTS,
    );
    assert.equal(r.compounded, false);
    assert.equal(r.reason, "no_fees");
    assert.equal(r.gasCostWei, 10n);
  });

  it("carries the collect's and approvals' gas on a deposit that reverted", async () => {
    /*-
     *  The mock requests all populate alike, so the sends are told apart
     *  by order: the collect, the two approvals, then the deposit.
     */
    const approveTx = {
      hash: "0xapprove",
      nonce: 2,
      type: 2,
      wait: async () => ({ gasUsed: 20n, gasPrice: 1n, status: 1 }),
    };
    const sent = [
      collectTx,
      approveTx,
      approveTx,
      reverted("0xincrease", 300n),
    ];
    let n = 0;
    const lib = compoundLib({
      // Nothing before the collect, then fees on both sides.
      balances: (calls) => (calls <= 2 ? 0n : 50_000_000n),
      deposit: async () => assert.fail("sent through the signer"),
    });
    await assert.rejects(
      executeCompound(
        signer(async () => sent[n++]),
        lib,
        OPTS,
      ),
      (err) => {
        assert.equal(err.code, "CALL_EXCEPTION");
        assert.equal(err.gasCostWei, 10n + 20n + 20n + 300n);
        return true;
      },
    );
    assert.equal(n, 4, "collect, two approvals, the deposit");
  });
});

describe("swapViaRouter", () => {
  it("carries the approval's gas when the quote after it is refused", async () => {
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      approve: async () => paid("0xapprove0", 150n),
    };
    d[ADDR.router] = {
      exactInputSingle: Object.assign(async () => paid("0xswap", 1n), {
        staticCall: async () => {
          throw new Error("execution reverted: SPL");
        },
      }),
    };
    await assert.rejects(
      swapViaRouter(
        mockSigner(),
        buildMockEthersLib({ contractDispatch: d }),
        {
          swapRouterAddress: ADDR.router,
          tokenIn: ADDR.token0,
          tokenOut: ADDR.token1,
          fee: 3000,
          amountIn: 1000n,
          slippagePct: 0.5,
          currentPrice: 1,
          decimalsIn: 18,
          decimalsOut: 18,
          isToken0To1: true,
          recipient: ADDR.signer,
          logCtx: "test",
        },
        async (fn) => fn(),
      ),
      (err) => {
        assert.match(err.message, /Swap quote failed/);
        assert.equal(err.gasCostWei, 150n);
        return true;
      },
    );
  });
});
