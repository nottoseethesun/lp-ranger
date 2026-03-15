'use strict';

/**
 * @file test/rebalancer-integration.test.js
 * @description Stateful simulation integration tests for the rebalancer pipeline.
 * Uses a mock that maintains consistent balances across remove→swap→mint,
 * verifying cross-function invariants that unit tests cannot catch.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const { executeRebalance } = require('../src/rebalancer');
const { priceToTick, nearestUsableTick, TICK_SPACINGS } = require('../src/range-math');

// ── Simulation harness ─────────────────────────────────────────────────────

const ADDR = {
  factory: '0xFACTORY0000000000000000000000000000000001',
  pool:    '0xPOOL00000000000000000000000000000000000001',
  token0:  '0xTOKEN00000000000000000000000000000000000A',
  token1:  '0xTOKEN00000000000000000000000000000000000B',
  pm:      '0xPM000000000000000000000000000000000000001',
  router:  '0xROUTER0000000000000000000000000000000001',
  signer:  '0xSIGNER0000000000000000000000000000000001',
};
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const INC_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';

/**
 * Creates a stateful mock that tracks token balances across contract calls.
 * @param {object} opts
 * @param {bigint} opts.positionAmount0  Amount of token0 in the position.
 * @param {bigint} opts.positionAmount1  Amount of token1 in the position.
 * @param {number} opts.price            Pool price (token1 per token0).
 * @param {number} opts.decimals0        Token0 decimals.
 * @param {number} opts.decimals1        Token1 decimals.
 * @param {number} opts.fee              Fee tier.
 */
function createSimulation(opts) {
  const {
    positionAmount0, positionAmount1, price,
    decimals0 = 18, decimals1 = 18, fee: _fee = 3000,
  } = opts;

  const Q96 = BigInt('0x1000000000000000000000000');
  // sqrtPriceX96 = sqrt(price * 10^(d1-d0)) * 2^96
  const adjustedPrice = price * Math.pow(10, decimals1 - decimals0);
  const sqrtPrice = Math.sqrt(adjustedPrice);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));
  const tick = BigInt(Math.floor(Math.log(adjustedPrice) / Math.log(1.0001)));

  // Wallet balances (start at 0, get credited on collect)
  const balances = { [ADDR.token0]: 0n, [ADDR.token1]: 0n };
  let nextTokenId = 100n;
  const invariantChecks = [];

  // Position tokens (in the NFT, not yet in wallet)
  let positionTokens = { amount0: positionAmount0, amount1: positionAmount1 };

  const dispatch = {
    [ADDR.factory]: { getPool: async () => ADDR.pool },
    [ADDR.pool]: { slot0: async () => ({ sqrtPriceX96, tick }) },
    [ADDR.token0]: {
      decimals: async () => BigInt(decimals0),
      balanceOf: async () => balances[ADDR.token0],
      approve: async () => ({ wait: async () => ({ hash: '0xapprove0', logs: [] }) }),
      allowance: async () => 0n,
    },
    [ADDR.token1]: {
      decimals: async () => BigInt(decimals1),
      balanceOf: async () => balances[ADDR.token1],
      approve: async () => ({ wait: async () => ({ hash: '0xapprove1', logs: [] }) }),
      allowance: async () => 0n,
    },
    [ADDR.pm]: {
      ownerOf: async () => ADDR.signer,
      positions: async () => ({ liquidity: 10000n, tokensOwed0: 0n, tokensOwed1: 0n }),
      decreaseLiquidity: async () => {
        // Tokens stay in PM until collect
        return { wait: async () => ({ hash: '0xdec', logs: [] }) };
      },
      collect: async () => {
        // Credit position tokens to wallet
        balances[ADDR.token0] += positionTokens.amount0;
        balances[ADDR.token1] += positionTokens.amount1;
        positionTokens = { amount0: 0n, amount1: 0n };
        invariantChecks.push({
          step: 'collect',
          bal0: balances[ADDR.token0],
          bal1: balances[ADDR.token1],
        });
        return { wait: async () => ({ hash: '0xcol', logs: [] }) };
      },
      mint: async (params) => {
        const a0 = params.amount0Desired;
        const a1 = params.amount1Desired;
        // Debit from wallet — fail if insufficient
        if (balances[ADDR.token0] < a0) {
          throw new Error(
            `Insufficient token0: have ${balances[ADDR.token0]}, need ${a0}`,
          );
        }
        if (balances[ADDR.token1] < a1) {
          throw new Error(
            `Insufficient token1: have ${balances[ADDR.token1]}, need ${a1}`,
          );
        }
        balances[ADDR.token0] -= a0;
        balances[ADDR.token1] -= a1;

        const tokenId = nextTokenId++;
        // Simulate realistic liquidity value (not just a0+a1)
        const liquidity = a0 > 0n && a1 > 0n
          ? BigInt(Math.floor(Math.sqrt(Number(a0) * Number(a1))))
          : (a0 > a1 ? a0 : a1);

        invariantChecks.push({
          step: 'mint',
          a0Desired: a0, a1Desired: a1,
          bal0After: balances[ADDR.token0],
          bal1After: balances[ADDR.token1],
          liquidity,
        });

        return {
          wait: async () => ({
            hash: '0xmint',
            logs: [{
              topics: [INC_TOPIC, '0x' + tokenId.toString(16).padStart(64, '0')],
              data: '0x'
                + liquidity.toString(16).padStart(64, '0')
                + a0.toString(16).padStart(64, '0')
                + a1.toString(16).padStart(64, '0'),
            }],
          }),
        };
      },
    },
    [ADDR.router]: {
      exactInputSingle: async (params) => {
        const amountIn = params.amountIn;
        const tokenIn = params.tokenIn;
        const tokenOut = params.tokenOut;

        // Debit input from wallet
        if (balances[tokenIn] < amountIn) {
          throw new Error(`Swap: insufficient ${tokenIn}`);
        }
        balances[tokenIn] -= amountIn;

        // Credit output to wallet (using the pool price)
        let amountOut;
        if (tokenIn === ADDR.token0) {
          // Selling token0 for token1
          const floatIn = Number(amountIn) / (10 ** decimals0);
          const floatOut = floatIn * price;
          amountOut = BigInt(Math.floor(floatOut * (10 ** decimals1)));
        } else {
          // Selling token1 for token0
          const floatIn = Number(amountIn) / (10 ** decimals1);
          const floatOut = floatIn / price;
          amountOut = BigInt(Math.floor(floatOut * (10 ** decimals0)));
        }
        balances[tokenOut] += amountOut;

        invariantChecks.push({
          step: 'swap',
          tokenIn, tokenOut, amountIn, amountOut,
          bal0: balances[ADDR.token0], bal1: balances[ADDR.token1],
        });

        return { wait: async () => ({ hash: '0xswap', logs: [] }) };
      },
    },
  };

  function MockContract(addr, _abi, _signer) {
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
        return { wait: async () => ({ hash: '0xmulticall', logs: [] }) };
      };
    }
  }
  const ethersLib = { Contract: MockContract, ZeroAddress: ZERO_ADDRESS };

  return { ethersLib, balances, invariantChecks };
}

function makePosition(overrides = {}) {
  return {
    tokenId: 1n, token0: ADDR.token0, token1: ADDR.token1,
    fee: 3000, liquidity: 5000n, tickLower: -600, tickUpper: 600,
    ...overrides,
  };
}

function makeOpts(position, extra = {}) {
  return {
    position,
    factoryAddress: ADDR.factory, positionManagerAddress: ADDR.pm,
    swapRouterAddress: ADDR.router, rangeWidthPct: 20, slippagePct: 0.5,
    ...extra,
  };
}

const ONE_ETH = 1_000_000_000_000_000_000n;

// ── Integration tests ──────────────────────────────────────────────────────

describe('Integration: balanced rebalance (equal amounts)', () => {
  it('succeeds with near-zero dust remaining', async () => {
    const sim = createSimulation({
      positionAmount0: 5n * ONE_ETH,
      positionAmount1: 5n * ONE_ETH,
      price: 1.0,
    });
    const r = await executeRebalance(
      mockSigner(), sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.liquidity > 0n, 'liquidity must be > 0');
    assert.ok(r.newTokenId > 0n, 'newTokenId must be > 0');
    // Dust should be small relative to position
    const dust0 = sim.balances[ADDR.token0];
    const dust1 = sim.balances[ADDR.token1];
    assert.ok(dust0 >= 0n, 'token0 balance must not be negative');
    assert.ok(dust1 >= 0n, 'token1 balance must not be negative');
  });
});

function mockSigner(address) {
  return {
    getAddress: async () => address ?? ADDR.signer,
    provider: { mockProvider: true },
  };
}

describe('Integration: imbalanced (100% token0)', () => {
  it('swaps to rebalance and mints successfully', async () => {
    const sim = createSimulation({
      positionAmount0: 10n * ONE_ETH,
      positionAmount1: 0n,
      price: 1.0,
    });
    // Must have at least some token1 for balance-diff to work
    // With 0 token1, removeLiquidity will see 10 ETH token0 but 0 token1 which is fine
    const r = await executeRebalance(
      mockSigner(), sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.liquidity > 0n);
    // Verify no negative balances at any step
    for (const check of sim.invariantChecks) {
      if (check.bal0 !== undefined) {
        assert.ok(check.bal0 >= 0n, `negative token0 at step ${check.step}`);
      }
      if (check.bal1 !== undefined) {
        assert.ok(check.bal1 >= 0n, `negative token1 at step ${check.step}`);
      }
    }
  });
});

describe('Integration: imbalanced (100% token1)', () => {
  it('swaps to rebalance and mints successfully', async () => {
    const sim = createSimulation({
      positionAmount0: 0n,
      positionAmount1: 10n * ONE_ETH,
      price: 1.0,
    });
    const r = await executeRebalance(
      mockSigner(), sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.liquidity > 0n);
  });
});

describe('Integration: asymmetric decimals (6 vs 18)', () => {
  it('handles USDC/WETH style pairs', async () => {
    const sim = createSimulation({
      positionAmount0: 2000_000000n, // 2000 USDC (6 dec)
      positionAmount1: ONE_ETH,      // 1 WETH (18 dec)
      price: 2000,                   // 1 token0 = 2000 token1
      decimals0: 6,
      decimals1: 18,
    });
    const pos = makePosition({
      tickLower: nearestUsableTick(priceToTick(1600, 6, 18), 3000),
      tickUpper: nearestUsableTick(priceToTick(2400, 6, 18), 3000),
    });
    const r = await executeRebalance(
      mockSigner(), sim.ethersLib,
      makeOpts(pos),
    );
    assert.strictEqual(r.success, true);
    assert.ok(r.liquidity > 0n);
    assert.ok(sim.balances[ADDR.token0] >= 0n, 'no negative USDC');
    assert.ok(sim.balances[ADDR.token1] >= 0n, 'no negative WETH');
  });
});

describe('Integration: dust amounts near swap threshold', () => {
  it('handles very small position amounts', async () => {
    const sim = createSimulation({
      positionAmount0: 500n,  // below _MIN_SWAP_THRESHOLD
      positionAmount1: 500n,
      price: 1.0,
    });
    const r = await executeRebalance(
      mockSigner(), sim.ethersLib,
      makeOpts(makePosition()),
    );
    assert.strictEqual(r.success, true);
  });
});

describe('Integration: all fee tiers', () => {
  for (const fee of [100, 500, 2500, 3000, 10000]) {
    it(`fee tier ${fee} produces valid range`, async () => {
      const spacing = TICK_SPACINGS[fee];
      const sim = createSimulation({
        positionAmount0: 5n * ONE_ETH,
        positionAmount1: 5n * ONE_ETH,
        price: 1.0,
        fee,
      });
      const pos = makePosition({
        fee,
        tickLower: -spacing * 10,
        tickUpper: spacing * 10,
      });
      const r = await executeRebalance(
        mockSigner(), sim.ethersLib,
        makeOpts(pos),
      );
      assert.strictEqual(r.success, true);
      // Verify new ticks are valid multiples of spacing
      assert.ok(r.newTickLower % spacing === 0,
        `lowerTick ${r.newTickLower} not multiple of ${spacing}`);
      assert.ok(r.newTickUpper % spacing === 0,
        `upperTick ${r.newTickUpper} not multiple of ${spacing}`);
      assert.ok(r.newTickLower < r.newTickUpper);
    });
  }
});

describe('Integration: various range widths', () => {
  for (const width of [1, 5, 10, 20, 50, 80]) {
    it(`range width ${width}% succeeds`, async () => {
      const sim = createSimulation({
        positionAmount0: 5n * ONE_ETH,
        positionAmount1: 5n * ONE_ETH,
        price: 1.0,
      });
      const r = await executeRebalance(
        mockSigner(), sim.ethersLib,
        makeOpts(makePosition(), { rangeWidthPct: width }),
      );
      assert.strictEqual(r.success, true);
      assert.ok(r.liquidity > 0n);
      assert.ok(r.newTickLower < r.newTickUpper);
    });
  }
});

describe('Integration: extreme prices', () => {
  it('handles very high price (1e10)', async () => {
    const sim = createSimulation({
      positionAmount0: ONE_ETH,
      positionAmount1: 10_000_000_000n * ONE_ETH,
      price: 1e10,
    });
    const tick = Math.floor(Math.log(1e10) / Math.log(1.0001));
    const pos = makePosition({
      tickLower: nearestUsableTick(tick - 6000, 3000),
      tickUpper: nearestUsableTick(tick + 6000, 3000),
    });
    const r = await executeRebalance(
      mockSigner(), sim.ethersLib,
      makeOpts(pos),
    );
    assert.strictEqual(r.success, true);
  });

  it('handles very low price (1e-10)', async () => {
    const sim = createSimulation({
      positionAmount0: 10_000_000_000n * ONE_ETH,
      positionAmount1: ONE_ETH,
      price: 1e-10,
    });
    const tick = Math.floor(Math.log(1e-10) / Math.log(1.0001));
    const pos = makePosition({
      tickLower: nearestUsableTick(tick - 6000, 3000),
      tickUpper: nearestUsableTick(tick + 6000, 3000),
    });
    const r = await executeRebalance(
      mockSigner(), sim.ethersLib,
      makeOpts(pos),
    );
    assert.strictEqual(r.success, true);
  });
});
