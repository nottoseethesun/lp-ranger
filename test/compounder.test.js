/**
 * @file test/compounder.test.js
 * @description Tests for the compound execution logic.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  initSendTx: _initSendTx,
  resetSendTx: _resetSendTx,
  withPopulate: _withPopulate,
  POPULATED: _POPULATED,
} = require("./helpers/send-tx-mock");

describe("compounder", () => {
  describe("_parseIncreaseLiquidity", () => {
    // Access the internal via module — the function is used by addLiquidity
    // but not directly exported; test indirectly through executeCompound mock

    it("module exports all expected functions", () => {
      const mod = require("../src/compounder");
      assert.equal(typeof mod.collectFees, "function");
      assert.equal(typeof mod.addLiquidity, "function");
      assert.equal(typeof mod.executeCompound, "function");
      assert.equal(typeof mod.detectCompoundsOnChain, "function");
      assert.equal(typeof mod.scanNftEvents, "function");
      assert.equal(typeof mod.classifyCompounds, "function");
      assert.equal(typeof mod._filterRebalances, "function");
    });
  });

  describe("executeCompound", () => {
    beforeEach(() => _initSendTx());
    afterEach(() => _resetSendTx());

    it("returns compounded:false when no fees collected", async () => {
      const { executeCompound } = require("../src/compounder");

      const _collectTx = {
        hash: "0xtest",
        nonce: 1,
        type: 2,
        wait: async () => ({
          hash: "0xtest",
          gasUsed: 100000n,
          gasPrice: 1000000n,
          effectiveGasPrice: 1000000n,
          blockNumber: 1,
          logs: [],
        }),
      };

      const mockPm = {
        interface: { encodeFunctionData: () => "0x" },
        collect: _withPopulate(async () => _collectTx, _POPULATED),
      };

      const mockSigner = {
        provider: {
          getTransactionReceipt: async () => null,
          getFeeData: async () => ({
            gasPrice: 1000000n,
            maxFeePerGas: 2000000n,
            maxPriorityFeePerGas: 100000n,
          }),
        },
        getAddress: async () => "0x1234567890123456789012345678901234567890",
        sendTransaction: async () => _collectTx,
      };

      const mockEthers = {
        Contract: function () {
          return {
            ...mockPm,
            balanceOf: async () => 0n,
            allowance: async () => 0n,
            approve: _withPopulate(
              async () => ({
                hash: "0xapprove",
                nonce: 2,
                type: 2,
                wait: async () => ({ gasUsed: 50000n, gasPrice: 1000000n }),
              }),
              _POPULATED,
            ),
            increaseLiquidity: _withPopulate(
              async () => ({
                hash: "0xincrease",
                nonce: 3,
                type: 2,
                wait: async () => ({
                  hash: "0xincrease",
                  gasUsed: 200000n,
                  gasPrice: 1000000n,
                  effectiveGasPrice: 1000000n,
                  blockNumber: 2,
                  logs: [],
                }),
              }),
              _POPULATED,
            ),
          };
        },
      };

      const result = await executeCompound(mockSigner, mockEthers, {
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
      });

      assert.equal(result.compounded, false);
      assert.equal(result.reason, "no_fees");
    });
  });

  describe("compound config keys", () => {
    it("POSITION_KEYS includes compound fields", () => {
      const { POSITION_KEYS } = require("../src/bot-config-keys");
      assert.ok(POSITION_KEYS.includes("autoCompoundEnabled"));
      assert.ok(POSITION_KEYS.includes("autoCompoundThresholdUsd"));
      assert.ok(POSITION_KEYS.includes("compoundHistory"));
      /*- Coins, not a dollar total: the saved figure is priced wherever
       *  it is shown. */
      assert.ok(POSITION_KEYS.includes("compoundedAmount0"));
      assert.ok(POSITION_KEYS.includes("compoundedAmount1"));
      assert.ok(!POSITION_KEYS.includes("totalCompoundedUsd"));
      assert.ok(POSITION_KEYS.includes("lastCompoundAt"));
    });

    it("COMPOUND_MIN_FEE_USD is defined in config", () => {
      const config = require("../src/config");
      assert.equal(typeof config.COMPOUND_MIN_FEE_USD, "number");
      assert.ok(config.COMPOUND_MIN_FEE_USD > 0);
    });

    it("COMPOUND_DEFAULT_THRESHOLD_USD is defined in config", () => {
      const config = require("../src/config");
      assert.equal(typeof config.COMPOUND_DEFAULT_THRESHOLD_USD, "number");
      assert.ok(
        config.COMPOUND_DEFAULT_THRESHOLD_USD >= config.COMPOUND_MIN_FEE_USD,
      );
    });
  });

  describe("collectFees with mocked contract", () => {
    beforeEach(() => _initSendTx());
    afterEach(() => _resetSendTx());

    it("collects fees and returns balance diff", async () => {
      const { collectFees } = require("../src/compounder");
      let callCount = 0;
      const _collectTx = {
        hash: "0xcollect",
        nonce: 1,
        type: 2,
        wait: async () => ({
          hash: "0xcollect",
          gasUsed: 100000n,
          gasPrice: 1000n,
          effectiveGasPrice: 1000n,
          blockNumber: 10,
          logs: [],
        }),
      };
      const mockSigner = {
        provider: {
          getFeeData: async () => ({
            gasPrice: 1000n,
            maxFeePerGas: 2000n,
            maxPriorityFeePerGas: 100n,
          }),
        },
        getAddress: async () => "0xWallet",
        sendTransaction: async () => _collectTx,
      };
      const mockEthers = {
        Contract: function (_addr, _abi, _s) {
          return {
            collect: _withPopulate(async () => _collectTx, _POPULATED),
            balanceOf: async () => {
              callCount++;
              return callCount <= 2 ? 1000n : 1500n; // before=1000, after=1500
            },
          };
        },
      };
      const result = await collectFees(mockSigner, mockEthers, {
        positionManagerAddress: "0xPM",
        tokenId: "100",
        token0: "0xA",
        token1: "0xB",
        recipient: "0xWallet",
      });
      assert.equal(result.amount0, 500n);
      assert.equal(result.amount1, 500n);
      assert.equal(result.txHash, "0xcollect");
    });
  });
  describe("addLiquidity with mocked contract", () => {
    beforeEach(() => _initSendTx());
    afterEach(() => _resetSendTx());

    it("calls increaseLiquidity and returns amounts", async () => {
      const { addLiquidity } = require("../src/compounder");
      const _incTx = {
        hash: "0xinc",
        nonce: 2,
        type: 2,
        wait: async () => ({
          hash: "0xinc",
          gasUsed: 200000n,
          gasPrice: 1000n,
          effectiveGasPrice: 1000n,
          blockNumber: 11,
          logs: [], // no parseable logs — amounts default to 0
        }),
      };
      const mockSigner = {
        provider: {
          getFeeData: async () => ({
            gasPrice: 1000n,
            maxFeePerGas: 2000n,
            maxPriorityFeePerGas: 100n,
          }),
        },
        getAddress: async () => "0xWallet",
        sendTransaction: async () => _incTx,
      };
      const mockEthers = {
        Contract: function () {
          return {
            allowance: async () => 999999n,
            increaseLiquidity: _withPopulate(async () => _incTx, _POPULATED),
          };
        },
      };
      const result = await addLiquidity(mockSigner, mockEthers, {
        positionManagerAddress: "0xPM",
        tokenId: "100",
        amount0: 200n,
        amount1: 300n,
        token0: "0xA",
        token1: "0xB",
        recipient: "0xWallet",
      });
      // Without parseable IncreaseLiquidity event, defaults to 0
      assert.equal(result.liquidity, 0n);
      assert.equal(result.txHash, "0xinc");
      assert.ok(result.gasCostWei > 0n);
    });
  });

  describe("executeCompound with collected fees", () => {
    beforeEach(() => _initSendTx());
    afterEach(() => _resetSendTx());

    it("returns compounded:true with USD value when fees exist", async () => {
      const { executeCompound } = require("../src/compounder");
      let balCall = 0;
      const _collectTx = {
        hash: "0xc",
        nonce: 1,
        type: 2,
        wait: async () => ({
          hash: "0xc",
          gasUsed: 100000n,
          gasPrice: 1000n,
          effectiveGasPrice: 1000n,
          blockNumber: 1,
          logs: [],
        }),
      };
      /*- A receipt carrying a real IncreaseLiquidity log, so the deposited
       *  amounts are the ones the event reports rather than the zeros an
       *  empty `logs` array yields. Zeros make every downstream figure
       *  zero, and an assertion on zero cannot tell a working scaling
       *  from a broken one.
       *
       *  `_parseIncreaseLiquidity` only attempts a log with two topics
       *  and at least 130 hex characters of data, so the shape matters
       *  even though the mock interface ignores the contents. */
      const _incTx = {
        hash: "0xi",
        nonce: 2,
        type: 2,
        wait: async () => ({
          hash: "0xi",
          gasUsed: 200000n,
          gasPrice: 1000n,
          effectiveGasPrice: 1000n,
          blockNumber: 2,
          logs: [
            {
              topics: ["0x" + "1".repeat(64), "0x" + "2".repeat(64)],
              data: "0x" + "0".repeat(130),
            },
          ],
        }),
      };
      const mockEthers = {
        Contract: function () {
          return {
            /*- Raw token units, deliberately unequal, and at decimals the
             *  test sets unequal too: 2 coins of an 18-decimal token and
             *  5 of a 6-decimal one. Equal amounts, equal decimals or
             *  equal prices would each let a swapped pair produce the
             *  right answer anyway. */
            interface: {
              parseLog: () => ({
                name: "IncreaseLiquidity",
                args: {
                  liquidity: 123n,
                  amount0: 2000000000000000000n,
                  amount1: 5000000n,
                },
              }),
            },
            collect: _withPopulate(async () => _collectTx, _POPULATED),
            balanceOf: async () => {
              balCall++;
              return balCall <= 2 ? 0n : 50000000n;
            },
            allowance: async () => 999999999n,
            increaseLiquidity: _withPopulate(async () => _incTx, _POPULATED),
          };
        },
      };
      /*- Two TX submits in this test (collect, then increaseLiquidity) —
          dispatch by populated.data.  The mocks set data:"0x" so we sequence
          via call count. */
      let txCount = 0;
      const mockSigner = {
        provider: {
          getFeeData: async () => ({
            gasPrice: 1000n,
            maxFeePerGas: 2000n,
            maxPriorityFeePerGas: 100n,
          }),
        },
        getAddress: async () => "0x1234",
        sendTransaction: async () => {
          txCount += 1;
          return txCount === 1 ? _collectTx : _incTx;
        },
      };
      const result = await executeCompound(mockSigner, mockEthers, {
        positionManagerAddress: "0xPM",
        tokenId: "100",
        token0: "0xA",
        token1: "0xB",
        recipient: "0x1234",
        decimals0: 18,
        decimals1: 6,
        price0: 3,
        price1: 7,
        trigger: "auto",
      });
      assert.equal(result.compounded, true);
      assert.equal(result.trigger, "auto");
      /*- Each token scaled by its OWN decimals: 2e18 at 18dp is 2 coins,
       *  5e6 at 6dp is 5. Swapping the two exponents gives 2e12 and
       *  5e-12, so this pins the pairing rather than merely the arithmetic
       *  running. */
      assert.equal(result.depositedAmount0, 2);
      assert.equal(result.depositedAmount1, 5);
      /*- 2 x $3 + 5 x $7 = 41. Every number distinct, so a swapped price
       *  pair gives 29 and a dropped side gives 6 or 35. */
      assert.equal(result.usdValue, 41);
      assert.ok(result.collectTxHash);
      assert.ok(result.depositTxHash);
    });
  });
});
