'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const {
  encryptAndSave,
  loadAndDecrypt,
  _FORMAT_VERSION,
  _PBKDF2_ITERATIONS,
} = require('../src/key-store');

// ── Helpers ──────────────────────────────────────────────────────────────────

const TMP_DIR = path.join(__dirname, '..', 'tmp');

/** Create a unique temp file path that is cleaned up after the test. */
const tmpFiles = [];
function tmpPath() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, `key-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch (_) { /* already gone */ }
  }
  tmpFiles.length = 0;
});

// ── Constants ────────────────────────────────────────────────────────────────

describe('key-store constants', () => {
  it('_FORMAT_VERSION is 1', () => {
    assert.strictEqual(_FORMAT_VERSION, 1);
  });

  it('_PBKDF2_ITERATIONS is 600000', () => {
    assert.strictEqual(_PBKDF2_ITERATIONS, 600_000);
  });
});

// ── encryptAndSave ───────────────────────────────────────────────────────────

describe('encryptAndSave', () => {
  it('creates a JSON file at the specified path', async () => {
    const fp = tmpPath();
    await encryptAndSave('0xdeadbeef', 'test-pass', fp);
    assert.ok(fs.existsSync(fp));
  });

  it('file contains expected JSON fields', async () => {
    const fp = tmpPath();
    await encryptAndSave('0xdeadbeef', 'test-pass', fp);
    const payload = JSON.parse(fs.readFileSync(fp, 'utf8'));
    assert.strictEqual(payload.version, 1);
    assert.strictEqual(payload.kdf, 'pbkdf2');
    assert.strictEqual(payload.cipher, 'aes-256-gcm');
    assert.strictEqual(payload.kdfParams.digest, 'sha512');
    assert.strictEqual(payload.kdfParams.iterations, 600000);
    assert.ok(payload.kdfParams.saltHex.length > 0);
    assert.ok(payload.ivHex.length > 0);
    assert.ok(payload.authTagHex.length > 0);
    assert.ok(payload.ciphertextHex.length > 0);
  });

  it('uses a different salt and IV each time', async () => {
    const fp1 = tmpPath();
    const fp2 = tmpPath();
    await encryptAndSave('0xdeadbeef', 'test-pass', fp1);
    await encryptAndSave('0xdeadbeef', 'test-pass', fp2);
    const p1 = JSON.parse(fs.readFileSync(fp1, 'utf8'));
    const p2 = JSON.parse(fs.readFileSync(fp2, 'utf8'));
    assert.notStrictEqual(p1.kdfParams.saltHex, p2.kdfParams.saltHex);
    assert.notStrictEqual(p1.ivHex, p2.ivHex);
  });

  it('throws if privateKey is empty', async () => {
    await assert.rejects(() => encryptAndSave('', 'pass', tmpPath()),
      { message: /privateKey must be a non-empty string/ });
  });

  it('throws if password is empty', async () => {
    await assert.rejects(() => encryptAndSave('0xkey', '', tmpPath()),
      { message: /password must be a non-empty string/ });
  });

  it('throws if privateKey is not a string', async () => {
    await assert.rejects(() => encryptAndSave(null, 'pass', tmpPath()),
      { message: /privateKey must be a non-empty string/ });
  });
});

// ── loadAndDecrypt ───────────────────────────────────────────────────────────

describe('loadAndDecrypt', () => {
  it('decrypts to the original private key', async () => {
    const key = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const fp = tmpPath();
    await encryptAndSave(key, 'secret123', fp);
    const result = await loadAndDecrypt('secret123', fp);
    assert.strictEqual(result, key);
  });

  it('handles keys without 0x prefix', async () => {
    const key = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const fp = tmpPath();
    await encryptAndSave(key, 'pw', fp);
    const result = await loadAndDecrypt('pw', fp);
    assert.strictEqual(result, key);
  });

  it('throws with wrong password', async () => {
    const fp = tmpPath();
    await encryptAndSave('0xkey', 'correct', fp);
    await assert.rejects(() => loadAndDecrypt('wrong', fp),
      { message: /Decryption failed/ });
  });

  it('throws if file does not exist', async () => {
    await assert.rejects(() => loadAndDecrypt('pass', path.join(TMP_DIR, 'nonexistent-key-file.json')),
      { message: /Key file not found/ });
  });

  it('throws if file is not valid JSON', async () => {
    const fp = tmpPath();
    fs.writeFileSync(fp, 'not-json{{{');
    await assert.rejects(() => loadAndDecrypt('pass', fp),
      { message: /not valid JSON/ });
  });

  it('throws if file has unsupported version', async () => {
    const fp = tmpPath();
    fs.writeFileSync(fp, JSON.stringify({ version: 99 }));
    await assert.rejects(() => loadAndDecrypt('pass', fp),
      { message: /Unsupported key file version/ });
  });

  it('throws if password is empty', async () => {
    await assert.rejects(() => loadAndDecrypt('', tmpPath()),
      { message: /password must be a non-empty string/ });
  });
});

// ── Round-trip ───────────────────────────────────────────────────────────────

describe('round-trip', () => {
  it('works with a long password', async () => {
    const key = '0xaaaa';
    const pw = 'a'.repeat(200);
    const fp = tmpPath();
    await encryptAndSave(key, pw, fp);
    assert.strictEqual(await loadAndDecrypt(pw, fp), key);
  });

  it('works with unicode characters in password', async () => {
    const key = '0xbbbb';
    const pw = '\u{1F512}secure\u00E9';
    const fp = tmpPath();
    await encryptAndSave(key, pw, fp);
    assert.strictEqual(await loadAndDecrypt(pw, fp), key);
  });
});
