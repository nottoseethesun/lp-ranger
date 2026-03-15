'use strict';

/**
 * @file test/cache-store.test.js
 * @description Unit tests for the cache-store module.
 * Run with: npm test
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');
const { createCacheStore } = require('../src/cache-store');

// ── Mock fs ─────────────────────────────────────────────────────────────────

function createMockFs() {
  const files = {};
  return {
    files,
    readFileSync(path) {
      if (files[path] === undefined) throw new Error('ENOENT');
      return files[path];
    },
    writeFileSync(path, data) {
      files[path] = data;
    },
    mkdirSync() {},
  };
}

// ── Basic operations ────────────────────────────────────────────────────────

describe('cache-store — basic operations', () => {
  let mockFs;

  beforeEach(() => {
    mockFs = createMockFs();
  });

  it('get returns null for missing key', async () => {
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    assert.strictEqual(await cache.get('missing'), null);
  });

  it('set + get round-trip', async () => {
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    await cache.set('key1', { data: 42 });
    const result = await cache.get('key1');
    assert.deepStrictEqual(result, { data: 42 });
  });

  it('persists to disk as JSON', async () => {
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    await cache.set('k', 'v');
    const written = JSON.parse(mockFs.files['/tmp/test-cache.json']);
    assert.ok(written.k);
    assert.strictEqual(written.k.value, 'v');
    assert.ok(written.k.expiresAt > Date.now());
  });

  it('loads from disk on first access', async () => {
    const expiresAt = Date.now() + 60_000;
    mockFs.files['/tmp/test-cache.json'] = JSON.stringify({
      preloaded: { value: 'hello', expiresAt },
    });
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    assert.strictEqual(await cache.get('preloaded'), 'hello');
  });

  it('delete removes an entry', async () => {
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    await cache.set('k', 'v');
    const deleted = await cache.delete('k');
    assert.strictEqual(deleted, true);
    assert.strictEqual(await cache.get('k'), null);
  });

  it('delete returns false for missing key', async () => {
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    const deleted = await cache.delete('nope');
    assert.strictEqual(deleted, false);
  });

  it('clear removes all entries', async () => {
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.clear();
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(await cache.get('a'), null);
  });

  it('size returns the number of entries', async () => {
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    assert.strictEqual(cache.size(), 0);
    await cache.set('a', 1);
    await cache.set('b', 2);
    assert.strictEqual(cache.size(), 2);
  });
});

// ── TTL expiry ──────────────────────────────────────────────────────────────

describe('cache-store — TTL expiry', () => {
  it('returns null for expired entries', async () => {
    const mockFs = createMockFs();
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      defaultTtlMs: 1, // 1ms TTL
      fsModule: mockFs,
    });
    await cache.set('ephemeral', 'data');
    // Wait briefly for expiry
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(await cache.get('ephemeral'), null);
  });

  it('respects per-key TTL override', async () => {
    const mockFs = createMockFs();
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      defaultTtlMs: 86_400_000,
      fsModule: mockFs,
    });
    await cache.set('short', 'gone', 1); // 1ms
    await cache.set('long', 'here', 86_400_000);
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(await cache.get('short'), null);
    assert.strictEqual(await cache.get('long'), 'here');
  });
});

// ── Error resilience ────────────────────────────────────────────────────────

describe('cache-store — error resilience', () => {
  it('starts empty when cache file is corrupt', async () => {
    const mockFs = createMockFs();
    mockFs.files['/tmp/test-cache.json'] = 'NOT VALID JSON';
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(await cache.get('anything'), null);
  });

  it('survives write failure gracefully', async () => {
    const mockFs = createMockFs();
    mockFs.writeFileSync = () => { throw new Error('disk full'); };
    const cache = createCacheStore({
      filePath: '/tmp/test-cache.json',
      fsModule: mockFs,
    });
    // Should not throw
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      await cache.set('k', 'v');
      assert.ok(warnings.some((w) => w.includes('disk full')));
    } finally {
      console.warn = origWarn;
    }
  });
});
