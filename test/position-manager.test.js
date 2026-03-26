/**
 * @file test/position-manager.test.js
 * @description Tests for the multi-position orchestrator.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPositionManager } = require('../src/position-manager');
const { createRebalanceLock }   = require('../src/rebalance-lock');

/** Create a fake startLoop that returns a stoppable handle. */
function fakeStartLoop() {
  let stopped = false;
  return async () => ({
    stop() { stopped = true; return Promise.resolve(); },
    get stopped() { return stopped; },
  });
}

/** Shorthand to build a manager with defaults. */
function makeMgr(overrides) {
  return createPositionManager({
    rebalanceLock: createRebalanceLock(),
    dailyMax: 20,
    ...overrides,
  });
}

describe('position-manager', () => {

  // ── startPosition ───────────────────────────────────────────────────────

  describe('startPosition()', () => {
    it('starts a position and registers it as running', async () => {
      const mgr = makeMgr();
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: fakeStartLoop() });
      assert.equal(mgr.count(), 1);
      assert.equal(mgr.runningCount(), 1);
      const entry = mgr.get('key-1');
      assert.equal(entry.status, 'running');
      assert.equal(entry.tokenId, '100');
    });

    it('no-ops when position is already running (no duplicate loop)', async () => {
      const mgr = makeMgr();
      let callCount = 0;
      const loop = async () => { callCount++; return { stop: () => Promise.resolve() }; };
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: loop });
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: loop });
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: loop });
      assert.equal(callCount, 1, 'startLoop must be called exactly once — no duplicate bot loops');
      assert.equal(mgr.runningCount(), 1, 'only one position should be running');
    });

    it('exposes lock and scan helpers on the manager', async () => {
      const lock = createRebalanceLock();
      const mgr = createPositionManager({ rebalanceLock: lock });
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: fakeStartLoop() });
      assert.equal(typeof mgr.getRebalanceLock, 'function');
      assert.equal(typeof mgr.getScanLock, 'function');
    });
  });

  // ── pausePosition / resumePosition ──────────────────────────────────────

  describe('pausePosition()', () => {
    it('stops the loop and marks paused', async () => {
      const mgr = makeMgr();
      let stopped = false;
      const loop = async () => ({ stop() { stopped = true; return Promise.resolve(); } });
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: loop });
      await mgr.pausePosition('key-1');
      assert.ok(stopped);
      assert.equal(mgr.get('key-1').status, 'paused');
      assert.equal(mgr.runningCount(), 0);
    });

    it('no-ops when already paused', async () => {
      const mgr = makeMgr();
      const loop = async () => ({ stop: () => Promise.resolve() });
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: loop });
      await mgr.pausePosition('key-1');
      await mgr.pausePosition('key-1'); // should not throw
      assert.equal(mgr.get('key-1').status, 'paused');
    });

    it('warns on unknown key', async () => {
      const mgr = makeMgr();
      await mgr.pausePosition('nonexistent'); // should not throw
    });
  });

  describe('resumePosition()', () => {
    it('restarts a paused position', async () => {
      const mgr = makeMgr();
      let startCount = 0;
      const loop = async () => { startCount++; return { stop: () => Promise.resolve() }; };
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: loop });
      await mgr.pausePosition('key-1');
      assert.equal(startCount, 1);

      await mgr.resumePosition('key-1', loop);
      assert.equal(startCount, 2);
      assert.equal(mgr.get('key-1').status, 'running');
    });

    it('no-ops when already running', async () => {
      const mgr = makeMgr();
      let startCount = 0;
      const loop = async () => { startCount++; return { stop: () => Promise.resolve() }; };
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: loop });
      await mgr.resumePosition('key-1', loop);
      assert.equal(startCount, 1);
    });
  });

  // ── removePosition ──────────────────────────────────────────────────────

  describe('removePosition()', () => {
    it('stops and removes the position', async () => {
      const mgr = makeMgr();
      let stopped = false;
      const loop = async () => ({ stop() { stopped = true; return Promise.resolve(); } });
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: loop });
      await mgr.removePosition('key-1');
      assert.ok(stopped);
      assert.equal(mgr.count(), 0);
      assert.equal(mgr.get('key-1'), undefined);
    });

    it('no-ops on unknown key', async () => {
      const mgr = makeMgr();
      await mgr.removePosition('nonexistent'); // should not throw
    });
  });

  // ── stopAll ─────────────────────────────────────────────────────────────

  describe('stopAll()', () => {
    it('stops all running positions', async () => {
      const mgr = makeMgr();
      const stops = [];
      const makeLoop = () => async () => ({ stop() { stops.push(true); return Promise.resolve(); } });
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: makeLoop() });
      await mgr.startPosition('key-2', { tokenId: '200', startLoop: makeLoop() });
      await mgr.stopAll();
      assert.equal(stops.length, 2);
      assert.equal(mgr.runningCount(), 0);
    });
  });

  // ── migrateKey ──────────────────────────────────────────────────────────

  describe('migrateKey()', () => {
    it('moves entry from old key to new key', async () => {
      const mgr = makeMgr();
      await mgr.startPosition('old-key', { tokenId: '100', startLoop: fakeStartLoop() });
      mgr.migrateKey('old-key', 'new-key', '200');
      assert.equal(mgr.get('old-key'), undefined);
      const entry = mgr.get('new-key');
      assert.equal(entry.tokenId, '200');
      assert.equal(entry.status, 'running');
    });

    it('no-ops when old === new', async () => {
      const mgr = makeMgr();
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: fakeStartLoop() });
      mgr.migrateKey('key-1', 'key-1', '100');
      assert.equal(mgr.get('key-1').tokenId, '100');
    });
  });

  // ── getAll ──────────────────────────────────────────────────────────────

  describe('getAll()', () => {
    it('returns summary of all managed positions', async () => {
      const mgr = makeMgr();
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: fakeStartLoop() });
      await mgr.startPosition('key-2', { tokenId: '200', startLoop: fakeStartLoop() });
      await mgr.pausePosition('key-2');

      const all = mgr.getAll();
      assert.equal(all.length, 2);
      assert.ok(all.find((p) => p.key === 'key-1' && p.status === 'running'));
      assert.ok(all.find((p) => p.key === 'key-2' && p.status === 'paused'));
    });
  });


  // ── Multiple positions with shared lock ─────────────────────────────────

  describe('multiple positions', () => {
    it('can manage multiple positions simultaneously', async () => {
      const mgr = makeMgr();
      await mgr.startPosition('key-1', { tokenId: '100', startLoop: fakeStartLoop() });
      await mgr.startPosition('key-2', { tokenId: '200', startLoop: fakeStartLoop() });
      assert.equal(mgr.count(), 2);
      assert.equal(mgr.runningCount(), 2);
    });
  });
});
