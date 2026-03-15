/**
 * @file test/optimizer-client.test.js
 * @description Unit tests for src/optimizer-client.js.
 * All HTTP calls are mocked — no real network traffic.
 * Run with: npm test
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const {
  createOptimizerClient,
  sanitiseRecommendation,
  BOUNDS,
  VALID_TRIGGER_TYPES,
  _clamp,
} = require('../src/optimizer-client');

// ── _clamp ────────────────────────────────────────────────────────────────────

describe('_clamp', () => {
  it('returns value when within bounds', () => {
    assert.strictEqual(_clamp(15, 1, 200), 15);
  });
  it('clamps below min', () => {
    assert.strictEqual(_clamp(0, 1, 200), 1);
  });
  it('clamps above max', () => {
    assert.strictEqual(_clamp(300, 1, 200), 200);
  });
  it('returns null for non-finite value', () => {
    assert.strictEqual(_clamp('abc', 1, 200), null);
    assert.strictEqual(_clamp(NaN, 1, 200),   null);
    assert.strictEqual(_clamp(Infinity, 1, 200), null);
  });
  it('parses a numeric string', () => {
    assert.strictEqual(_clamp('50', 1, 200), 50);
  });
});

// ── sanitiseRecommendation ────────────────────────────────────────────────────

describe('sanitiseRecommendation', () => {
  it('passes through all valid fields', () => {
    const raw = {
      rangeWidthPct: 15, triggerType: 'edge', edgePct: 8,
      schedHours: 12, minRebalanceIntervalMin: 5, maxRebalancesPerDay: 10,
      slippagePct: 0.3, checkIntervalSec: 30, confidence: 0.9,
      rationale: 'Low vol',
    };
    const rec = sanitiseRecommendation(raw);
    assert.strictEqual(rec.rangeWidthPct, 15);
    assert.strictEqual(rec.triggerType,   'edge');
    assert.strictEqual(rec.edgePct,       8);
    assert.strictEqual(rec.confidence,    0.9);
    assert.strictEqual(rec.rationale,     'Low vol');
    assert.ok(typeof rec.fetchedAt === 'string');
  });

  it('clamps rangeWidthPct to BOUNDS', () => {
    const rec = sanitiseRecommendation({ rangeWidthPct: 500 });
    assert.strictEqual(rec.rangeWidthPct, BOUNDS.rangeWidthPct.max);
  });

  it('drops rangeWidthPct below minimum', () => {
    const rec = sanitiseRecommendation({ rangeWidthPct: 0 });
    assert.strictEqual(rec.rangeWidthPct, BOUNDS.rangeWidthPct.min);
  });

  it('drops unknown triggerType', () => {
    const rec = sanitiseRecommendation({ triggerType: 'magic' });
    assert.strictEqual(rec.triggerType, undefined);
  });

  it('accepts all valid trigger types', () => {
    for (const t of VALID_TRIGGER_TYPES) {
      const rec = sanitiseRecommendation({ triggerType: t });
      assert.strictEqual(rec.triggerType, t);
    }
  });

  it('rounds integer fields', () => {
    const rec = sanitiseRecommendation({ minRebalanceIntervalMin: 7.7, maxRebalancesPerDay: 3.2 });
    assert.strictEqual(rec.minRebalanceIntervalMin, 8);
    assert.strictEqual(rec.maxRebalancesPerDay,     3);
  });

  it('truncates rationale to 500 chars', () => {
    const long = 'x'.repeat(600);
    const rec  = sanitiseRecommendation({ rationale: long });
    assert.strictEqual(rec.rationale.length, 500);
  });

  it('drops non-string rationale', () => {
    const rec = sanitiseRecommendation({ rationale: 42 });
    assert.strictEqual(rec.rationale, undefined);
  });

  it('always includes fetchedAt as ISO string', () => {
    const rec = sanitiseRecommendation({});
    assert.ok(typeof rec.fetchedAt === 'string');
    assert.ok(!isNaN(Date.parse(rec.fetchedAt)));
  });

  it('drops non-numeric numeric fields', () => {
    const rec = sanitiseRecommendation({ rangeWidthPct: 'not a number' });
    assert.strictEqual(rec.rangeWidthPct, undefined);
  });
});

// ── createOptimizerClient — constructor validation ────────────────────────────

describe('createOptimizerClient — constructor', () => {
  it('throws when url is missing', () => {
    assert.throws(() => createOptimizerClient({}), /url is required/i);
  });

  it('throws when url is empty string', () => {
    assert.throws(() => createOptimizerClient({ url: '' }), /url is required/i);
  });

  it('returns an object with fetchRecommendation and ping', () => {
    const c = createOptimizerClient({ url: 'http://localhost:4000' });
    assert.strictEqual(typeof c.fetchRecommendation, 'function');
    assert.strictEqual(typeof c.ping,                'function');
  });
});

// ── createOptimizerClient — fetchRecommendation (mock HTTP) ───────────────────

/**
 * Build a client whose internal httpRequest is replaced by a mock.
 * We do this by testing the client's public behaviour end-to-end
 * without making real network calls, using a minimal mock server approach.
 */
describe('createOptimizerClient — fetchRecommendation', () => {
  // We test the full flow by starting a real local HTTP server
  // (Node built-in, no dependencies) that responds with controlled payloads.
  const http = require('http');

  /** Start a one-shot server that replies with status+body then closes. */
  function makeMockServer(status, body) {
    return new Promise((resolve) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({ server, port });
      });
    });
  }

  it('returns ok:true with sanitised recommendation on 200', async () => {
    const { server, port } = await makeMockServer(200, {
      rangeWidthPct: 18, triggerType: 'oor', confidence: 0.82,
      rationale: 'Moderate volatility.',
    });
    const client = createOptimizerClient({ url: `http://127.0.0.1:${port}` });
    const result = await client.fetchRecommendation({ feeTier: 3000 });
    server.close();

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.httpStatus, 200);
    assert.strictEqual(result.recommendation.rangeWidthPct, 18);
    assert.strictEqual(result.recommendation.triggerType,   'oor');
    assert.ok(result.recommendation.fetchedAt);
  });

  it('returns ok:false with httpStatus on non-2xx response', async () => {
    const { server, port } = await makeMockServer(503, '{"error":"overloaded"}');
    const client = createOptimizerClient({ url: `http://127.0.0.1:${port}` });
    const result = await client.fetchRecommendation({});
    server.close();

    assert.strictEqual(result.ok,         false);
    assert.strictEqual(result.httpStatus,  503);
    assert.ok(result.error.includes('503'));
  });

  it('returns ok:false when server returns invalid JSON', async () => {
    const { server, port } = await makeMockServer(200, 'not json {{{{');
    const client = createOptimizerClient({ url: `http://127.0.0.1:${port}` });
    const result = await client.fetchRecommendation({});
    server.close();

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /not valid JSON/i);
  });

  it('returns ok:false when server is unreachable', async () => {
    // Port 1 is typically blocked — use a port that's definitely not listening
    const client = createOptimizerClient({ url: 'http://127.0.0.1:19999' });
    const result = await client.fetchRecommendation({});
    assert.strictEqual(result.ok,         false);
    assert.strictEqual(result.httpStatus, null);
    assert.ok(typeof result.error === 'string');
  });

  it('strips trailing slash from base URL', async () => {
    const { server, port } = await makeMockServer(200, { rangeWidthPct: 20 });
    // URL with trailing slash
    const client = createOptimizerClient({ url: `http://127.0.0.1:${port}/` });
    const result = await client.fetchRecommendation({});
    server.close();
    assert.strictEqual(result.ok, true);
  });
});

// ── createOptimizerClient — ping ──────────────────────────────────────────────

describe('createOptimizerClient — ping', () => {
  const http = require('http');

  it('returns reachable:true and latencyMs for a healthy server', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const client  = createOptimizerClient({ url: `http://127.0.0.1:${port}` });
    const result  = await client.ping();
    server.close();

    assert.strictEqual(result.reachable, true);
    assert.ok(typeof result.latencyMs === 'number' && result.latencyMs >= 0);
    assert.strictEqual(result.error, null);
  });

  it('returns reachable:false when server is unreachable', async () => {
    const client = createOptimizerClient({ url: 'http://127.0.0.1:19998' });
    const result = await client.ping();
    assert.strictEqual(result.reachable, false);
    assert.ok(typeof result.error === 'string');
  });
});
