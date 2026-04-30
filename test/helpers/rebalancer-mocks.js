"use strict";
/**
 * Shared mock setup for rebalancer test suites.
 *
 * Provides addresses, helpers, mock signer/dispatch/ethersLib builders
 * used by both rebalancer.test.js and rebalancer-mint.test.js.
 *
 * sendTransaction integration: every TX-issuing dispatch method is
 * auto-wrapped with `.populateTransaction(args)` returning a populated
 * TX shape `{to, data: {__mock_method, __mock_args}, gasLimit: 200000n}`.
 * `mockSigner.sendTransaction(populated)` reads the encoded method name
 * and dispatches to the original mock function so test fixtures don't
 * need to know whether production code calls the contract method
 * directly or routes through `src/send-transaction.js`.
 */

const ADDR = {
  factory: "0xFACTORY0000000000000000000000000000000001",
  pool: "0xPOOL00000000000000000000000000000000000001",
  token0: "0xTOKEN00000000000000000000000000000000000A",
  token1: "0xTOKEN00000000000000000000000000000000000B",
  pm: "0xPM000000000000000000000000000000000000001",
  router: "0xROUTER0000000000000000000000000000000001",
  signer: "0xSIGNER0000000000000000000000000000000001",
};
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const Q96 = BigInt("0x1000000000000000000000000");
const ONE_ETH = 1_000_000_000_000_000_000n;

const INC_TOPIC =
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";

/*- Module-level registry of the most-recently-built dispatch table.
    `mockSigner.sendTransaction` reads it to route populated TXs to the
    matching contract-method mock.  Tests build one ethersLib at a time,
    so a single global slot is sufficient.  Reset by calling
    `buildMockEthersLib` again. */
let _activeDispatch = null;

function makeTx(hash) {
  return { wait: async () => ({ hash, logs: [] }) };
}

/** Make a mint tx that includes a valid IncreaseLiquidity event. */
function makeMintTx(
  hash,
  tokenId = 42n,
  liquidity = 5000n,
  amount0 = 1000n,
  amount1 = 1000n,
) {
  return {
    wait: async () => ({
      hash,
      logs: [
        {
          topics: [INC_TOPIC, "0x" + tokenId.toString(16).padStart(64, "0")],
          data:
            "0x" +
            liquidity.toString(16).padStart(64, "0") +
            amount0.toString(16).padStart(64, "0") +
            amount1.toString(16).padStart(64, "0"),
        },
      ],
    }),
  };
}

function mockSigner(address) {
  return {
    getAddress: async () => address ?? ADDR.signer,
    provider: {
      mockProvider: true,
      getFeeData: async () => ({
        gasPrice: 1000n,
        maxFeePerGas: 2000n,
        maxPriorityFeePerGas: 100n,
      }),
    },
    sendTransaction: async (populated) => {
      const data = populated && populated.data;
      const method = data && data.__mock_method;
      const args = data ? data.__mock_args : undefined;
      const methods = _activeDispatch && _activeDispatch[populated.to];
      if (!methods) {
        throw new Error(
          `mockSigner.sendTransaction: no dispatch for ${populated.to}`,
        );
      }
      const fn = methods[method];
      if (typeof fn !== "function") {
        throw new Error(
          `mockSigner.sendTransaction: no method "${method}" on ${populated.to}`,
        );
      }
      return await fn(...(Array.isArray(args) ? args : [args]));
    },
  };
}

/** Attach `.populateTransaction(args)` to a dispatch fn so production
 *  code that calls `contract.method.populateTransaction(args)` works.
 *  Idempotent — won't double-wrap. */
function _attachPopulate(addr, name, fn) {
  if (typeof fn !== "function") return fn;
  if (fn.populateTransaction) return fn;
  fn.populateTransaction = (...args) => ({
    to: addr,
    data: { __mock_method: name, __mock_args: args },
    gasLimit: 200_000n,
  });
  return fn;
}

/**
 * Default mock dispatch. The balanceOf for tokens returns different values
 * before and after collect so balance-diff works (before=0, after=5 ETH).
 */
function defaultDispatch() {
  // Track collect calls to switch balanceOf from "before" to "after"
  let collected = false;
  return {
    [ADDR.factory]: {
      getPool: async () => ADDR.pool,
      // Production code reads tick spacing on-chain; mirror that here.
      // Defaults to 60 (fee=3000) for tests that don't override fee.
      feeAmountTickSpacing: async (fee) => {
        const map = {
          100: 1,
          500: 10,
          2500: 50,
          3000: 60,
          10000: 200,
          20000: 400,
        };
        return BigInt(map[Number(fee)] ?? 60);
      },
    },
    [ADDR.pool]: { slot0: async () => ({ sqrtPriceX96: Q96, tick: 0n }) },
    [ADDR.token0]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx("0xapprove0"),
      allowance: async () => 0n,
    },
    [ADDR.token1]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx("0xapprove1"),
      allowance: async () => 0n,
    },
    [ADDR.pm]: {
      ownerOf: async () => ADDR.signer,
      positions: async () => ({
        liquidity: 5000n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      }),
      decreaseLiquidity: async () => makeTx("0xdecrease"),
      collect: async () => {
        collected = true;
        return { wait: async () => ({ hash: "0xcollect", logs: [] }) };
      },
      mint: async () => makeMintTx("0xmint"),
    },
    [ADDR.router]: {
      exactInputSingle: Object.assign(async () => makeTx("0xswap"), {
        staticCall: async (p) => p.amountIn,
      }),
    },
  };
}

/*- Imported lazily to avoid a require cycle if send-tx-mock ever pulls
    in this file.  The initSendTx call is a no-op for tests that don't
    use the unified send-transaction flow. */
function _ensureSendTxInit() {
  const { initSendTx } = require("./send-tx-mock");
  initSendTx();
}

function buildMockEthersLib(overrides = {}) {
  _ensureSendTxInit();
  const contractDispatch = overrides.contractDispatch ?? defaultDispatch();
  /*- Auto-wrap every dispatch method with .populateTransaction so the
      send-transaction.js flow can populate, sign, and broadcast through
      mockSigner.sendTransaction without bypassing the production code
      path. */
  for (const [addr, methods] of Object.entries(contractDispatch)) {
    for (const [name, fn] of Object.entries(methods)) {
      _attachPopulate(addr, name, fn);
    }
  }
  _activeDispatch = contractDispatch;

  /*- Per-address shared `_pending` queue for the
      encodeFunctionData → multicall flow.  Multicall is registered into
      `_activeDispatch[addr]` after the first Contract instance constructs
      it, and subsequent Contract instances inherit that same multicall
      via the `this[name] = fn` loop.  Sharing `_pending` per-address
      ensures `interface.encodeFunctionData` writes to the queue that the
      registered multicall reads from, regardless of which instance was
      first.  Without this, encodeFunctionData would write to a fresh
      per-instance array while multicall reads from the original
      instance's array, yielding undefined entries. */
  const _pendingByAddr = {};

  function MockContract(addr, _abi, _signer) {
    const self = this;
    const methods = contractDispatch[addr];
    if (!methods) throw new Error(`No mock for address: ${addr}`);
    /*- Mirror ethers v6 Contract: the third arg is stored as `.runner`,
        which production code (e.g. rebalancer-pools._ensureAllowance) reads
        to get the signer for sendTransaction. */
    this.runner = _signer;
    for (const [name, fn] of Object.entries(methods)) this[name] = fn;
    if (!_pendingByAddr[addr]) _pendingByAddr[addr] = [];
    const _pending = _pendingByAddr[addr];
    this.interface = {
      encodeFunctionData: (name, args) => {
        const idx = _pending.length;
        _pending.push({ method: name, args: args[0] });
        return `mock_call_${idx}`;
      },
    };
    if (!this.multicall) {
      this.multicall = async (calls) => {
        for (const ref of calls) {
          const idx = parseInt(ref.replace("mock_call_", ""), 10);
          const { method, args } = _pending[idx];
          if (self[method]) await self[method](args);
        }
        return makeTx("0xmulticall");
      };
      this.multicall.populateTransaction = (calls) => ({
        to: addr,
        data: { __mock_method: "multicall", __mock_args: [calls] },
        gasLimit: 200_000n,
      });
      /*- Register multicall in the active dispatch under this contract
          address so mockSigner.sendTransaction can route to it. */
      if (_activeDispatch[addr]) {
        _activeDispatch[addr].multicall = this.multicall;
      }
    }
  }
  return {
    Contract: MockContract,
    ZeroAddress: ZERO_ADDRESS,
    ...(overrides.extra ?? {}),
  };
}

const poolArgs = {
  factoryAddress: ADDR.factory,
  token0: ADDR.token0,
  token1: ADDR.token1,
  fee: 3000,
};

module.exports = {
  ADDR,
  ZERO_ADDRESS,
  Q96,
  ONE_ETH,
  INC_TOPIC,
  makeTx,
  makeMintTx,
  mockSigner,
  defaultDispatch,
  buildMockEthersLib,
  poolArgs,
};
