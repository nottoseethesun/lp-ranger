/**
 * @file test/optimizer-applicator.test.js
 * @description Unit tests for src/optimizer-applicator.js.
 * Run with: npm test
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  applyRecommendation,
  snapshotParams,
  formatApplyResult,
  formatValue,
  defaultParams,
  MANAGED_KEYS,
} = require('../src/optimizer-applicator');

// ── defaultParams ─────────────────────────────────────────────────────────────

describe('defaultParams', () => {
  it('returns an object with all MANAGED_KEYS', () => {
    const p = defaultParams();
    for (const k of MANAGED_KEYS) {
      assert.ok(k in p, `Missing key: ${k}`);
    }
  });

  it('returns fresh objects on each call (no shared reference)', () => {
    const a = defaultParams();
    const b = defaultParams();
    a.rangeWidthPct = 999;
    assert.notStrictEqual(b.rangeWidthPct, 999);
  });
});

// ── snapshotParams ────────────────────────────────────────────────────────────

describe('snapshotParams', () => {
  it('captures only MANAGED_KEYS', () => {
    const params = { ...defaultParams(), extraField: 'ignored' };
    const snap   = snapshotParams(params);
    assert.ok(!('extraField' in snap));
    for (const k of MANAGED_KEYS) {
      assert.ok(k in snap, `Snapshot missing: ${k}`);
    }
  });

  it('returns a copy — mutations do not affect original', () => {
    const params = defaultParams();
    const snap   = snapshotParams(params);
    snap.rangeWidthPct = 999;
    assert.notStrictEqual(params.rangeWidthPct, 999);
  });
});

// ── applyRecommendation — basic behaviour ─────────────────────────────────────

describe('applyRecommendation — basic', () => {
  it('returns applied:true when a field changes', () => {
    const params = defaultParams();
    const rec    = { rangeWidthPct: 15, fetchedAt: new Date().toISOString() };
    const result = applyRecommendation(params, rec);
    assert.strictEqual(result.applied, true);
  });

  it('mutates the params object in place', () => {
    const params = defaultParams(); // rangeWidthPct = 20
    applyRecommendation(params, { rangeWidthPct: 30, fetchedAt: '' });
    assert.strictEqual(params.rangeWidthPct, 30);
  });

  it('returns applied:false when recommendation has no changes', () => {
    const params = defaultParams();
    const rec    = snapshotParams(params); // identical to current
    rec.fetchedAt = new Date().toISOString();
    const result = applyRecommendation(params, rec);
    assert.strictEqual(result.applied, false);
  });

  it('lists changed fields in result.changes', () => {
    const params = defaultParams();
    const result = applyRecommendation(params,
      { rangeWidthPct: 10, slippagePct: 1.0, fetchedAt: '' });
    const fields = result.changes.map(c => c.field);
    assert.ok(fields.includes('rangeWidthPct'));
    assert.ok(fields.includes('slippagePct'));
    assert.strictEqual(result.changes.length, 2);
  });

  it('records from/to values in each change', () => {
    const params = defaultParams(); // rangeWidthPct = 20
    const result = applyRecommendation(params,
      { rangeWidthPct: 25, fetchedAt: '' });
    const change = result.changes.find(c => c.field === 'rangeWidthPct');
    assert.strictEqual(change.from, 20);
    assert.strictEqual(change.to,   25);
  });
});

// ── applyRecommendation — skipped fields ──────────────────────────────────────

describe('applyRecommendation — skipped fields', () => {
  it('skips fields absent from the recommendation', () => {
    const params = defaultParams();
    const result = applyRecommendation(params, { fetchedAt: '' }); // empty rec
    assert.strictEqual(result.skipped.length, MANAGED_KEYS.length);
    for (const s of result.skipped) {
      assert.strictEqual(s.reason, 'not in recommendation');
    }
  });

  it('skips fields where value equals current', () => {
    const params = defaultParams();
    // Pass back the exact same rangeWidthPct
    const result = applyRecommendation(params,
      { rangeWidthPct: params.rangeWidthPct, fetchedAt: '' });
    const skip = result.skipped.find(s => s.field === 'rangeWidthPct');
    assert.ok(skip);
    assert.strictEqual(skip.reason, 'no change');
  });

  it('only counts present+different fields as changes', () => {
    const params = defaultParams();
    // Only rangeWidthPct differs
    const result = applyRecommendation(params,
      { rangeWidthPct: 99, triggerType: params.triggerType, fetchedAt: '' });
    assert.strictEqual(result.changes.length, 1);
  });
});

// ── applyRecommendation — snapshot integrity ──────────────────────────────────

describe('applyRecommendation — snapshots', () => {
  it('previous snapshot reflects state before application', () => {
    const params = defaultParams(); // rangeWidthPct = 20
    const result = applyRecommendation(params, { rangeWidthPct: 50, fetchedAt: '' });
    assert.strictEqual(result.previous.rangeWidthPct, 20);
  });

  it('current snapshot reflects state after application', () => {
    const params = defaultParams();
    const result = applyRecommendation(params, { rangeWidthPct: 50, fetchedAt: '' });
    assert.strictEqual(result.current.rangeWidthPct, 50);
  });

  it('snapshots are copies — later mutations do not affect them', () => {
    const params = defaultParams();
    const result = applyRecommendation(params, { rangeWidthPct: 50, fetchedAt: '' });
    params.rangeWidthPct = 999;
    assert.strictEqual(result.current.rangeWidthPct,  50);
    assert.strictEqual(result.previous.rangeWidthPct, 20);
  });
});

// ── applyRecommendation — confidence & rationale ──────────────────────────────

describe('applyRecommendation — metadata fields', () => {
  it('includes rationale when present in recommendation', () => {
    const params = defaultParams();
    const result = applyRecommendation(params,
      { rationale: 'Low vol detected.', fetchedAt: '' });
    assert.strictEqual(result.rationale, 'Low vol detected.');
  });

  it('rationale is null when not in recommendation', () => {
    const params = defaultParams();
    const result = applyRecommendation(params, { fetchedAt: '' });
    assert.strictEqual(result.rationale, null);
  });

  it('includes confidence score when present', () => {
    const params = defaultParams();
    const result = applyRecommendation(params,
      { confidence: 0.75, fetchedAt: '' });
    assert.strictEqual(result.confidence, 0.75);
  });

  it('appliedAt is an ISO string', () => {
    const params = defaultParams();
    const result = applyRecommendation(params, { fetchedAt: '' });
    assert.ok(typeof result.appliedAt === 'string');
    assert.ok(!isNaN(Date.parse(result.appliedAt)));
  });
});

// ── formatApplyResult ─────────────────────────────────────────────────────────

describe('formatApplyResult', () => {
  it('reports no changes when nothing applied', () => {
    const params = defaultParams();
    const result = applyRecommendation(params, { fetchedAt: '' });
    const text   = formatApplyResult(result);
    assert.match(text, /no parameters changed/i);
  });

  it('lists changed fields', () => {
    const params = defaultParams();
    const result = applyRecommendation(params,
      { rangeWidthPct: 12, slippagePct: 0.8, fetchedAt: '' });
    const text   = formatApplyResult(result);
    assert.ok(text.includes('rangeWidthPct'));
    assert.ok(text.includes('slippagePct'));
    assert.ok(text.includes('→'));
  });

  it('includes confidence percentage when present', () => {
    const params = defaultParams();
    const result = applyRecommendation(params, { rangeWidthPct: 15, confidence: 0.88, fetchedAt: '' });
    const text   = formatApplyResult(result);
    assert.ok(text.includes('88%'));
  });

  it('reports count of changes', () => {
    const params = defaultParams();
    const result = applyRecommendation(params,
      { rangeWidthPct: 12, slippagePct: 0.8, fetchedAt: '' });
    const text   = formatApplyResult(result);
    assert.ok(text.includes('2 change'));
  });
});

// ── formatValue ──────────────────────────────────────────────────────────────

describe('formatValue', () => {
  it('formats integer as plain string', () => {
    assert.strictEqual(formatValue(20), '20');
  });
  it('formats float with 2 decimal places', () => {
    assert.strictEqual(formatValue(0.5), '0.50');
  });
  it('returns — for null', () => {
    assert.strictEqual(formatValue(null), '—');
  });
  it('returns — for undefined', () => {
    assert.strictEqual(formatValue(undefined), '—');
  });
  it('formats string as-is', () => {
    assert.strictEqual(formatValue('oor'), 'oor');
  });
});

// ── MANAGED_KEYS completeness ─────────────────────────────────────────────────

describe('MANAGED_KEYS', () => {
  it('contains all expected parameter names', () => {
    const expected = [
      'rangeWidthPct', 'triggerType', 'edgePct', 'schedHours',
      'minRebalanceIntervalMin', 'maxRebalancesPerDay', 'slippagePct', 'checkIntervalSec',
    ];
    for (const k of expected) {
      assert.ok(MANAGED_KEYS.includes(k), `Missing from MANAGED_KEYS: ${k}`);
    }
  });

  it('has no duplicate entries', () => {
    assert.strictEqual(new Set(MANAGED_KEYS).size, MANAGED_KEYS.length);
  });
});
