/**
 * @file test/_bot-loop-helpers.js
 * @description Shared mock helpers for bot-loop test suites.
 * Used by bot-loop.test.js and bot-loop-pnl.test.js.
 */

'use strict';

const { pollCycle } = require('../src/bot-loop');
const config = require('../src/config');

const ADDR = {
  factory: config.FACTORY,
  pool: '0xPOOL00000000000000000000000000000000000001',
  token0: '0xTOKEN00000000000000000000000000000000000A',
  token1: '0xTOKEN00000000000000000000000000000000000B',
  pm: config.POSITION_MANAGER,
  router: config.SWAP_ROUTER,
  signer: '0xSIGNER0000000000000000000000000000000001',
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const Q96 = BigInt('0x1000000000000000000000000');
const ONE_ETH = 1_000_000_000_000_000_000n;
const INC_TOPIC =
  '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';

function makeTx(hash) {
  return { wait: async () => ({ hash, logs: [] }) };
}

function makeMintTx(
  hash,
  tokenId = 42n,
  liq = 5000n,
  a0 = 1000n,
  a1 = 1000n,
) {
  return {
    wait: async () => ({
      hash,
      logs: [
        {
          topics: [
            INC_TOPIC,
            '0x' + tokenId.toString(16).padStart(64, '0'),
          ],
          data:
            '0x' +
            liq.toString(16).padStart(64, '0') +
            a0.toString(16).padStart(64, '0') +
            a1.toString(16).padStart(64, '0'),
        },
      ],
    }),
  };
}

function buildPollDeps(opts = {}) {
  const tick = opts.tick ?? 0;
  let collected = false;
  const dispatch = {
    [ADDR.factory]: { getPool: async () => ADDR.pool },
    [ADDR.pool]: {
      slot0: async () => ({ sqrtPriceX96: Q96, tick: BigInt(tick) }),
    },
    [ADDR.token0]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx('0xa0'),
      allowance: async () => 0n,
    },
    [ADDR.token1]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx('0xa1'),
      allowance: async () => 0n,
    },
    [ADDR.pm]: {
      ownerOf: async () => ADDR.signer,
      positions: async () => ({
        liquidity: 5000n,
        tokensOwed0: 0n,
        tokensOwed1: 0n,
      }),
      decreaseLiquidity: async () => makeTx('0xdec'),
      collect: async () => {
        collected = true;
        return { wait: async () => ({ hash: '0xcol', logs: [] }) };
      },
      mint: async () => makeMintTx('0xmint', 99n, 8000n),
    },
    [ADDR.router]: {
      exactInputSingle: Object.assign(async () => makeTx('0xswap'), {
        staticCall: async (p) => p.amountIn,
      }),
    },
  };

  function MockContract(addr, _abi) {
    const self = this;
    const methods = dispatch[addr];
    if (!methods) throw new Error(`No mock for ${addr}`);
    for (const [name, fn] of Object.entries(methods)) this[name] = fn;
    const _pending = [];
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
          const idx = parseInt(ref.replace('mock_call_', ''), 10);
          const { method, args } = _pending[idx];
          if (self[method]) await self[method](args);
        }
        return makeTx('0xmulticall');
      };
    }
  }
  const ethersLib = { Contract: MockContract, ZeroAddress: ZERO_ADDRESS };
  const signer = {
    getAddress: async () => ADDR.signer,
    provider: { mockProvider: true },
  };
  const position = {
    tokenId: 1n,
    token0: ADDR.token0,
    token1: ADDR.token1,
    fee: 3000,
    liquidity: 5000n,
    tickLower: -600,
    tickUpper: 600,
  };
  const throttleState = { allowed: true };
  const throttle = {
    tick: () => {},
    canRebalance: () => ({
      allowed: throttleState.allowed,
      msUntilAllowed: 0,
      reason: 'ok',
    }),
    recordRebalance: () => {},
    getState: () => ({}),
    _state: throttleState,
  };
  return { ethersLib, signer, position, throttle, dispatch };
}

/** Helper: run pollCycle with buildPollDeps + overrides. */
function _poll(tick, overrides = {}) {
  const deps = buildPollDeps({ tick });
  if (overrides.setupDeps) overrides.setupDeps(deps);
  const stateUpdates = overrides.collectStates ? [] : null;
  const captured = overrides.captureState ? {} : null;
  return pollCycle({
    signer: deps.signer,
    provider: overrides.provider || {},
    position: deps.position,
    throttle: deps.throttle,
    _ethersLib: deps.ethersLib,
    dryRun: overrides.dryRun,
    _botState: overrides.botState || {
      rebalanceOutOfRangeThresholdPercent: 0,
    },
    _getConfig:
      overrides.getConfig ||
      ((k) =>
        (overrides.botState || {
          slippagePct: 0.5,
          rebalanceOutOfRangeThresholdPercent: 0,
        })[k]),
    _pnlTracker: overrides.tracker,
    updateBotState: stateUpdates
      ? (u) => stateUpdates.push(u)
      : captured
        ? (u) => Object.assign(captured, u)
        : () => {},
  }).then((r) => ({ r, deps, stateUpdates, captured }));
}

module.exports = { ADDR, _poll, buildPollDeps, makeTx, makeMintTx };
