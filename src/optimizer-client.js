/**
 * @file src/optimizer-client.js
 * @module optimizerClient
 * @description
 * HTTP client for the external LP Optimization Engine.
 *
 * The Optimization Engine is a separate TypeScript service that analyses
 * pool data and returns recommended parameter values for the Position Manager.
 * This module is responsible for:
 *
 *  1. Fetching a recommendation from the engine's REST API.
 *  2. Validating the response shape and clamping numeric values to safe bounds.
 *  3. Returning a typed {@link OptimizationRecommendation} that downstream code
 *     can apply without knowing anything about HTTP or the engine's internals.
 *
 * The client is intentionally stateless — it does not remember previous
 * recommendations or manage the polling schedule.  Scheduling is handled by
 * {@link optimizerScheduler} in the dashboard and by the bot process.
 *
 * API contract (expected from the Optimization Engine)
 * ─────────────────────────────────────────────────────
 * POST  {OPTIMIZER_URL}/api/recommend
 * Headers: Authorization: Bearer {OPTIMIZER_API_KEY}  (omitted when no key)
 * Body (JSON):
 *   {
 *     "poolAddress": "0x…",
 *     "token0":      "WPLS",
 *     "token1":      "USDC",
 *     "feeTier":     3000,
 *     "currentTick": -206000
 *   }
 *
 * Expected response (JSON):
 *   {
 *     "rangeWidthPct":           20,
 *     "triggerType":             "oor",   // "oor" | "edge" | "time"
 *     "edgePct":                 5,
 *     "schedHours":              24,
 *     "minRebalanceIntervalMin": 10,
 *     "maxRebalancesPerDay":     20,
 *     "slippagePct":             0.5,
 *     "checkIntervalSec":        60,
 *     "confidence":              0.87,    // 0–1 (informational)
 *     "rationale":               "string" // human-readable explanation
 *   }
 *
 * All fields are optional; the Position Manager only applies fields that
 * are present in the response, leaving others at their current values.
 *
 * @example
 * const client = createOptimizerClient({ url: 'http://localhost:4000', apiKey: 'secret' });
 * const result = await client.fetchRecommendation({ poolAddress: '0x…', feeTier: 3000 });
 * if (result.ok) applyRecommendation(result.recommendation);
 */

'use strict';

const https = require('https');
const http  = require('http');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} OptimizationRequest
 * @property {string} [poolAddress]   Pool contract address.
 * @property {string} [token0]        Token0 symbol or address.
 * @property {string} [token1]        Token1 symbol or address.
 * @property {number} [feeTier]       Pool fee tier (e.g. 3000).
 * @property {number} [currentTick]   Current pool tick.
 * @property {number} [currentPrice]  Human-readable current price.
 */

/**
 * @typedef {Object} OptimizationRecommendation
 * All fields are optional — only present fields should be applied.
 * @property {number}  [rangeWidthPct]           New range width ±%.
 * @property {'oor'|'edge'|'time'} [triggerType] Rebalance trigger strategy.
 * @property {number}  [edgePct]                 Edge-buffer % for 'edge' trigger.
 * @property {number}  [schedHours]              Hours between rebalances for 'time' trigger.
 * @property {number}  [minRebalanceIntervalMin] Min minutes between rebalances.
 * @property {number}  [maxRebalancesPerDay]     Daily rebalance cap.
 * @property {number}  [slippagePct]             Max slippage %.
 * @property {number}  [checkIntervalSec]        On-chain poll interval in seconds.
 * @property {number}  [confidence]              Engine confidence score 0–1 (read-only).
 * @property {string}  [rationale]               Human-readable explanation (read-only).
 * @property {string}  fetchedAt                 ISO timestamp of when this was fetched.
 */

/**
 * @typedef {Object} FetchResult
 * @property {boolean}                        ok
 * @property {OptimizationRecommendation|null} recommendation  Populated on success.
 * @property {string|null}                    error            Error message on failure.
 * @property {number|null}                    httpStatus       HTTP status code, if applicable.
 */

/**
 * @typedef {Object} OptimizerClientOptions
 * @property {string} url            Base URL of the Optimization Engine, e.g. 'http://localhost:4000'.
 * @property {string} [apiKey]       Bearer token for the Authorization header.
 * @property {number} [timeoutMs]    Request timeout in ms. Default: 10 000.
 */

// ── Validation bounds (clamp engine output to safe operating ranges) ───────────

const BOUNDS = {
  rangeWidthPct:           { min: 1,    max: 200  },
  edgePct:                 { min: 1,    max: 49   },
  schedHours:              { min: 1,    max: 168  },
  minRebalanceIntervalMin: { min: 1,    max: 1440 },
  maxRebalancesPerDay:     { min: 1,    max: 200  },
  slippagePct:             { min: 0.01, max: 10   },
  checkIntervalSec:        { min: 10,   max: 3600 },
  confidence:              { min: 0,    max: 1    },
};

const VALID_TRIGGER_TYPES = new Set(['oor', 'edge', 'time']);

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Clamp a number to [min, max].  Returns null if the value is not finite.
 * @param {*}      value
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
function clamp(value, min, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

/**
 * Validate and sanitise a raw API response into an OptimizationRecommendation.
 * Fields that are absent, invalid, or out-of-bounds are silently dropped.
 * @param {object} raw
 * @returns {OptimizationRecommendation}
 */
function sanitiseRecommendation(raw) {
  /** @type {OptimizationRecommendation} */
  const rec = { fetchedAt: new Date().toISOString() };

  // Numeric fields
  for (const [key, bounds] of Object.entries(BOUNDS)) {
    if (raw[key] !== undefined) {
      const clamped = clamp(raw[key], bounds.min, bounds.max);
      if (clamped !== null) rec[key] = clamped;
    }
  }

  // Enforce integer for fields that must be whole numbers
  for (const key of ['minRebalanceIntervalMin', 'maxRebalancesPerDay', 'checkIntervalSec', 'schedHours']) {
    if (rec[key] !== undefined) rec[key] = Math.round(rec[key]);
  }

  // triggerType — only accept known values
  if (raw.triggerType !== undefined && VALID_TRIGGER_TYPES.has(raw.triggerType)) {
    rec.triggerType = raw.triggerType;
  }

  // rationale — string, truncated to 500 chars for safety
  if (typeof raw.rationale === 'string') {
    rec.rationale = raw.rationale.slice(0, 500);
  }

  return rec;
}

/**
 * Make an HTTP/HTTPS request and return the response body as a string.
 * Respects the protocol of the URL (http vs https).
 * @param {string} url
 * @param {object} options   Node http.request options
 * @param {string} [body]    Request body string
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body: string }>}
 */
function httpRequest(url, options, body, timeoutMs) {
  const parsed  = new URL(url);
  const useHttps = parsed.protocol === 'https:';
  const lib     = useHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(url, options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({
        status: res.statusCode,
        body:   Buffer.concat(chunks).toString('utf8'),
      }));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create an optimizer client instance.
 * @param {OptimizerClientOptions} opts
 * @returns {{ fetchRecommendation: function, ping: function }}
 */
function createOptimizerClient(opts) {
  const baseUrl   = (opts.url || '').replace(/\/$/, '');
  const apiKey    = opts.apiKey   || null;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  if (!baseUrl) {
    throw new Error('OptimizerClient: opts.url is required.');
  }

  /**
   * Build the Authorization header if an API key is set.
   * @returns {object}
   */
  function authHeader() {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }

  /**
   * Fetch a recommendation from the Optimization Engine.
   * @param {OptimizationRequest} request
   * @returns {Promise<FetchResult>}
   */
  async function fetchRecommendation(request) {
    const endpoint = `${baseUrl}/api/recommend`;
    const payload  = JSON.stringify(request || {});

    const options = {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...authHeader(),
      },
    };

    try {
      const { status, body } = await httpRequest(endpoint, options, payload, timeoutMs);

      if (status < 200 || status >= 300) {
        return { ok: false, recommendation: null,
                 error: `Optimizer returned HTTP ${status}`, httpStatus: status };
      }

      let raw;
      try {
        raw = JSON.parse(body);
      } catch (_) {
        return { ok: false, recommendation: null,
                 error: 'Optimizer response is not valid JSON', httpStatus: status };
      }

      const recommendation = sanitiseRecommendation(raw);
      return { ok: true, recommendation, error: null, httpStatus: status };

    } catch (err) {
      return { ok: false, recommendation: null,
               error: err.message, httpStatus: null };
    }
  }

  /**
   * Ping the Optimization Engine to confirm it is reachable.
   * Calls GET /health and returns true if the status is 2xx.
   * @returns {Promise<{ reachable: boolean, latencyMs: number, error: string|null }>}
   */
  async function ping() {
    const endpoint = `${baseUrl}/health`;
    const start    = Date.now();
    try {
      const { status } = await httpRequest(endpoint, { method: 'GET', headers: authHeader() }, null, timeoutMs);
      const latencyMs  = Date.now() - start;
      const reachable  = status >= 200 && status < 300;
      return { reachable, latencyMs, error: reachable ? null : `HTTP ${status}` };
    } catch (err) {
      return { reachable: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  return { fetchRecommendation, ping };
}

// ── exports ───────────────────────────────────────────────────────────────────
module.exports = {
  createOptimizerClient,
  sanitiseRecommendation,
  BOUNDS,
  VALID_TRIGGER_TYPES,
  _clamp: clamp,
};
