/**
 * @file test/bot-config-v2.test.js
 * @description Tests for bot-config-v2: load, save, composite keys.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  compositeKey,
  parseCompositeKey,
  loadConfig,
  saveConfig,
  getPositionConfig,
  addManagedPosition,
  removeManagedPosition,
  migratePositionKey,
  GLOBAL_KEYS,
  POSITION_KEYS,
} = require('../src/bot-config-v2');

/** Create a temp directory for each test. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bcv2-'));
}

describe('bot-config-v2', () => {
  // ── compositeKey / parseCompositeKey ─────────────────────────────────────

  describe('compositeKey()', () => {
    it('builds a dash-separated key with checksummed addresses', () => {
      const w = '0x4e44847675763D5540B32Bee8a713CfDcb4bE61A';
      const c = '0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2';
      const key = compositeKey('pulsechain', w, c, '42');
      assert.equal(key, 'pulsechain-' + w + '-' + c + '-42');
    });
  });

  describe('parseCompositeKey()', () => {
    it('round-trips with compositeKey', () => {
      const w = '0x4e44847675763D5540B32Bee8a713CfDcb4bE61A';
      const c = '0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2';
      const key = compositeKey('pulsechain', w, c, '99');
      const parsed = parseCompositeKey(key);
      assert.equal(parsed.blockchain, 'pulsechain');
      assert.equal(parsed.wallet, w);
      assert.equal(parsed.contract, c);
      assert.equal(parsed.tokenId, '99');
    });

    it('returns null for invalid keys', () => {
      assert.equal(parseCompositeKey(null), null);
      assert.equal(parseCompositeKey(''), null);
      assert.equal(parseCompositeKey('only-two-parts'), null);
      assert.equal(
        parseCompositeKey('a-b-c-d'),
        null,
        'addresses must start with 0x',
      );
    });
  });

  // ── loadConfig / saveConfig ─────────────────────────────────────────────

  describe('loadConfig()', () => {
    it('returns empty structure when no file exists', () => {
      const dir = tmpDir();
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.global, {});
      assert.deepEqual(cfg.managedPositions, []);
      assert.deepEqual(cfg.positions, {});
    });

    it('loads an existing config', () => {
      const dir = tmpDir();
      const saved = {
        global: { slippagePct: 1.0 },
        managedPositions: ['key-1'],
        positions: { 'key-1': { status: 'running' } },
      };
      fs.writeFileSync(
        path.join(dir, '.bot-config.json'),
        JSON.stringify(saved),
      );
      const loaded = loadConfig(dir);
      assert.equal(loaded.global.slippagePct, 1.0);
      assert.deepEqual(loaded.managedPositions, ['key-1']);
    });

    it('returns empty structure for malformed config', () => {
      const dir = tmpDir();
      fs.writeFileSync(
        path.join(dir, '.bot-config.json'),
        JSON.stringify({ foo: 'bar' }),
      );
      const loaded = loadConfig(dir);
      assert.deepEqual(loaded.managedPositions, []);
      assert.deepEqual(loaded.positions, {});
    });
  });

  describe('saveConfig()', () => {
    it('writes valid JSON to disk', () => {
      const dir = tmpDir();
      const cfg = {
        global: { slippagePct: 0.7 },
        managedPositions: [],
        positions: {},
      };
      saveConfig(cfg, dir);

      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, '.bot-config.json'), 'utf8'),
      );
      assert.equal(raw.global.slippagePct, 0.7);
      assert.equal(raw.version, undefined, 'version field should not be written');
    });

    it('strips legacy version field', () => {
      const dir = tmpDir();
      const cfg = {
        global: {},
        managedPositions: [],
        positions: {},
      };
      saveConfig(cfg, dir);

      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, '.bot-config.json'), 'utf8'),
      );
      assert.equal(raw.version, undefined);
    });
  });

  // ── Position management ─────────────────────────────────────────────────

  describe('getPositionConfig()', () => {
    it('creates entry if missing', () => {
      const cfg = {
        global: {},
        managedPositions: [],
        positions: {},
      };
      const pos = getPositionConfig(cfg, 'key-1');
      assert.deepEqual(pos, {});
      assert.ok(cfg.positions['key-1']);
    });

    it('returns existing entry', () => {
      const cfg = {
        global: {},
        managedPositions: [],
        positions: { 'key-1': { status: 'paused' } },
      };
      const pos = getPositionConfig(cfg, 'key-1');
      assert.equal(pos.status, 'paused');
    });
  });

  describe('addManagedPosition()', () => {
    it('adds to managedPositions and sets status', () => {
      const cfg = {
        global: {},
        managedPositions: [],
        positions: {},
      };
      addManagedPosition(cfg, 'key-1');
      assert.deepEqual(cfg.managedPositions, ['key-1']);
      assert.equal(cfg.positions['key-1'].status, 'running');
    });

    it('does not duplicate on re-add', () => {
      const cfg = {
        global: {},
        managedPositions: ['key-1'],
        positions: { 'key-1': { status: 'paused' } },
      };
      addManagedPosition(cfg, 'key-1', 'running');
      assert.equal(cfg.managedPositions.length, 1);
      assert.equal(cfg.positions['key-1'].status, 'running');
    });
  });

  describe('removeManagedPosition()', () => {
    it('removes from managed set and marks stopped', () => {
      const cfg = {
        global: {},
        managedPositions: ['key-1', 'key-2'],
        positions: {
          'key-1': { status: 'running' },
          'key-2': { status: 'running' },
        },
      };
      removeManagedPosition(cfg, 'key-1');
      assert.deepEqual(cfg.managedPositions, ['key-2']);
      assert.equal(cfg.positions['key-1'].status, 'stopped');
    });
  });

  describe('migratePositionKey()', () => {
    it('moves config from old key to new key', () => {
      const cfg = {
        global: {},
        managedPositions: ['old-key'],
        positions: { 'old-key': { status: 'running', pnlEpochs: [1, 2] } },
      };
      migratePositionKey(cfg, 'old-key', 'new-key');
      assert.deepEqual(cfg.managedPositions, ['new-key']);
      assert.equal(cfg.positions['new-key'].status, 'running');
      assert.deepEqual(cfg.positions['new-key'].pnlEpochs, [1, 2]);
      assert.equal(cfg.positions['old-key'], undefined);
    });

    it('no-op when old === new', () => {
      const cfg = {
        global: {},
        managedPositions: ['key-1'],
        positions: { 'key-1': { status: 'running' } },
      };
      migratePositionKey(cfg, 'key-1', 'key-1');
      assert.deepEqual(cfg.managedPositions, ['key-1']);
      assert.equal(cfg.positions['key-1'].status, 'running');
    });
  });

  // ── Key lists ───────────────────────────────────────────────────────────

  describe('exported key lists', () => {
    it('GLOBAL_KEYS does not overlap with POSITION_KEYS', () => {
      const overlap = GLOBAL_KEYS.filter((k) => POSITION_KEYS.includes(k));
      assert.deepEqual(
        overlap,
        [],
        'Global and position keys must not overlap',
      );
    });
  });
});
