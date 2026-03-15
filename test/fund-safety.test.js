'use strict';

/**
 * @file test/fund-safety.test.js
 * @description Tests that verify the rebalancer cannot lose user funds.
 * Covers: slippage protection, recipient validation, underflow guards,
 * wallet-balance isolation, partial-failure handling, ownership check,
 * and range validity.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  computeDesiredAmounts, swapIfNeeded, mintPosition,
  removeLiquidity, executeRebalance, _MAX_UINT128,
} = require('../src/rebalancer');
const { computeNewRange, priceToTick } = require('../src/range-math');

// ── Addresses & helpers ─────────────────────────────────────────────────────
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
const Q96 = BigInt('0x1000000000000000000000000');
const ONE_ETH = 1_000_000_000_000_000_000n;

const INC_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';

function makeTx(hash) {
  return { wait: async () => ({ hash, logs: [] }) };
}

function makeMintTx(hash, tokenId = 42n, liquidity = 5000n, amount0 = 1000n, amount1 = 1000n) {
  return {
    wait: async () => ({
      hash,
      logs: [{
        topics: [INC_TOPIC, '0x' + tokenId.toString(16).padStart(64, '0')],
        data: '0x'
          + liquidity.toString(16).padStart(64, '0')
          + amount0.toString(16).padStart(64, '0')
          + amount1.toString(16).padStart(64, '0'),
      }],
    }),
  };
}
function mockSigner(address) {
  return {
    getAddress: async () => address ?? ADDR.signer,
    provider: { mockProvider: true },
  };
}
function defaultDispatch() {
  let collected = false;
  return {
    [ADDR.factory]: { getPool: async () => ADDR.pool },
    [ADDR.pool]:    { slot0: async () => ({ sqrtPriceX96: Q96, tick: 0n }) },
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
      positions: async () => ({ liquidity: 5000n }),
      decreaseLiquidity: async () => makeTx('0xdec'),
      collect: async () => { collected = true; return { wait: async () => ({ hash: '0xcol', logs: [] }) }; },
      mint: async () => makeMintTx('0xmint'),
    },
    [ADDR.router]: { exactInputSingle: async () => makeTx('0xswap') },
  };
}
function buildMockEthersLib(overrides = {}) {
  const contractDispatch = overrides.contractDispatch ?? defaultDispatch();
  function MockContract(addr, _abi, _signer) {
    const methods = contractDispatch[addr];
    if (!methods) throw new Error(`No mock for address: ${addr}`);
    for (const [name, fn] of Object.entries(methods)) this[name] = fn;
  }
  return {
    Contract: MockContract,
    ZeroAddress: ZERO_ADDRESS,
    ...(overrides.extra ?? {}),
  };
}

const rebalOpts = (posOverride) => ({
  position: {
    tokenId: 1n, token0: ADDR.token0, token1: ADDR.token1,
    fee: 3000, liquidity: 5000n, tickLower: -600, tickUpper: 600,
    ...posOverride,
  },
  factoryAddress: ADDR.factory, positionManagerAddress: ADDR.pm,
  swapRouterAddress: ADDR.router, rangeWidthPct: 20, slippagePct: 0.5,
});

// ── Swap slippage (anti-sandwich) ───────────────────────────────────────────
describe('Fund safety — swap slippage', () => {
  const swArgs = (extra) => ({
    swapRouterAddress: ADDR.router, tokenIn: ADDR.token0, tokenOut: ADDR.token1,
    fee: 3000, amountIn: 1_000_000n, slippagePct: 0.5, recipient: ADDR.signer,
    currentPrice: 1.0, decimalsIn: 18, decimalsOut: 18, isToken0To1: true,
    deadline: 9999999999n, ...extra,
  });

  it('amountOutMinimum > 0 (sandwich protection)', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.router] = {
      exactInputSingle: async (p) => { captured = p; return makeTx('0xs'); },
    };
    await swapIfNeeded(mockSigner(), buildMockEthersLib({ contractDispatch: d }), swArgs());
    assert.ok(captured.amountOutMinimum > 0n,
      `amountOutMinimum must be > 0, got ${captured.amountOutMinimum}`);
  });

  it('price-based min for different-valued tokens (WETH→USDC)', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.router] = {
      exactInputSingle: async (p) => { captured = p; return makeTx('0xs'); },
    };
    // 1 WETH (18 dec) → USDC (6 dec) at price 2000, 0.5% slippage
    await swapIfNeeded(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      swArgs({
        amountIn: ONE_ETH, currentPrice: 2000,
        decimalsIn: 18, decimalsOut: 6, isToken0To1: true, slippagePct: 0.5,
      }));
    // expected = 1e18 * 2000 * 1e-12 = 2e9; min = 2e9 * 9950/10000 = 1.99e9
    assert.strictEqual(captured.amountOutMinimum, 1_990_000_000n);
  });

  it('1% slippage on equal-decimal tokens', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.router] = {
      exactInputSingle: async (p) => { captured = p; return makeTx('0xs'); },
    };
    await swapIfNeeded(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      swArgs({ slippagePct: 1, amountIn: 1_000_000n }));
    // expected = 1_000_000 * 1.0 * 1 = 1_000_000; min = 990_000
    assert.strictEqual(captured.amountOutMinimum, 990000n);
  });
});

// ── Recipient always equals signer ──────────────────────────────────────────
describe('Fund safety — recipient is always signer', () => {
  const SIGNER_ADDR = '0xMySigner0000000000000000000000000000001';

  it('collect() recipient is the signer address', async () => {
    let captured;
    let collected = false;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async (p) => { captured = p; collected = true; return { wait: async () => ({ hash: '0xc', logs: [] }) }; },
    };
    d[ADDR.token0] = { ...d[ADDR.token0], balanceOf: async () => (collected ? 5n * ONE_ETH : 0n) };
    d[ADDR.token1] = { ...d[ADDR.token1], balanceOf: async () => (collected ? 5n * ONE_ETH : 0n) };
    await removeLiquidity(mockSigner(SIGNER_ADDR),
      buildMockEthersLib({ contractDispatch: d }),
      { positionManagerAddress: ADDR.pm, tokenId: 1n, liquidity: 100n,
        recipient: SIGNER_ADDR, token0: ADDR.token0, token1: ADDR.token1 });
    assert.strictEqual(captured.recipient, SIGNER_ADDR);
  });

  it('collect() uses MAX_UINT128 to claim all owed tokens', async () => {
    let captured;
    let collected = false;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async (p) => { captured = p; collected = true; return { wait: async () => ({ hash: '0xc', logs: [] }) }; },
    };
    d[ADDR.token0] = { ...d[ADDR.token0], balanceOf: async () => (collected ? 5n * ONE_ETH : 0n) };
    d[ADDR.token1] = { ...d[ADDR.token1], balanceOf: async () => (collected ? 5n * ONE_ETH : 0n) };
    await removeLiquidity(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      { positionManagerAddress: ADDR.pm, tokenId: 1n, liquidity: 100n,
        recipient: ADDR.signer, token0: ADDR.token0, token1: ADDR.token1 });
    assert.strictEqual(captured.amount0Max, _MAX_UINT128);
    assert.strictEqual(captured.amount1Max, _MAX_UINT128);
  });

  it('mint() recipient is the signer address', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async (p) => { captured = p; return makeMintTx('0xm'); } };
    await mintPosition(mockSigner(SIGNER_ADDR),
      buildMockEthersLib({ contractDispatch: d }),
      { positionManagerAddress: ADDR.pm, token0: ADDR.token0, token1: ADDR.token1,
        fee: 3000, tickLower: -600, tickUpper: 600,
        amount0Desired: 1000n, amount1Desired: 1000n,
        slippagePct: 0.5, recipient: SIGNER_ADDR, deadline: 9999999999n });
    assert.strictEqual(captured.recipient, SIGNER_ADDR);
  });
});

// ── Ownership check ─────────────────────────────────────────────────────────
describe('Fund safety — ownership verification', () => {
  it('rejects rebalance when wallet does not own the NFT', async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], ownerOf: async () => '0xSomeoneElse' };
    const r = await executeRebalance(mockSigner(),
      buildMockEthersLib({ contractDispatch: d }), rebalOpts());
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('does not own'));
  });
});

// ── Partial failure ─────────────────────────────────────────────────────────
describe('Fund safety — partial failure', () => {
  it('returns success:false when mint fails after remove', async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async () => { throw new Error('mint reverted'); },
    };
    const r = await executeRebalance(mockSigner(),
      buildMockEthersLib({ contractDispatch: d }), rebalOpts());
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('mint reverted'));
  });
});

// ── computeDesiredAmounts guards ────────────────────────────────────────────
describe('Fund safety — computeDesiredAmounts guards', () => {
  const S = 10 ** 18;
  const toks18 = { decimals0: 18, decimals1: 18 };
  const toks6_18 = { decimals0: 6, decimals1: 18 };

  it('swap amount never exceeds available token0', () => {
    const amount0 = BigInt(S);
    const r = computeDesiredAmounts(
      { amount0, amount1: 0n },
      { currentPrice: 1.0, lowerPrice: 0.5, upperPrice: 1.5 }, toks18);
    assert.ok(r.swapAmount <= amount0);
    assert.ok(r.amount0Desired >= 0n);
  });

  it('swap amount never exceeds available token1', () => {
    const amount1 = BigInt(S);
    const r = computeDesiredAmounts(
      { amount0: 0n, amount1 },
      { currentPrice: 1.0, lowerPrice: 0.5, upperPrice: 1.5 }, toks18);
    assert.ok(r.swapAmount <= amount1);
    assert.ok(r.amount1Desired >= 0n);
  });

  it('total value preserved (amount0Desired + swapAmount === amount0)', () => {
    const amount0 = BigInt(S);
    const r = computeDesiredAmounts(
      { amount0, amount1: 0n },
      { currentPrice: 1.0, lowerPrice: 0.5, upperPrice: 1.5 }, toks18);
    if (r.swapDirection === 'token0to1') {
      assert.strictEqual(r.amount0Desired + r.swapAmount, amount0);
    }
  });

  it('handles asymmetric decimals (6 vs 18) without underflow', () => {
    const r = computeDesiredAmounts(
      { amount0: 1_000_000n, amount1: BigInt(S) },
      { currentPrice: 2000, lowerPrice: 1600, upperPrice: 2400 }, toks6_18);
    assert.ok(r.amount0Desired >= 0n);
    assert.ok(r.amount1Desired >= 0n);
  });

  it('handles dust amounts', () => {
    const r = computeDesiredAmounts(
      { amount0: 1n, amount1: 1n },
      { currentPrice: 1.0, lowerPrice: 0.5, upperPrice: 1.5 }, toks18);
    assert.ok(r.amount0Desired >= 0n);
    assert.ok(r.amount1Desired >= 0n);
  });
});

// ── Mint slippage minimums ──────────────────────────────────────────────────
describe('Fund safety — mint slippage minimums', () => {
  it('0% slippage sets min equal to desired', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async (p) => { captured = p; return makeMintTx('0xm'); } };
    await mintPosition(mockSigner(), buildMockEthersLib({ contractDispatch: d }), {
      positionManagerAddress: ADDR.pm, token0: ADDR.token0, token1: ADDR.token1,
      fee: 3000, tickLower: -600, tickUpper: 600,
      amount0Desired: 10000n, amount1Desired: 20000n,
      slippagePct: 0, recipient: ADDR.signer, deadline: 9999999999n,
    });
    assert.strictEqual(captured.amount0Min, 10000n);
    assert.strictEqual(captured.amount1Min, 20000n);
  });

  it('mint minimums are > 0 and ≤ desired', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async (p) => { captured = p; return makeMintTx('0xm'); } };
    await mintPosition(mockSigner(), buildMockEthersLib({ contractDispatch: d }), {
      positionManagerAddress: ADDR.pm, token0: ADDR.token0, token1: ADDR.token1,
      fee: 3000, tickLower: -600, tickUpper: 600,
      amount0Desired: 1_000_000n, amount1Desired: 2_000_000n,
      slippagePct: 5, recipient: ADDR.signer, deadline: 9999999999n,
    });
    assert.ok(captured.amount0Min > 0n && captured.amount0Min <= captured.amount0Desired);
    assert.ok(captured.amount1Min > 0n && captured.amount1Min <= captured.amount1Desired);
  });
});

// ── New range validity ──────────────────────────────────────────────────────
describe('Fund safety — new range validity', () => {
  it('contains current tick for typical price', () => {
    const price = 1.0;
    const { lowerTick, upperTick } = computeNewRange(price, 20, 3000, 18, 18);
    const tick = priceToTick(price, 18, 18);
    assert.ok(lowerTick <= tick);
    assert.ok(upperTick >= tick);
  });
  it('contains current tick for small price', () => {
    const price = 0.00042;
    const { lowerTick, upperTick } = computeNewRange(price, 20, 3000, 18, 6);
    const tick = priceToTick(price, 18, 6);
    assert.ok(lowerTick <= tick);
    assert.ok(upperTick >= tick);
  });
  it('lowerTick < upperTick for all fee tiers', () => {
    for (const fee of [100, 500, 2500, 3000, 10000]) {
      const { lowerTick, upperTick } = computeNewRange(1.0, 10, fee, 18, 18);
      assert.ok(lowerTick < upperTick);
    }
  });
});
