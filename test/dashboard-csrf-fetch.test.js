"use strict";

/**
 * @file test/dashboard-csrf-fetch.test.js
 * @description Tests for the `fetchWithCsrf` wrapper in
 *   `public/dashboard-helpers.js`.  The wrapper attaches the cached
 *   CSRF token to every mutating request and, on a 403 whose body
 *   identifies an expired token, refreshes the token and retries the
 *   request once.  This eliminates the user-visible 403 on the first
 *   POST after a long browser-idle period (Chrome throttles
 *   `setInterval` on hidden tabs hard enough that the held token can
 *   age past the 60-min server TTL).
 *
 *   Replicates the wrapper's logic in CommonJS for test access — the
 *   real implementation is an ES module bundled by esbuild.  Mirror is
 *   small enough to keep in lockstep by inspection; if you change one,
 *   change the other.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");

// ── In-test replica of the helper ──────────────────────────────────────────

let _csrfToken = null;
let _refreshCount = 0;
function refreshCsrfToken() {
  _refreshCount += 1;
  _csrfToken = "fresh-token-" + _refreshCount;
  return Promise.resolve();
}
function _csrfHeaders() {
  return _csrfToken ? { "x-csrf-token": _csrfToken } : {};
}

let _fetchCalls = [];
let _fetchImpl = null;
async function _fetch(url, init) {
  _fetchCalls.push({ url, init });
  return _fetchImpl(url, init, _fetchCalls.length);
}

const _CSRF_RETRY_REASONS = new Set([
  "Expired CSRF token",
  "Unknown CSRF token",
]);

async function fetchWithCsrf(url, init = {}) {
  const initWithToken = {
    ...init,
    headers: { ...(init.headers || {}), ..._csrfHeaders() },
  };
  const res = await _fetch(url, initWithToken);
  if (res.status !== 403) return res;
  let body;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  if (!body || !_CSRF_RETRY_REASONS.has(body.error)) return res;
  await refreshCsrfToken();
  const retryInit = {
    ...init,
    headers: { ...(init.headers || {}), ..._csrfHeaders() },
  };
  return _fetch(url, retryInit);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRes(status, jsonBody) {
  return {
    status,
    clone() {
      return {
        json: async () => jsonBody,
      };
    },
    json: async () => jsonBody,
  };
}

beforeEach(() => {
  _csrfToken = "initial-token";
  _refreshCount = 0;
  _fetchCalls = [];
  _fetchImpl = null;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("fetchWithCsrf", () => {
  it("attaches the current CSRF token to the request", async () => {
    _fetchImpl = async () => makeRes(200, { ok: true });
    await fetchWithCsrf("/api/foo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.strictEqual(_fetchCalls.length, 1);
    assert.strictEqual(
      _fetchCalls[0].init.headers["x-csrf-token"],
      "initial-token",
    );
    assert.strictEqual(
      _fetchCalls[0].init.headers["Content-Type"],
      "application/json",
    );
  });

  it("returns the response unchanged when status is not 403", async () => {
    _fetchImpl = async () => makeRes(200, { ok: true });
    const r = await fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(_fetchCalls.length, 1);
    assert.strictEqual(_refreshCount, 0);
  });

  it("refreshes and retries once on 403 with Expired CSRF token", async () => {
    _fetchImpl = async (_url, _init, callIdx) => {
      if (callIdx === 1)
        return makeRes(403, { ok: false, error: "Expired CSRF token" });
      return makeRes(200, { ok: true });
    };
    const r = await fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(_fetchCalls.length, 2);
    assert.strictEqual(_refreshCount, 1);
    assert.strictEqual(
      _fetchCalls[1].init.headers["x-csrf-token"],
      "fresh-token-1",
      "retry must use the freshly refreshed token, not the stale one",
    );
  });

  it("refreshes and retries once on 403 with Unknown CSRF token", async () => {
    /*- "Unknown CSRF token" means the server pruned an aged-out token
     *  from its in-memory `_issued` map (see src/server-csrf.js
     *  `_pruneExpired`).  Same root cause as Expired (token past TTL),
     *  so the silent recovery is identical: refresh + retry.  Without
     *  this case in the retry set, every "Unknown" 403 used to drop
     *  the request silently — a real loss observed in burn-in logs. */
    _fetchImpl = async (_url, _init, callIdx) => {
      if (callIdx === 1)
        return makeRes(403, { ok: false, error: "Unknown CSRF token" });
      return makeRes(200, { ok: true });
    };
    const r = await fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(_fetchCalls.length, 2);
    assert.strictEqual(_refreshCount, 1);
    assert.strictEqual(
      _fetchCalls[1].init.headers["x-csrf-token"],
      "fresh-token-1",
    );
  });

  it("does not retry on 403 with a different reason", async () => {
    _fetchImpl = async () =>
      makeRes(403, { ok: false, error: "Invalid CSRF token" });
    const r = await fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(_fetchCalls.length, 1);
    assert.strictEqual(_refreshCount, 0);
  });

  it("does not retry when 403 body is non-JSON", async () => {
    _fetchImpl = async () => ({
      status: 403,
      clone: () => ({
        json: async () => {
          throw new Error("not JSON");
        },
      }),
    });
    const r = await fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(_fetchCalls.length, 1);
    assert.strictEqual(_refreshCount, 0);
  });

  it("does not retry when token is missing entirely", async () => {
    _csrfToken = null;
    _fetchImpl = async () => makeRes(200, { ok: true });
    const r = await fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(_fetchCalls[0].init.headers["x-csrf-token"], undefined);
  });

  it("preserves caller's body and method on retry", async () => {
    _fetchImpl = async (_url, _init, callIdx) => {
      if (callIdx === 1)
        return makeRes(403, { ok: false, error: "Expired CSRF token" });
      return makeRes(200, { ok: true });
    };
    await fetchWithCsrf("/api/foo", {
      method: "DELETE",
      body: '{"x":1}',
    });
    assert.strictEqual(_fetchCalls[1].init.method, "DELETE");
    assert.strictEqual(_fetchCalls[1].init.body, '{"x":1}');
  });
});
