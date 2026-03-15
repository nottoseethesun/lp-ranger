/**
 * @file test/ui-state.test.js
 * @description Unit tests for the ui-state module (pure formatting functions only).
 * DOM mutation functions (applyKpis, applyRangeBar, applyPositionType) are
 * covered by smoke-testing that they do not throw in a no-DOM environment.
 * Run with: npm test
 */

'use strict';
const { describe, it } = require('node:test');

const assert = require('assert');
const {
  formatPnl,
  formatUsd,
  formatUsd4,
  formatPct,
  formatCountdown,
  formatDuration,
  formatShortAddress,
  signClass,
  throttleBarStyle,
  rangeBannerState,
  positionTypeMeta,
  applyKpis,
  applyRangeBar,
  applyPositionType,
} = require('../src/ui-state');

// ── formatPnl ─────────────────────────────────────────────────────────────────

describe('formatPnl', () => {
  it('positive value has + prefix', () => {
    assert.strictEqual(formatPnl(42.5), '+$42.50');
  });
  it('negative value has - prefix', () => {
    assert.strictEqual(formatPnl(-3.14), '-$3.14');
  });
  it('zero shows +$0.00', () => {
    assert.strictEqual(formatPnl(0), '+$0.00');
  });
  it('rounds to 2 decimal places', () => {
    // JS IEEE 754: 1.005 is stored as slightly less, so .toFixed(2) → '1.00'
    assert.strictEqual(formatPnl(1.006), '+$1.01');
  });
});

// ── formatUsd ────────────────────────────────────────────────────────────────

describe('formatUsd', () => {
  it('formats positive value', () => {
    assert.strictEqual(formatUsd(100), '$100.00');
  });
  it('formats zero', () => {
    assert.strictEqual(formatUsd(0), '$0.00');
  });
  it('rounds correctly', () => {
    assert.strictEqual(formatUsd(1.999), '$2.00');
  });
});

// ── formatUsd4 ───────────────────────────────────────────────────────────────

describe('formatUsd4', () => {
  it('formats to 4 decimal places', () => {
    assert.strictEqual(formatUsd4(0.1234), '$0.1234');
  });
  it('uses absolute value', () => {
    assert.strictEqual(formatUsd4(-0.005), '$0.0050');
  });
});

// ── formatPct ────────────────────────────────────────────────────────────────

describe('formatPct', () => {
  it('adds + for positive', () => {
    assert.strictEqual(formatPct(5.25), '+5.25%');
  });
  it('uses - for negative', () => {
    assert.strictEqual(formatPct(-2.5), '-2.50%');
  });
  it('formats zero', () => {
    assert.strictEqual(formatPct(0), '+0.00%');
  });
});

// ── formatCountdown ───────────────────────────────────────────────────────────

describe('formatCountdown', () => {
  it('returns READY for 0', () => {
    assert.strictEqual(formatCountdown(0),  'READY');
    assert.strictEqual(formatCountdown(-1), 'READY');
  });
  it('formats 90 seconds as 01:30', () => {
    assert.strictEqual(formatCountdown(90_000), '01:30');
  });
  it('formats 1 minute exactly as 01:00', () => {
    assert.strictEqual(formatCountdown(60_000), '01:00');
  });
  it('formats 10 minutes 5 seconds as 10:05', () => {
    assert.strictEqual(formatCountdown(605_000), '10:05');
  });
  it('pads single-digit minutes and seconds', () => {
    assert.strictEqual(formatCountdown(65_000), '01:05');
  });
});

// ── formatDuration ────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats < 60s as seconds', () => {
    assert.strictEqual(formatDuration(45_000), '45s');
  });
  it('formats 90s as 1m 30s', () => {
    assert.strictEqual(formatDuration(90_000), '1m 30s');
  });
  it('formats exact minutes without seconds', () => {
    assert.strictEqual(formatDuration(120_000), '2m');
  });
  it('formats hours', () => {
    assert.strictEqual(formatDuration(3_660_000), '1h 1m');
  });
  it('formats 0ms as 0s', () => {
    assert.strictEqual(formatDuration(0), '0s');
  });
});

// ── formatShortAddress ────────────────────────────────────────────────────────

describe('formatShortAddress', () => {
  it('abbreviates long address', () => {
    const addr = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
    const s    = formatShortAddress(addr);
    assert.ok(s.includes('…'));
    assert.ok(s.startsWith('0xAbCdEf'));
    assert.ok(s.endsWith(addr.slice(-6)));   // last 6 chars of this address: 'CdEf12'
  });
  it('returns — for empty string', () => {
    assert.strictEqual(formatShortAddress(''), '—');
  });
  it('returns — for null/undefined', () => {
    assert.strictEqual(formatShortAddress(null),      '—');
    assert.strictEqual(formatShortAddress(undefined), '—');
  });
});

// ── signClass ─────────────────────────────────────────────────────────────────

describe('signClass', () => {
  it('returns pos for positive', () => {
    assert.strictEqual(signClass(1),   'pos');
    assert.strictEqual(signClass(0.001), 'pos');
  });
  it('returns neg for negative', () => {
    assert.strictEqual(signClass(-1), 'neg');
  });
  it('returns neu for zero', () => {
    assert.strictEqual(signClass(0), 'neu');
  });
});

// ── throttleBarStyle ──────────────────────────────────────────────────────────

describe('throttleBarStyle', () => {
  it('returns 0% and green for count=0', () => {
    const { pct, colorVar } = throttleBarStyle(0, 20);
    assert.strictEqual(pct, 0);
    assert.strictEqual(colorVar, 'var(--accent3)');
  });
  it('returns 50% and green at half capacity', () => {
    const { pct, colorVar } = throttleBarStyle(10, 20);
    assert.strictEqual(pct, 50);
    assert.strictEqual(colorVar, 'var(--accent3)');
  });
  it('returns amber at 65%', () => {
    const { colorVar } = throttleBarStyle(13, 20);
    assert.strictEqual(colorVar, 'var(--warn)');
  });
  it('returns red at 95%', () => {
    const { colorVar } = throttleBarStyle(19, 20);
    assert.strictEqual(colorVar, 'var(--danger)');
  });
  it('caps pct at 100 when count > max', () => {
    const { pct } = throttleBarStyle(25, 20);
    assert.strictEqual(pct, 100);
  });
  it('handles max=0 without division error', () => {
    const { pct } = throttleBarStyle(0, 0);
    assert.strictEqual(pct, 0);
  });
});

// ── rangeBannerState ──────────────────────────────────────────────────────────

describe('rangeBannerState', () => {
  it('in-range banner when price is in range', () => {
    const b = rangeBannerState(true, true, false, 0);
    assert.ok(b.className.includes('in'));
    assert.strictEqual(b.icon, '✓');
  });

  it('out banner when out of range and allowed', () => {
    const b = rangeBannerState(false, true, false, 0);
    assert.ok(b.className.includes('out'));
    assert.strictEqual(b.icon, '✗');
  });

  it('wait banner when out of range and blocked (no doubling)', () => {
    const b = rangeBannerState(false, false, false, 30_000);
    assert.ok(b.className.includes('wait'));
    assert.strictEqual(b.icon, '⏳');
    assert.ok(b.label.includes('00:30'));
  });

  it('dbl banner when out of range, blocked, and doubling active', () => {
    const b = rangeBannerState(false, false, true, 120_000);
    assert.ok(b.className.includes('dbl'));
    assert.strictEqual(b.icon, '⚡');
    assert.ok(b.label.includes('02:00'));
  });

  it('in-range takes precedence even when blocked', () => {
    const b = rangeBannerState(true, false, true, 5000);
    assert.ok(b.className.includes('in'));
  });
});

// ── positionTypeMeta ─────────────────────────────────────────────────────────

describe('positionTypeMeta', () => {
  it('returns nft meta for nft type', () => {
    const m = positionTypeMeta('nft', '12847');
    assert.ok(m.badgeText.includes('NFT'));
    assert.ok(m.badgeClass.includes('nft'));
    assert.strictEqual(m.stripValue, '12847');
  });

  it('returns erc20 meta for erc20 type', () => {
    const addr = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';
    const m    = positionTypeMeta('erc20', addr);
    assert.ok(m.badgeText.includes('ERC-20'));
    assert.ok(m.badgeClass.includes('erc20'));
    assert.ok(m.stripValue.includes('…'));
  });

  it('returns detecting meta for unknown type', () => {
    const m = positionTypeMeta('unknown', '');
    assert.ok(m.badgeText.includes('DETECT'));
    assert.strictEqual(m.stripValue, '—');
  });
});

// ── DOM functions — smoke test (no DOM available in Node.js) ──────────────────

describe('DOM functions (no-DOM smoke tests)', () => {
  const SNAP = {
    cumulativePnl: 100, totalFees: 50, totalIL: 5, totalGas: 3,
    netReturn: 42, currentValue: 2100, initialDeposit: 2000,
    closedEpochs: [{}], liveEpoch: null, liveEpochPnl: 0,
  };
  const THROTTLE_STATE = {
    dailyCount: 3, dailyMax: 20, doublingActive: false, currentWaitMs: 600_000,
  };
  const CAN_REB = { allowed: true, msUntilAllowed: 0, reason: 'ok' };

  it('applyKpis does not throw without DOM', () => {
    assert.doesNotThrow(() => applyKpis(SNAP, THROTTLE_STATE, CAN_REB, 7));
  });

  it('applyRangeBar does not throw without DOM', () => {
    assert.doesNotThrow(() => applyRangeBar(0.00042, 0.000336, 0.000504));
  });

  it('applyPositionType does not throw without DOM', () => {
    assert.doesNotThrow(() => applyPositionType('nft', '12847'));
    assert.doesNotThrow(() => applyPositionType('erc20', '0xABC'));
    assert.doesNotThrow(() => applyPositionType('unknown', ''));
  });
});
