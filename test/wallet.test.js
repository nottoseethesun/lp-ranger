/**
 * @file test/wallet.test.js
 * @description Unit tests for the wallet module.
 * Run with: npm test
 */

'use strict';
const { describe, it } = require('node:test');

const assert = require('assert');
const {
  generateWallet,
  walletFromSeed,
  walletFromKey,
  shortAddress,
  sourceLabel,
  hasOnChainActivity,
  DEFAULT_DERIVATION_PATH,
} = require('../src/wallet');

// ── Mock ethers ───────────────────────────────────────────────────────────────

// Because `new ethers.Wallet(key)` is a constructor call, we need a class mock.
// We attach it separately for tests that need it.
function buildEthersWithWalletClass(address = '0xAbCd1234AbCd1234AbCd1234AbCd1234AbCd1234',
                                     privKey = '0x' + 'a'.repeat(64),
                                     shouldThrow = false) {
  const MockWallet = shouldThrow
    ? class { constructor() { throw new Error('invalid key'); } }
    : class { constructor() { this.address = address; this.privateKey = privKey; } };
  const MockHDNode = class {
    static fromPhrase(phrase, _pwd, _path) {
      if (phrase.trim().split(/\s+/).length < 12) throw new Error('invalid mnemonic');
      return { address, privateKey: privKey };
    }
  };
  return { Wallet: MockWallet, HDNodeWallet: MockHDNode };
}

// ── generateWallet ────────────────────────────────────────────────────────────

describe('generateWallet', () => {
  it('returns a WalletData with source=generated', () => {
    // Attach a class-like createRandom — we stub the call result inline
    const eth = {
      Wallet: {
        createRandom: () => ({
          address:    '0xABC',
          privateKey: '0xKey',
          mnemonic:   { phrase: 'a b c d e f g h i j k l' },
        }),
      },
    };
    const result = generateWallet(eth);
    assert.strictEqual(result.source,     'generated');
    assert.strictEqual(result.address,    '0xABC');
    assert.strictEqual(result.privateKey, '0xKey');
    assert.strictEqual(result.mnemonic,   'a b c d e f g h i j k l');
  });
});

// ── walletFromSeed ────────────────────────────────────────────────────────────

describe('walletFromSeed', () => {
  const VALID_PHRASE = Array(12).fill('abandon').join(' ');

  it('returns valid=true for a 12-word phrase', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromSeed(eth, VALID_PHRASE);
    assert.strictEqual(result.valid, true);
    assert.ok(result.wallet !== null);
    assert.strictEqual(result.wallet.source, 'seed');
  });

  it('returns valid=false for < 12 words', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromSeed(eth, 'only five words here');
    assert.strictEqual(result.valid,  false);
    assert.strictEqual(result.wallet, null);
    assert.match(result.message, /12 or 24/i);
  });

  it('returns valid=false for 13 words', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromSeed(eth, Array(13).fill('abandon').join(' '));
    assert.strictEqual(result.valid, false);
  });

  it('accepts 24-word phrase', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromSeed(eth, Array(24).fill('abandon').join(' '));
    assert.strictEqual(result.valid, true);
  });

  it('returns valid=false when ethers throws (invalid mnemonic)', () => {
    // Simulate ethers rejecting the mnemonic
    const eth = {
      HDNodeWallet: {
        fromPhrase: () => { throw new Error('invalid mnemonic'); },
      },
    };
    const result = walletFromSeed(eth, VALID_PHRASE);
    assert.strictEqual(result.valid, false);
    assert.match(result.message, /invalid/i);
  });

  it('uses DEFAULT_DERIVATION_PATH when path not supplied', () => {
    let capturedPath;
    const eth = {
      HDNodeWallet: {
        fromPhrase: (_phrase, _pwd, path) => {
          capturedPath = path;
          return { address: '0xA', privateKey: '0xB' };
        },
      },
    };
    walletFromSeed(eth, VALID_PHRASE);
    assert.strictEqual(capturedPath, DEFAULT_DERIVATION_PATH);
  });

  it('preserves trimmed mnemonic in wallet.mnemonic', () => {
    const eth    = buildEthersWithWalletClass();
    const padded = `  ${VALID_PHRASE}  `;
    const result = walletFromSeed(eth, padded);
    assert.strictEqual(result.wallet.mnemonic, VALID_PHRASE);
  });
});

// ── walletFromKey ─────────────────────────────────────────────────────────────

describe('walletFromKey', () => {
  const VALID_HEX = 'a'.repeat(64);

  it('accepts 64-char hex without 0x prefix', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromKey(eth, VALID_HEX);
    assert.strictEqual(result.valid,           true);
    assert.strictEqual(result.wallet.source,   'key');
    assert.strictEqual(result.wallet.mnemonic, null);
  });

  it('accepts 64-char hex with 0x prefix', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromKey(eth, '0x' + VALID_HEX);
    assert.strictEqual(result.valid, true);
  });

  it('returns valid=false for too-short key', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromKey(eth, 'a'.repeat(63));
    assert.strictEqual(result.valid, false);
    assert.match(result.message, /64 hex/i);
  });

  it('returns valid=false for too-long key', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromKey(eth, 'a'.repeat(65));
    assert.strictEqual(result.valid, false);
  });

  it('returns valid=false for non-hex characters', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromKey(eth, 'z'.repeat(64));
    assert.strictEqual(result.valid, false);
  });

  it('returns valid=false when ethers constructor throws', () => {
    const eth    = buildEthersWithWalletClass('', '', true); // throws
    const result = walletFromKey(eth, VALID_HEX);
    assert.strictEqual(result.valid, false);
  });

  it('stored privateKey always has 0x prefix', () => {
    const eth    = buildEthersWithWalletClass();
    const result = walletFromKey(eth, VALID_HEX);
    assert.ok(result.wallet.privateKey.startsWith('0x'));
  });
});

// ── shortAddress ──────────────────────────────────────────────────────────────

describe('shortAddress', () => {
  it('abbreviates a full address', () => {
    const addr   = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
    const result = shortAddress(addr);
    assert.ok(result.includes('…'), 'should contain an ellipsis');
    assert.ok(result.startsWith(addr.slice(0, 8)));
    assert.ok(result.endsWith(addr.slice(-6)));
  });

  it('returns the original string for short input', () => {
    assert.strictEqual(shortAddress('0xAB'), '0xAB');
  });

  it('returns empty string for falsy input', () => {
    assert.strictEqual(shortAddress(''), '');
    assert.strictEqual(shortAddress(null), '');
  });
});

// ── sourceLabel ───────────────────────────────────────────────────────────────

describe('sourceLabel', () => {
  it('returns GENERATED for generated source', () => {
    assert.strictEqual(sourceLabel('generated'), 'GENERATED');
  });
  it('returns SEED IMPORT for seed source', () => {
    assert.strictEqual(sourceLabel('seed'), 'SEED IMPORT');
  });
  it('returns KEY IMPORT for key source', () => {
    assert.strictEqual(sourceLabel('key'), 'KEY IMPORT');
  });
  it('returns UNKNOWN for unrecognised source', () => {
    assert.strictEqual(sourceLabel('other'), 'UNKNOWN');
  });
});

// ── EIP-55 address conformance ───────────────────────────────────────────────

describe('EIP-55 address conformance', () => {
  const ethers = require('ethers');

  it('generateWallet returns an EIP-55 checksummed address', () => {
    const result = generateWallet(ethers);
    assert.strictEqual(result.address, ethers.getAddress(result.address),
      `Generated address is not EIP-55 checksummed: ${result.address}`);
  });

  it('walletFromSeed returns an EIP-55 checksummed address', () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const result = walletFromSeed(ethers, phrase);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.wallet.address, ethers.getAddress(result.wallet.address),
      `Seed-imported address is not EIP-55 checksummed: ${result.wallet.address}`);
  });

  it('walletFromKey returns an EIP-55 checksummed address', () => {
    const key    = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const result = walletFromKey(ethers, key);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.wallet.address, ethers.getAddress(result.wallet.address),
      `Key-imported address is not EIP-55 checksummed: ${result.wallet.address}`);
  });
});

// ── hasOnChainActivity ───────────────────────────────────────────────────────

describe('hasOnChainActivity', () => {
  it('returns true when transaction count is greater than zero', async () => {
    const provider = { getTransactionCount: async () => 17 };
    assert.strictEqual(await hasOnChainActivity(provider, '0xABC'), true);
  });

  it('returns true for transaction count of 1', async () => {
    const provider = { getTransactionCount: async () => 1 };
    assert.strictEqual(await hasOnChainActivity(provider, '0xABC'), true);
  });

  it('returns false when transaction count is zero', async () => {
    const provider = { getTransactionCount: async () => 0 };
    assert.strictEqual(await hasOnChainActivity(provider, '0xABC'), false);
  });

  it('returns false when provider throws (network error)', async () => {
    const provider = { getTransactionCount: async () => { throw new Error('network timeout'); } };
    assert.strictEqual(await hasOnChainActivity(provider, '0xABC'), false);
  });

  it('returns false when provider rejects', async () => {
    const provider = { getTransactionCount: () => Promise.reject(new Error('RPC down')) };
    assert.strictEqual(await hasOnChainActivity(provider, '0xABC'), false);
  });

  it('passes the address through to the provider', async () => {
    let captured;
    const provider = { getTransactionCount: async (addr) => { captured = addr; return 5; } };
    await hasOnChainActivity(provider, '0xDeAdBeEf');
    assert.strictEqual(captured, '0xDeAdBeEf');
  });
});
