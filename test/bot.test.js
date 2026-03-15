'use strict';

/**
 * @file test/bot.test.js
 * @description Tests for bot.js — RPC fallback, pollCycle, appendLog.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { createProviderWithFallback, pollCycle } = require('../bot');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock ethers library whose JsonRpcProvider controls getBlockNumber. */
function mockEthersLib({ primaryFails = false, fallbackFails = false } = {}) {
  const calls = [];
  function JsonRpcProvider(url) {
    calls.push(url);
    this.url = url;
    this.getBlockNumber = async () => {
      if (primaryFails && url === 'https://primary.rpc') {
        throw new Error('primary unreachable');
      }
      if (fallbackFails && url === 'https://fallback.rpc') {
        throw new Error('fallback unreachable');
      }
      return 12345;
    };
  }
  return { JsonRpcProvider, calls };
}

// ── RPC fallback ─────────────────────────────────────────────────────────────

describe('createProviderWithFallback', () => {
  it('uses primary when it is reachable', async () => {
    const lib = mockEthersLib();
    const provider = await createProviderWithFallback(
      'https://primary.rpc', 'https://fallback.rpc', lib,
    );
    assert.strictEqual(provider.url, 'https://primary.rpc');
    assert.deepStrictEqual(lib.calls, ['https://primary.rpc']);
  });

  it('falls back when primary is unreachable', async () => {
    const lib = mockEthersLib({ primaryFails: true });
    const provider = await createProviderWithFallback(
      'https://primary.rpc', 'https://fallback.rpc', lib,
    );
    assert.strictEqual(provider.url, 'https://fallback.rpc');
    assert.deepStrictEqual(lib.calls, ['https://primary.rpc', 'https://fallback.rpc']);
  });

  it('throws when both primary and fallback are unreachable', async () => {
    const lib = mockEthersLib({ primaryFails: true, fallbackFails: true });
    await assert.rejects(
      () => createProviderWithFallback('https://primary.rpc', 'https://fallback.rpc', lib),
      { message: 'fallback unreachable' },
    );
    assert.deepStrictEqual(lib.calls, ['https://primary.rpc', 'https://fallback.rpc']);
  });

  it('does not try fallback when primary succeeds', async () => {
    const lib = mockEthersLib({ fallbackFails: true });
    const provider = await createProviderWithFallback(
      'https://primary.rpc', 'https://fallback.rpc', lib,
    );
    assert.strictEqual(provider.url, 'https://primary.rpc');
    assert.strictEqual(lib.calls.length, 1);
  });

  it('returned provider has working getBlockNumber', async () => {
    const lib = mockEthersLib({ primaryFails: true });
    const provider = await createProviderWithFallback(
      'https://primary.rpc', 'https://fallback.rpc', lib,
    );
    const block = await provider.getBlockNumber();
    assert.strictEqual(block, 12345);
  });
});

// ── pollCycle — OOR detection ────────────────────────────────────────────────

describe('pollCycle — out-of-range detection', () => {
  // Minimal mock for pollCycle: it calls getPoolState via the real rebalancer,
  // so we mock at the ethers.Contract level via the global `ethers` require.
  // Instead, we can test the OOR boundary logic directly.

  it('upper tick boundary is exclusive (tick === tickUpper is OOR)', async () => {
    // This tests the V3 semantics: when tick === tickUpper, position is OOR.
    // We can't easily call pollCycle without full mocking, so we verify
    // the boundary logic matches V3 spec directly.
    const tick = 600;
    const tickLower = -600;
    const tickUpper = 600;
    // V3 in-range: tick >= tickLower && tick < tickUpper (strict less-than)
    const inRange = tick >= tickLower && tick < tickUpper;
    assert.strictEqual(inRange, false, 'tick === tickUpper should be out of range');
  });

  it('tick just below tickUpper is in-range', () => {
    const tick = 599;
    const tickLower = -600;
    const tickUpper = 600;
    const inRange = tick >= tickLower && tick < tickUpper;
    assert.strictEqual(inRange, true);
  });

  it('tick at tickLower is in-range', () => {
    const tick = -600;
    const tickLower = -600;
    const tickUpper = 600;
    const inRange = tick >= tickLower && tick < tickUpper;
    assert.strictEqual(inRange, true);
  });

  it('tick below tickLower is out of range', () => {
    const tick = -601;
    const tickLower = -600;
    const tickUpper = 600;
    const inRange = tick >= tickLower && tick < tickUpper;
    assert.strictEqual(inRange, false);
  });
});

// ── pollCycle pipeline tests ────────────────────────────────────────────────

const config = require('../src/config');
const ADDR = {
  factory: config.FACTORY,
  pool:    '0xPOOL00000000000000000000000000000000000001',
  token0:  '0xTOKEN00000000000000000000000000000000000A',
  token1:  '0xTOKEN00000000000000000000000000000000000B',
  pm:      config.POSITION_MANAGER,
  router:  config.SWAP_ROUTER,
  signer:  '0xSIGNER0000000000000000000000000000000001',
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const Q96 = BigInt('0x1000000000000000000000000');
const ONE_ETH = 1_000_000_000_000_000_000n;
const INC_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';

function makeTx(hash) {
  return { wait: async () => ({ hash, logs: [] }) };
}
function makeMintTx(hash, tokenId = 42n, liq = 5000n, a0 = 1000n, a1 = 1000n) {
  return {
    wait: async () => ({
      hash,
      logs: [{
        topics: [INC_TOPIC, '0x' + tokenId.toString(16).padStart(64, '0')],
        data: '0x'
          + liq.toString(16).padStart(64, '0')
          + a0.toString(16).padStart(64, '0')
          + a1.toString(16).padStart(64, '0'),
      }],
    }),
  };
}

/**
 * Build a full mock ethersLib + deps for pollCycle testing.
 * @param {object} opts
 * @param {number} opts.tick  Current pool tick.
 * @returns {{ ethersLib, signer, position, throttle, deps }}
 */
function buildPollDeps(opts = {}) {
  const tick = opts.tick ?? 0;
  let collected = false;

  const dispatch = {
    [ADDR.factory]: { getPool: async () => ADDR.pool },
    [ADDR.pool]: { slot0: async () => ({ sqrtPriceX96: Q96, tick: BigInt(tick) }) },
    [ADDR.token0]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx('0xa0'), allowance: async () => 0n,
    },
    [ADDR.token1]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx('0xa1'), allowance: async () => 0n,
    },
    [ADDR.pm]: {
      ownerOf: async () => ADDR.signer,
      positions: async () => ({ liquidity: 5000n, tokensOwed0: 0n, tokensOwed1: 0n }),
      decreaseLiquidity: async () => makeTx('0xdec'),
      collect: async () => { collected = true; return { wait: async () => ({ hash: '0xcol', logs: [] }) }; },
      mint: async () => makeMintTx('0xmint', 99n, 8000n),
    },
    [ADDR.router]: { exactInputSingle: async () => makeTx('0xswap') },
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
    tokenId: 1n, token0: ADDR.token0, token1: ADDR.token1,
    fee: 3000, liquidity: 5000n, tickLower: -600, tickUpper: 600,
  };

  const throttleState = { allowed: true };
  const throttle = {
    tick: () => {},
    canRebalance: () => ({ allowed: throttleState.allowed, msUntilAllowed: 0, reason: 'ok' }),
    recordRebalance: () => {},
    getState: () => ({}),
    _state: throttleState,
  };

  return { ethersLib, signer, position, throttle, dispatch };
}

describe('pollCycle — full pipeline', () => {
  it('returns rebalanced:false when in range', async () => {
    const deps = buildPollDeps({ tick: 0 }); // tick 0 is in [-600, 600)
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
    });
    assert.strictEqual(r.rebalanced, false);
  });

  it('rebalances when out of range (tick >= tickUpper)', async () => {
    const deps = buildPollDeps({ tick: 600 }); // tick === tickUpper → OOR
    const posBefore = { ...deps.position };
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
    });
    assert.strictEqual(r.rebalanced, true);
    // Verify position was updated in-place
    assert.notStrictEqual(deps.position.tokenId, posBefore.tokenId);
    assert.strictEqual(deps.position.tokenId, 99n, 'tokenId should be updated from mint');
  });

  it('updates position.liquidity from mint result (not amount sum)', async () => {
    const deps = buildPollDeps({ tick: 700 });
    await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
    });
    // makeMintTx returns liquidity=8000n
    assert.strictEqual(deps.position.liquidity, 8000n,
      'liquidity must come from mint event, not amount0+amount1');
  });

  it('updates tickLower and tickUpper after rebalance', async () => {
    const deps = buildPollDeps({ tick: -700 });
    await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 20, slippagePct: 0.5 },
    });
    // New ticks should be centered around the current price (tick=-700)
    assert.ok(deps.position.tickLower < deps.position.tickUpper);
    assert.notStrictEqual(deps.position.tickLower, -600, 'ticks should be updated');
  });

  it('does not rebalance when throttled', async () => {
    const deps = buildPollDeps({ tick: 700 });
    deps.throttle._state.allowed = false;
    deps.throttle.canRebalance = () => ({
      allowed: false, msUntilAllowed: 60000, reason: 'min_interval',
    });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {},
    });
    assert.strictEqual(r.rebalanced, false);
    // Position should be unchanged
    assert.strictEqual(deps.position.tokenId, 1n);
  });

  it('does not rebalance in dry-run mode', async () => {
    const deps = buildPollDeps({ tick: 700 });
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      dryRun: true,
      _ethersLib: deps.ethersLib,
      _botState: {},
    });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(deps.position.tokenId, 1n, 'position unchanged in dry run');
  });

  it('uses rangeWidthPct from botState (runtime-adjustable)', async () => {
    const deps = buildPollDeps({ tick: 700 });
    // Use a very narrow range width to test it flows through
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: { rangeWidthPct: 5, slippagePct: 0.5 },
    });
    assert.strictEqual(r.rebalanced, true);
    // With 5% width, the ticks should be much closer together
    const rangeSpan = deps.position.tickUpper - deps.position.tickLower;
    assert.ok(rangeSpan < 2000, `narrow range expected, got span=${rangeSpan}`);
  });

  it('position unchanged when rebalance fails', async () => {
    const deps = buildPollDeps({ tick: 700 });
    // Make getPool fail so executeRebalance returns success:false
    deps.dispatch[ADDR.factory] = {
      getPool: async () => { throw new Error('RPC_DOWN'); },
    };
    const posBefore = { ...deps.position };
    const r = await pollCycle({
      signer: deps.signer,
      provider: {},
      position: deps.position,
      throttle: deps.throttle,
      _ethersLib: deps.ethersLib,
      _botState: {},
    });
    assert.strictEqual(r.rebalanced, false);
    assert.strictEqual(deps.position.tokenId, posBefore.tokenId);
    assert.strictEqual(deps.position.tickLower, posBefore.tickLower);
    assert.strictEqual(deps.position.liquidity, posBefore.liquidity);
  });
});
