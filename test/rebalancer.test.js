'use strict';
const { describe, it } = require('node:test');
const assert = require('assert');
const {
  getPoolState, removeLiquidity, computeDesiredAmounts,
  swapIfNeeded, mintPosition, executeRebalance,
  _MAX_UINT128, _DEADLINE_SECONDS, _MIN_SWAP_THRESHOLD, V3_FEE_TIERS,
} = require('../src/rebalancer');

// ── Addresses & helpers ──────────────────────────────────────────────────────
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

/** Make a mint tx that includes a valid IncreaseLiquidity event. */
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

/**
 * Default mock dispatch. The balanceOf for tokens returns different values
 * before and after collect so balance-diff works (before=0, after=5 ETH).
 */
function defaultDispatch() {
  // Track collect calls to switch balanceOf from "before" to "after"
  let collected = false;
  return {
    [ADDR.factory]: { getPool: async () => ADDR.pool },
    [ADDR.pool]:    { slot0: async () => ({ sqrtPriceX96: Q96, tick: 0n }) },
    [ADDR.token0]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx('0xapprove0'),
      allowance: async () => 0n,
    },
    [ADDR.token1]: {
      decimals: async () => 18n,
      balanceOf: async () => (collected ? 5n * ONE_ETH : 0n),
      approve: async () => makeTx('0xapprove1'),
      allowance: async () => 0n,
    },
    [ADDR.pm]: {
      ownerOf: async () => ADDR.signer,
      positions: async () => ({ liquidity: 5000n, tokensOwed0: 0n, tokensOwed1: 0n }),
      decreaseLiquidity: async () => makeTx('0xdecrease'),
      collect: async () => { collected = true; return { wait: async () => ({ hash: '0xcollect', logs: [] }) }; },
      mint: async () => makeMintTx('0xmint'),
    },
    [ADDR.router]: { exactInputSingle: async () => makeTx('0xswap') },
  };
}

function buildMockEthersLib(overrides = {}) {
  const contractDispatch = overrides.contractDispatch ?? defaultDispatch();
  function MockContract(addr, _abi, _signer) {
    const self = this;
    const methods = contractDispatch[addr];
    if (!methods) throw new Error(`No mock for address: ${addr}`);
    for (const [name, fn] of Object.entries(methods)) this[name] = fn;
    // Mock interface.encodeFunctionData + multicall for atomic decrease+collect
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
  return {
    Contract: MockContract,
    ZeroAddress: ZERO_ADDRESS,
    ...(overrides.extra ?? {}),
  };
}

const poolArgs = {
  factoryAddress: ADDR.factory,
  token0: ADDR.token0, token1: ADDR.token1, fee: 3000,
};

// ── Constants ────────────────────────────────────────────────────────────────
describe('Constants', () => {
  it('_MAX_UINT128 equals 2n**128n - 1n', () => {
    assert.strictEqual(_MAX_UINT128, 2n ** 128n - 1n);
  });
  it('V3_FEE_TIERS contains [100, 500, 2500, 3000, 10000]', () => {
    assert.deepStrictEqual(V3_FEE_TIERS, [100, 500, 2500, 3000, 10000]);
  });
  it('_MIN_SWAP_THRESHOLD is 1000n', () => {
    assert.strictEqual(_MIN_SWAP_THRESHOLD, 1000n);
  });
});

// ── getPoolState ─────────────────────────────────────────────────────────────
describe('getPoolState', () => {
  it('returns correct price, tick, decimals, poolAddress', async () => {
    const r = await getPoolState({}, buildMockEthersLib(), poolArgs);
    assert.strictEqual(r.poolAddress, ADDR.pool);
    assert.strictEqual(r.decimals0, 18);
    assert.strictEqual(r.decimals1, 18);
    assert.strictEqual(typeof r.price, 'number');
    assert.strictEqual(typeof r.tick, 'number');
  });
  it('returns price close to 1.0 for sqrtPriceX96=Q96 with equal decimals', async () => {
    const r = await getPoolState({}, buildMockEthersLib(), poolArgs);
    assert.ok(Math.abs(r.price - 1.0) < 1e-9);
  });
  it('throws when pool is ZeroAddress', async () => {
    const d = defaultDispatch();
    d[ADDR.factory] = { getPool: async () => ZERO_ADDRESS };
    await assert.rejects(
      () => getPoolState({}, buildMockEthersLib({ contractDispatch: d }), poolArgs),
      { message: /Pool not found/ },
    );
  });
  it('returns correct tick from slot0', async () => {
    const d = defaultDispatch();
    d[ADDR.pool] = { slot0: async () => ({ sqrtPriceX96: Q96, tick: 42n }) };
    const r = await getPoolState({}, buildMockEthersLib({ contractDispatch: d }), poolArgs);
    assert.strictEqual(r.tick, 42);
  });
  it('handles different decimals for token0 and token1', async () => {
    const d = defaultDispatch();
    d[ADDR.token0] = { ...d[ADDR.token0], decimals: async () => 6n };
    const r = await getPoolState({}, buildMockEthersLib({ contractDispatch: d }), poolArgs);
    assert.strictEqual(r.decimals0, 6);
    assert.strictEqual(r.decimals1, 18);
  });
});

// ── removeLiquidity ──────────────────────────────────────────────────────────
describe('removeLiquidity', () => {
  const rmArgs = (extra) => ({
    positionManagerAddress: ADDR.pm, tokenId: 1n,
    liquidity: 1000n, recipient: ADDR.signer, deadline: 9999999999n,
    token0: ADDR.token0, token1: ADDR.token1, ...extra,
  });

  it('calls decrease then collect via multicall, returns amounts via balance-diff', async () => {
    const order = [];
    let phase = 0;
    const d = defaultDispatch();
    d[ADDR.token0] = { ...d[ADDR.token0], balanceOf: async () => (phase >= 2 ? ONE_ETH : 0n) };
    d[ADDR.token1] = { ...d[ADDR.token1], balanceOf: async () => (phase >= 2 ? ONE_ETH : 0n) };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      decreaseLiquidity: async () => { order.push('decrease'); return makeTx('0xdec'); },
      collect: async () => { order.push('collect'); phase = 2; return { wait: async () => ({ hash: '0xcol', logs: [] }) }; },
      positions: async () => ({ liquidity: 5000n, tokensOwed0: 0n, tokensOwed1: 0n }),
    };
    const r = await removeLiquidity(mockSigner(), buildMockEthersLib({ contractDispatch: d }), rmArgs());
    assert.deepStrictEqual(order, ['decrease', 'collect']);
    assert.strictEqual(r.txHash, '0xmulticall');
    assert.strictEqual(r.amount0, ONE_ETH);
    assert.strictEqual(r.amount1, ONE_ETH);
  });

  it('uses _MAX_UINT128 for collect amounts', async () => {
    let captured;
    let callCount = 0;
    const d = defaultDispatch();
    // balanceOf must change after collect for balance-diff
    d[ADDR.token0] = { ...d[ADDR.token0], balanceOf: async () => (callCount >= 2 ? ONE_ETH : 0n) };
    d[ADDR.token1] = { ...d[ADDR.token1], balanceOf: async () => (callCount >= 2 ? ONE_ETH : 0n) };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async (p) => { captured = p; callCount = 2; return { wait: async () => ({ hash: '0xc', logs: [] }) }; },
      positions: async () => ({ liquidity: 5000n, tokensOwed0: 0n, tokensOwed1: 0n }),
    };
    await removeLiquidity(mockSigner(), buildMockEthersLib({ contractDispatch: d }), rmArgs());
    assert.strictEqual(captured.amount0Max, _MAX_UINT128);
    assert.strictEqual(captured.amount1Max, _MAX_UINT128);
  });

  it('uses default deadline when none provided', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      decreaseLiquidity: async (p) => { captured = p; return makeTx('0xdec'); },
    };
    const before = BigInt(Math.floor(Date.now() / 1000));
    await removeLiquidity(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      rmArgs({ deadline: undefined }));
    const after = BigInt(Math.floor(Date.now() / 1000));
    assert.ok(captured.deadline >= before + BigInt(_DEADLINE_SECONDS));
    assert.ok(captured.deadline <= after + BigInt(_DEADLINE_SECONDS) + 1n);
  });

  it('throws when balance-diff is zero (prevents empty mint)', async () => {
    const d = defaultDispatch();
    // balanceOf returns 0 both before and after → diff = 0
    d[ADDR.token0] = { ...d[ADDR.token0], balanceOf: async () => 0n };
    d[ADDR.token1] = { ...d[ADDR.token1], balanceOf: async () => 0n };
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      collect: async () => ({ wait: async () => ({ hash: '0xc', logs: [] }) }),
      positions: async () => ({ liquidity: 5000n, tokensOwed0: 0n, tokensOwed1: 0n }),
    };
    await assert.rejects(
      () => removeLiquidity(mockSigner(), buildMockEthersLib({ contractDispatch: d }), rmArgs()),
      { message: /Collected 0 tokens/ },
    );
  });
});

// ── computeDesiredAmounts ────────────────────────────────────────────────────
describe('computeDesiredAmounts', () => {
  const S = 10 ** 18;
  const range = { currentPrice: 1.0, lowerPrice: 0.5, upperPrice: 1.5 };
  const toks = { decimals0: 18, decimals1: 18 };

  it('returns no-swap when ratio difference <= 0.01', () => {
    // V3 sqrt-based target ratio at price=1.0 in [0.5, 1.5] ≈ 0.385
    // So ~38.5% value in token0, ~61.5% in token1 (at price=1.0, value = amount)
    const amt0 = BigInt(Math.floor(0.385 * S));
    const amt1 = BigInt(Math.floor(0.615 * S));
    const r = computeDesiredAmounts({ amount0: amt0, amount1: amt1 }, range, toks);
    assert.strictEqual(r.needsSwap, false);
  });
  it('returns zero amounts when totalValue is 0', () => {
    const r = computeDesiredAmounts({ amount0: 0n, amount1: 0n }, range, toks);
    assert.strictEqual(r.amount0Desired, 0n);
    assert.strictEqual(r.needsSwap, false);
  });
  it('identifies token0to1 swap when too much token0', () => {
    const r = computeDesiredAmounts({ amount0: BigInt(S), amount1: 0n }, range, toks);
    assert.strictEqual(r.swapDirection, 'token0to1');
    assert.ok(r.swapAmount > 0n);
  });
  it('identifies token1to0 swap when too much token1', () => {
    const r = computeDesiredAmounts({ amount0: 0n, amount1: BigInt(S) }, range, toks);
    assert.strictEqual(r.swapDirection, 'token1to0');
    assert.ok(r.swapAmount > 0n);
  });
});

// ── swapIfNeeded ─────────────────────────────────────────────────────────────
describe('swapIfNeeded', () => {
  const swArgs = (extra) => ({
    swapRouterAddress: ADDR.router, tokenIn: ADDR.token0, tokenOut: ADDR.token1,
    fee: 3000, amountIn: 2000n, slippagePct: 0.5, recipient: ADDR.signer,
    currentPrice: 1.0, decimalsIn: 18, decimalsOut: 18, isToken0To1: true,
    deadline: 9999999999n, ...extra,
  });

  it('skips swap when amountIn < _MIN_SWAP_THRESHOLD', async () => {
    const r = await swapIfNeeded(mockSigner(), buildMockEthersLib(), swArgs({ amountIn: 999n }));
    assert.strictEqual(r.amountOut, 0n);
    assert.strictEqual(r.txHash, null);
  });
  it('calls approve and exactInputSingle', async () => {
    const calls = [];
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0], allowance: async () => 0n,
      approve: async () => { calls.push('approve'); return makeTx('0xa'); },
    };
    d[ADDR.router] = {
      exactInputSingle: async () => { calls.push('swap'); return makeTx('0xs'); },
    };
    await swapIfNeeded(mockSigner(), buildMockEthersLib({ contractDispatch: d }), swArgs());
    assert.ok(calls.includes('approve'));
    assert.ok(calls.includes('swap'));
  });
  it('returns txHash from receipt', async () => {
    const r = await swapIfNeeded(mockSigner(), buildMockEthersLib(), swArgs());
    assert.strictEqual(r.txHash, '0xswap');
  });

  it('computes price-based amountOutMinimum for different-valued tokens', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.router] = {
      exactInputSingle: async (p) => { captured = p; return makeTx('0xs'); },
    };
    // Swapping 1 WETH (18 dec) for USDC (6 dec) at price 2000
    await swapIfNeeded(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      swArgs({
        amountIn: ONE_ETH,
        currentPrice: 2000, decimalsIn: 18, decimalsOut: 6,
        isToken0To1: true, slippagePct: 0.5,
      }));
    // expected USDC = 1e18 * 2000 * 10^(6-18) = 2000e6 = 2_000_000_000
    // min = 2_000_000_000 * 9950 / 10000 = 1_990_000_000
    assert.strictEqual(captured.amountOutMinimum, 1_990_000_000n);
  });
});

// ── mintPosition ─────────────────────────────────────────────────────────────
describe('mintPosition', () => {
  const mtArgs = (extra) => ({
    positionManagerAddress: ADDR.pm, token0: ADDR.token0, token1: ADDR.token1,
    fee: 3000, tickLower: -600, tickUpper: 600,
    amount0Desired: 1000000n, amount1Desired: 1000000n,
    slippagePct: 0.5, recipient: ADDR.signer, deadline: 9999999999n, ...extra,
  });

  it('approves exact amounts (not unlimited)', async () => {
    const approvedAmounts = [];
    const d = defaultDispatch();
    d[ADDR.token0] = {
      allowance: async () => 0n,
      approve: async (_spender, amt) => { approvedAmounts.push(amt); return makeTx('0xa'); },
    };
    d[ADDR.token1] = {
      allowance: async () => 0n,
      approve: async (_spender, amt) => { approvedAmounts.push(amt); return makeTx('0xa'); },
    };
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeMintTx('0xm', 42n, 5000n, 5000n, 7000n) };
    await mintPosition(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      mtArgs({ amount0Desired: 5000n, amount1Desired: 7000n }));
    assert.ok(approvedAmounts.includes(5000n), 'should approve exact amount0');
    assert.ok(approvedAmounts.includes(7000n), 'should approve exact amount1');
  });

  it('computes slippage-adjusted minimums correctly', async () => {
    let captured;
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async (p) => { captured = p; return makeMintTx('0xm', 42n, 5000n, 10000n, 20000n); } };
    await mintPosition(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      mtArgs({ amount0Desired: 10000n, amount1Desired: 20000n, slippagePct: 1 }));
    assert.strictEqual(captured.amount0Min, 9900n);
    assert.strictEqual(captured.amount1Min, 19800n);
  });
  it('returns txHash', async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeMintTx('0xmint') };
    const r = await mintPosition(mockSigner(), buildMockEthersLib({ contractDispatch: d }), mtArgs());
    assert.strictEqual(r.txHash, '0xmint');
  });

  it('parses IncreaseLiquidity event for tokenId and liquidity', async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = {
      ...d[ADDR.pm],
      mint: async () => ({
        wait: async () => ({
          hash: '0xm',
          logs: [{
            topics: [INC_TOPIC, '0x' + '0'.repeat(63) + '7'], // tokenId = 7
            data: '0x'
              + '0'.repeat(63) + 'a'  // liquidity = 10
              + '0'.repeat(62) + '64' // amount0 = 100
              + '0'.repeat(62) + 'c8', // amount1 = 200
          }],
        }),
      }),
    };
    const r = await mintPosition(mockSigner(), buildMockEthersLib({ contractDispatch: d }), mtArgs());
    assert.strictEqual(r.tokenId, 7n);
    assert.strictEqual(r.liquidity, 10n);
    assert.strictEqual(r.amount0, 100n);
    assert.strictEqual(r.amount1, 200n);
  });

  it('throws when no IncreaseLiquidity event (tokenId=0)', async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeTx('0xm') };  // no event
    await assert.rejects(
      () => mintPosition(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
        mtArgs({ amount0Desired: 5000n, amount1Desired: 7000n })),
      { message: /no tokenId was returned/ },
    );
  });
});

// ── swapIfNeeded — balance-diff ──────────────────────────────────────────────
describe('swapIfNeeded — balance-diff output', () => {
  const swArgs = (extra) => ({
    swapRouterAddress: ADDR.router, tokenIn: ADDR.token0, tokenOut: ADDR.token1,
    fee: 3000, amountIn: 2000n, slippagePct: 0.5, recipient: ADDR.signer,
    currentPrice: 1.0, decimalsIn: 18, decimalsOut: 18, isToken0To1: true,
    deadline: 9999999999n, ...extra,
  });

  it('returns actual balance-diff as amountOut', async () => {
    let swapped = false;
    const d = defaultDispatch();
    // tokenOut (token1) balance: 0 before swap, 1500 after
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      balanceOf: async () => (swapped ? 1500n : 0n),
    };
    d[ADDR.router] = {
      exactInputSingle: async () => { swapped = true; return makeTx('0xs'); },
    };
    const r = await swapIfNeeded(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      swArgs({ amountIn: 2000n }));
    assert.strictEqual(r.amountOut, 1500n);
  });
});

// ── _ensureAllowance — skip when sufficient ──────────────────────────────────
describe('_ensureAllowance skip path', () => {
  it('does not call approve when allowance is already sufficient', async () => {
    let approveCalled = false;
    const d = defaultDispatch();
    d[ADDR.token0] = {
      ...d[ADDR.token0],
      allowance: async () => 9999999n,  // already sufficient
      approve: async () => { approveCalled = true; return makeTx('0xa'); },
    };
    d[ADDR.token1] = {
      ...d[ADDR.token1],
      allowance: async () => 9999999n,
      approve: async () => { approveCalled = true; return makeTx('0xa'); },
    };
    d[ADDR.pm] = { ...d[ADDR.pm], mint: async () => makeMintTx('0xm') };
    await mintPosition(mockSigner(), buildMockEthersLib({ contractDispatch: d }),
      { positionManagerAddress: ADDR.pm, token0: ADDR.token0, token1: ADDR.token1,
        fee: 3000, tickLower: -600, tickUpper: 600,
        amount0Desired: 1000n, amount1Desired: 1000n,
        slippagePct: 0.5, recipient: ADDR.signer, deadline: 9999999999n });
    assert.strictEqual(approveCalled, false, 'approve should not be called when allowance is sufficient');
  });
});

// ── V3 fee tier 100 ──────────────────────────────────────────────────────────
describe('V3 fee tier 100 support', () => {
  it('fee tier 100 is accepted by executeRebalance', async () => {
    const r = await executeRebalance(mockSigner(), buildMockEthersLib(), {
      position: {
        tokenId: 1n, token0: ADDR.token0, token1: ADDR.token1,
        fee: 100, liquidity: 5000n, tickLower: -10, tickUpper: 10,
      },
      factoryAddress: ADDR.factory, positionManagerAddress: ADDR.pm,
      swapRouterAddress: ADDR.router, rangeWidthPct: 20, slippagePct: 0.5,
    });
    assert.strictEqual(r.success, true);
  });
});

// ── executeRebalance ─────────────────────────────────────────────────────────
describe('executeRebalance', () => {
  const basePos = {
    tokenId: 1n, token0: ADDR.token0, token1: ADDR.token1,
    fee: 3000, liquidity: 5000n, tickLower: -600, tickUpper: 600,
  };
  const rebalOpts = (posOverride) => ({
    position: { ...basePos, ...posOverride },
    factoryAddress: ADDR.factory, positionManagerAddress: ADDR.pm,
    swapRouterAddress: ADDR.router, rangeWidthPct: 20, slippagePct: 0.5,
  });

  it('full happy path returns success:true with txHashes', async () => {
    const r = await executeRebalance(mockSigner(), buildMockEthersLib(), rebalOpts());
    assert.strictEqual(r.success, true);
    assert.ok(Array.isArray(r.txHashes));
    assert.ok(r.txHashes.length >= 2);
    assert.strictEqual(r.oldTokenId, 1n);
  });
  it('returns success:false on error', async () => {
    const d = defaultDispatch();
    d[ADDR.factory] = { getPool: async () => { throw new Error('rpc failure'); } };
    const r = await executeRebalance(mockSigner(),
      buildMockEthersLib({ contractDispatch: d }), rebalOpts());
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('rpc failure'));
  });
  it('rejects positions without valid fee tier', async () => {
    await assert.rejects(
      () => executeRebalance(mockSigner(), buildMockEthersLib(), rebalOpts({ fee: 42 })),
      { message: /Only V3 NFT positions are supported/ },
    );
  });
  it('rejects positions without tokenId', async () => {
    await assert.rejects(
      () => executeRebalance(mockSigner(), buildMockEthersLib(),
        rebalOpts({ tokenId: undefined })),
      { message: /Only V3 NFT positions are supported/ },
    );
  });
  it('checks NFT ownership before removing liquidity', async () => {
    const d = defaultDispatch();
    d[ADDR.pm] = { ...d[ADDR.pm], ownerOf: async () => '0xSomeoneElse' };
    const r = await executeRebalance(mockSigner(),
      buildMockEthersLib({ contractDispatch: d }), rebalOpts());
    assert.strictEqual(r.success, false);
    assert.ok(r.error.includes('does not own'));
  });

  it('returns liquidity from mint result', async () => {
    const r = await executeRebalance(mockSigner(), buildMockEthersLib(), rebalOpts());
    assert.strictEqual(r.success, true);
    assert.strictEqual(typeof r.liquidity, 'bigint');
    assert.ok(r.liquidity > 0n);
  });
});

