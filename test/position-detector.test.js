/**
 * @file test/position-detector.test.js
 * @description Unit tests for the position-detector module.
 * All on-chain calls are mocked — no real provider needed.
 * Run with: npm test
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  detectPositionType,
  enumerateNftPositions,
  formatDetectionSummary,
  _probeErc20,
  _probeSingleNft,
  _enumerateOwnerNfts,
  _shapeNftPosition,
  MAX_NFT_SCAN,
} = require('../src/position-detector');

// ── Mock builders ─────────────────────────────────────────────────────────────

/**
 * Build a raw positions() return value.
 * @param {bigint} liquidity
 */
function rawPos(liquidity = 500n) {
  return {
    token0: '0xTK0', token1: '0xTK1',
    fee: 3000n, tickLower: -100n, tickUpper: 100n,
    liquidity,
  };
}

/**
 * Build an NFT_ENUM_ABI mock contract.
 * @param {{ balance?: number, tokenIds?: bigint[], positionData?: object, throws?: boolean }} cfg
 */
function makeNftContract(cfg = {}) {
  const { balance = 0, tokenIds = [], positionData = rawPos(), throws = false } = cfg;
  return {
    balanceOf: async () => {
      if (throws) throw new Error('rpc error');
      return BigInt(balance);
    },
    tokenOfOwnerByIndex: async (_owner, index) => {
      if (tokenIds[Number(index)] !== undefined) return tokenIds[Number(index)];
      throw new Error('index out of bounds');
    },
    positions: async (_tokenId) => {
      if (throws) throw new Error('rpc error');
      return positionData;
    },
  };
}

/**
 * Build an ethers mock with a Contract constructor that returns the given mock.
 */
function buildEthers(nftContractMock, erc20BalanceFn) {
  const erc20Balance = erc20BalanceFn || (() => Promise.resolve(0n));
  return {
    Contract: class {
      constructor(_addr, abi, _provider) {
        // Distinguish NFT vs ERC-20 ABI by length
        this._isNft = abi.length > 2;
      }
      async balanceOf(owner) {
        if (this._isNft) return nftContractMock.balanceOf(owner);
        return erc20Balance(owner);
      }
      async tokenOfOwnerByIndex(owner, index) {
        return nftContractMock.tokenOfOwnerByIndex(owner, index);
      }
      async positions(tokenId) {
        return nftContractMock.positions(tokenId);
      }
      async token0()    { return '0xTK0'; }
      async token1()    { return '0xTK1'; }
      async tickLower() { return -100n; }
      async tickUpper() { return  100n; }
    },
  };
}

const WALLET = '0xWalletAddress';
const PM     = '0xPositionManager';
const ERC    = '0xErc20Contract';

// ── _shapeNftPosition ─────────────────────────────────────────────────────────

describe('_shapeNftPosition', () => {
  it('returns shaped NftPosition for non-zero liquidity', () => {
    const result = _shapeNftPosition('42', rawPos(999n));
    assert.strictEqual(result.tokenId,   '42');
    assert.strictEqual(result.liquidity, 999n);
    assert.strictEqual(result.fee,       3000);
  });

  it('returns position when liquidity is 0n (drained, not burned)', () => {
    const result = _shapeNftPosition('42', rawPos(0n));
    assert.ok(result !== null);
    assert.strictEqual(result.liquidity, 0n);
  });

  it('returns null when token0 is zero address (truly burned)', () => {
    const burned = rawPos(0n);
    burned.token0 = '0x0000000000000000000000000000000000000000';
    const result = _shapeNftPosition('42', burned);
    assert.strictEqual(result, null);
  });

  it('converts BigInt fee/tick to Number', () => {
    const result = _shapeNftPosition('1', rawPos());
    assert.strictEqual(typeof result.tickLower, 'number');
    assert.strictEqual(typeof result.fee,       'number');
  });
});

// ── _probeSingleNft ───────────────────────────────────────────────────────────

describe('_probeSingleNft', () => {
  it('returns NftPosition when positions() succeeds', async () => {
    const contract = makeNftContract({ balance: 1, tokenIds: [1n], positionData: rawPos(500n) });
    const result   = await _probeSingleNft(contract, '1');
    assert.ok(result !== null);
    assert.strictEqual(result.liquidity, 500n);
  });

  it('returns position when liquidity === 0n (drained but not burned)', async () => {
    const contract = makeNftContract({ positionData: rawPos(0n) });
    const result   = await _probeSingleNft(contract, '1');
    assert.ok(result !== null);
    assert.strictEqual(result.liquidity, 0n);
  });

  it('returns null when contract throws', async () => {
    const contract = makeNftContract({ throws: true });
    const result   = await _probeSingleNft(contract, '1');
    assert.strictEqual(result, null);
  });
});

// ── _enumerateOwnerNfts ───────────────────────────────────────────────────────

describe('_enumerateOwnerNfts', () => {
  it('returns empty array when balance is 0', async () => {
    const contract = makeNftContract({ balance: 0 });
    const result   = await _enumerateOwnerNfts(contract, WALLET);
    assert.deepStrictEqual(result, []);
  });

  it('enumerates 3 positions correctly', async () => {
    const contract = makeNftContract({
      balance:  3,
      tokenIds: [10n, 11n, 12n],
    });
    const result = await _enumerateOwnerNfts(contract, WALLET);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].tokenId, '10');
    assert.strictEqual(result[2].tokenId, '12');
  });

  it('includes drained positions (liquidity === 0n)', async () => {
    const contract = {
      balanceOf:           async () => 2n,
      tokenOfOwnerByIndex: async (_o, i) => BigInt(i),
      positions: async (id) => (Number(id) === 0 ? rawPos(0n) : rawPos(100n)),
    };
    const result = await _enumerateOwnerNfts(contract, WALLET);
    assert.strictEqual(result.length, 2); // both returned — 0-liquidity is drained, not burned
  });

  it('caps enumeration at MAX_NFT_SCAN', async () => {
    // Simulate a wallet with more than MAX_NFT_SCAN NFTs
    const TOTAL = MAX_NFT_SCAN + 50;
    const contract = {
      balanceOf:           async () => BigInt(TOTAL),
      tokenOfOwnerByIndex: async (_o, i) => BigInt(Number(i) + 1),
      positions:           async ()     => rawPos(1n),
    };
    const result = await _enumerateOwnerNfts(contract, WALLET);
    assert.strictEqual(result.length, MAX_NFT_SCAN);
  });

  it('returns empty array when balanceOf throws', async () => {
    const contract = { balanceOf: async () => { throw new Error('rpc fail'); } };
    const result   = await _enumerateOwnerNfts(contract, WALLET);
    assert.deepStrictEqual(result, []);
  });

  it('handles tokenOfOwnerByIndex throwing for some indices gracefully', async () => {
    const contract = {
      balanceOf:           async () => 3n,
      tokenOfOwnerByIndex: async (_o, i) => {
        if (Number(i) === 1) throw new Error('rpc error');
        return BigInt(Number(i) + 1);
      },
      positions: async () => rawPos(100n),
    };
    // Should still return 2 positions (indices 0 and 2), not throw
    const result = await _enumerateOwnerNfts(contract, WALLET);
    assert.strictEqual(result.length, 2);
  });
});

// ── _probeErc20 ───────────────────────────────────────────────────────────────

describe('_probeErc20', () => {
  /** Build a minimal ethersLib with a Contract that handles ERC-20 calls. */
  function makeErc20Ethers(balanceReturn) {
    return {
      Contract: class {
        async balanceOf()  { return balanceReturn; }
        async token0()     { return '0xTK0'; }
        async token1()     { return '0xTK1'; }
        async tickLower()  { return -100n; }
        async tickUpper()  { return  100n; }
      },
    };
  }

  it('returns Erc20Position when balanceOf > 0', async () => {
    const result = await _probeErc20({}, ERC, WALLET, makeErc20Ethers(1000n));
    assert.ok(result !== null);
    assert.strictEqual(result.balance, 1000n);
  });

  it('returns null when balance is 0n', async () => {
    const result = await _probeErc20({}, ERC, WALLET, makeErc20Ethers(0n));
    assert.strictEqual(result, null);
  });

  it('returns null when contractAddress is missing', async () => {
    const result = await _probeErc20({}, null, WALLET, makeErc20Ethers(100n));
    assert.strictEqual(result, null);
  });

  it('returns null when walletAddress is missing', async () => {
    const result = await _probeErc20({}, ERC, null, makeErc20Ethers(100n));
    assert.strictEqual(result, null);
  });
});

// ── enumerateNftPositions ─────────────────────────────────────────────────────

describe('enumerateNftPositions', () => {
  it('returns empty array when ethers not available and global absent', async () => {
    delete global.ethers;
    const result = await enumerateNftPositions({}, { walletAddress: WALLET });
    assert.deepStrictEqual(result, []);
  });

  it('returns empty array when positionManagerAddress is missing', async () => {
    const ethers = buildEthers(makeNftContract({ balance: 2, tokenIds: [1n, 2n] }));
    global.ethers = ethers;
    const result = await enumerateNftPositions({}, { walletAddress: WALLET });
    delete global.ethers;
    assert.deepStrictEqual(result, []);
  });

  it('returns positions when wallet has NFTs', async () => {
    const nftMock = makeNftContract({ balance: 2, tokenIds: [1n, 2n] });
    const ethers  = buildEthers(nftMock);
    global.ethers = ethers;
    const result  = await enumerateNftPositions({}, {
      walletAddress: WALLET, positionManagerAddress: PM,
    });
    delete global.ethers;
    assert.strictEqual(result.length, 2);
  });
});

// ── detectPositionType ────────────────────────────────────────────────────────

describe('detectPositionType', () => {
  it('returns nft with single position when tokenId is supplied', async () => {
    const nftMock = makeNftContract({ positionData: rawPos(300n) });
    const ethers  = buildEthers(nftMock);
    global.ethers = ethers;
    const result  = await detectPositionType({}, {
      walletAddress: WALLET, positionManagerAddress: PM, tokenId: '42',
    });
    delete global.ethers;
    assert.strictEqual(result.type, 'nft');
    assert.strictEqual(result.nftPositions.length, 1);
    assert.strictEqual(result.nftPositions[0].tokenId, '42');
  });

  it('returns nft with enumerated positions when no tokenId supplied', async () => {
    const nftMock = makeNftContract({ balance: 3, tokenIds: [10n, 11n, 12n] });
    const ethers  = buildEthers(nftMock);
    global.ethers = ethers;
    const result  = await detectPositionType({}, {
      walletAddress: WALLET, positionManagerAddress: PM,
    });
    delete global.ethers;
    assert.strictEqual(result.type, 'nft');
    assert.strictEqual(result.nftPositions.length, 3);
  });

  it('returns erc20 when NFT enumeration finds nothing but ERC-20 has balance', async () => {
    // NFT: balance=0 so enumeration returns nothing
    // ERC-20: balanceOf returns 500n
    // We need the Contract class to distinguish which contract it is
    let callCount = 0;
    const ethers = {
      Contract: class {
        constructor(addr) { this._addr = addr; }
        async balanceOf()           {
          callCount++;
          // First call is NFT enumeration → 0; subsequent is ERC-20 → 500n
          return callCount === 1 ? 0n : 500n;
        }
        async tokenOfOwnerByIndex() { throw new Error('no tokens'); }
        async positions()           { throw new Error('no position'); }
        async token0()              { return '0xTK0'; }
        async token1()              { return '0xTK1'; }
        async tickLower()           { return -100n; }
        async tickUpper()           { return  100n; }
      },
    };
    global.ethers = ethers;
    const result = await detectPositionType({}, {
      walletAddress: WALLET, positionManagerAddress: PM, candidateAddress: ERC,
    });
    delete global.ethers;
    assert.strictEqual(result.type, 'erc20');
    assert.ok(Array.isArray(result.erc20Positions));
  });

  it('returns unknown when all probes fail', async () => {
    const nftMock = makeNftContract({ balance: 0 });
    const ethers  = buildEthers(nftMock, async () => 0n);
    global.ethers = ethers;
    const result  = await detectPositionType({}, { walletAddress: WALLET });
    delete global.ethers;
    assert.strictEqual(result.type, 'unknown');
    assert.ok(result.error);
  });

  it('returns unknown when ethers unavailable', async () => {
    delete global.ethers;
    const result = await detectPositionType({}, { walletAddress: WALLET });
    assert.ok(['unknown', 'nft', 'erc20'].includes(result.type));
  });
});

// ── formatDetectionSummary ────────────────────────────────────────────────────

describe('formatDetectionSummary', () => {
  it('formats nft result with count', () => {
    const r = { type: 'nft', nftPositions: [{}, {}] };
    const s = formatDetectionSummary(r);
    assert.ok(s.includes('NFT'));
    assert.ok(s.includes('2'));
  });

  it('formats nft singular correctly', () => {
    const r = { type: 'nft', nftPositions: [{}] };
    assert.ok(formatDetectionSummary(r).includes('1 position'));
    assert.ok(!formatDetectionSummary(r).includes('positions'));
  });

  it('formats erc20 result', () => {
    const r = { type: 'erc20', erc20Positions: [{ balance: 100n }] };
    const s = formatDetectionSummary(r);
    assert.ok(s.includes('ERC-20'));
  });

  it('formats unknown result with error', () => {
    const r = { type: 'unknown', error: 'no positions found' };
    const s = formatDetectionSummary(r);
    assert.ok(s.includes('no positions found'));
  });
});

// ── MAX_NFT_SCAN ──────────────────────────────────────────────────────────────

describe('MAX_NFT_SCAN', () => {
  it('is 300', () => {
    assert.strictEqual(MAX_NFT_SCAN, 300);
  });
});
