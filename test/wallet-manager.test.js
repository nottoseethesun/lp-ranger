'use strict';

/**
 * @file test/wallet-manager.test.js
 * @description Tests for the server-side wallet manager (src/wallet-manager.js).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  importWallet, revealWallet, getStatus, clearWallet,
  getAddress, hasWallet,
} = require('../src/wallet-manager');

const WALLET_FILE = path.join(process.cwd(), '.wallet.json');

const SAMPLE = {
  address:    '0xAbCdEf0000000000000000000000000000000001',
  privateKey: '0x' + 'ab'.repeat(32),
  mnemonic:   'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  source:     'seed',
  password:   'test-password-123',
};

describe('wallet-manager', () => {
  beforeEach(() => clearWallet());
  afterEach(() => { try { fs.unlinkSync(WALLET_FILE); } catch { /* ok */ } });

  it('starts with no wallet loaded', () => {
    assert.strictEqual(hasWallet(), false);
    assert.strictEqual(getAddress(), null);
    assert.deepStrictEqual(getStatus(), {
      loaded: false, address: null, source: null, hasMnemonic: false,
    });
  });

  it('importWallet stores address and status', async () => {
    await importWallet(SAMPLE);
    assert.strictEqual(hasWallet(), true);
    assert.strictEqual(getAddress(), SAMPLE.address);
    const s = getStatus();
    assert.strictEqual(s.loaded, true);
    assert.strictEqual(s.source, 'seed');
    assert.strictEqual(s.hasMnemonic, true);
  });

  it('revealWallet returns secrets with correct password', async () => {
    await importWallet(SAMPLE);
    const secrets = await revealWallet(SAMPLE.password);
    assert.strictEqual(secrets.privateKey, SAMPLE.privateKey);
    assert.strictEqual(secrets.mnemonic, SAMPLE.mnemonic);
  });

  it('revealWallet throws with wrong password', async () => {
    await importWallet(SAMPLE);
    await assert.rejects(
      () => revealWallet('wrong-password'),
      { message: 'Wrong password' },
    );
  });

  it('revealWallet throws when no wallet loaded', async () => {
    await assert.rejects(
      () => revealWallet('any'),
      { message: 'No wallet loaded' },
    );
  });

  it('clearWallet removes all state', async () => {
    await importWallet(SAMPLE);
    clearWallet();
    assert.strictEqual(hasWallet(), false);
    assert.strictEqual(getAddress(), null);
  });

  it('importWallet without mnemonic sets hasMnemonic=false', async () => {
    await importWallet({ ...SAMPLE, mnemonic: null });
    const s = getStatus();
    assert.strictEqual(s.hasMnemonic, false);
    const secrets = await revealWallet(SAMPLE.password);
    assert.strictEqual(secrets.mnemonic, null);
  });

  it('importWallet rejects missing password', async () => {
    await assert.rejects(
      () => importWallet({ ...SAMPLE, password: '' }),
      { message: /Password is required/ },
    );
  });

  it('importWallet rejects missing privateKey', async () => {
    await assert.rejects(
      () => importWallet({ ...SAMPLE, privateKey: '' }),
      { message: /Private key is required/ },
    );
  });

  it('importWallet rejects missing address', async () => {
    await assert.rejects(
      () => importWallet({ ...SAMPLE, address: '' }),
      { message: /Address is required/ },
    );
  });

  it('re-import replaces previous wallet', async () => {
    await importWallet(SAMPLE);
    const newAddr = '0x1111111111111111111111111111111111111111';
    await importWallet({ ...SAMPLE, address: newAddr, password: 'new-pw' });
    assert.strictEqual(getAddress(), newAddr);
    const secrets = await revealWallet('new-pw');
    assert.strictEqual(secrets.privateKey, SAMPLE.privateKey);
  });

  // ── Persistence tests ──────────────────────────────────────────────────

  it('importWallet writes .wallet.json to disk', async () => {
    await importWallet(SAMPLE);
    assert.ok(fs.existsSync(WALLET_FILE), '.wallet.json should exist after import');
    const raw = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    assert.strictEqual(raw.address, SAMPLE.address);
    assert.ok(raw.encrypted, 'encrypted blob should be present');
    assert.ok(raw.encrypted.ciphertextHex, 'ciphertext should be present');
    // Plaintext private key must NOT appear in the file
    const fileContents = fs.readFileSync(WALLET_FILE, 'utf8');
    assert.ok(!fileContents.includes(SAMPLE.privateKey.slice(2)),
      'plaintext private key must not appear in .wallet.json');
  });

  it('clearWallet removes .wallet.json from disk', async () => {
    await importWallet(SAMPLE);
    assert.ok(fs.existsSync(WALLET_FILE));
    clearWallet();
    assert.ok(!fs.existsSync(WALLET_FILE), '.wallet.json should be deleted after clear');
  });

  it('clearWallet does not throw if .wallet.json does not exist', () => {
    assert.doesNotThrow(() => clearWallet());
  });
});
