"use strict";

/**
 * @file test/dashboard-csrf-fetch.test.js
 * @description Tests for the `fetchWithCsrf` wrapper in
 *   `public/dashboard-helpers.js`.  Uses jsdom (via
 *   `global-jsdom/register`) to populate `document` + `fetch`, then
 *   imports the real browser module.  Every test controls the token
 *   state and the fetch responses through a `globalThis.fetch` stub.
 *
 *   The wrapper attaches the cached CSRF token to every mutating
 *   request and, on a 403 whose body identifies an expired or unknown
 *   token, refreshes the token and retries the request once.  This
 *   closes the burn-in-observed drop where Chrome's setInterval
 *   throttling on a hidden tab let the held token age past the 60-min
 *   server TTL.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;

/*- Records every fetch call (url + init) plus supports a per-test
 *  responder that returns a Response-like object for each call. */
let _fetchCalls;
let _fetchResponder;

function _installFetch() {
  globalThis.fetch = async (url, init) => {
    _fetchCalls.push({ url, init });
    return _fetchResponder(url, init, _fetchCalls.length);
  };
}

function makeRes(status, jsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      return {
        json: async () => jsonBody,
      };
    },
    json: async () => jsonBody,
  };
}

/*- Populate the real module's private `_csrfToken` by responding to
 *  `/api/csrf-token` with the given token, then awaiting
 *  `refreshCsrfToken()`. */
async function _setCsrfToken(token) {
  const prevResponder = _fetchResponder;
  _fetchResponder = async (url) => {
    if (url === "/api/csrf-token") {
      return makeRes(200, { token, refreshIntervalMs: 60_000 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  await mod.refreshCsrfToken();
  _fetchResponder = prevResponder;
  // Drop the token-refresh call from the accounting so each test's
  // `_fetchCalls` reflects only its own POST/DELETE.
  _fetchCalls = [];
}

before(async () => {
  _fetchCalls = [];
  _installFetch();
  mod = await import("../public/dashboard-helpers.js");
});

beforeEach(async () => {
  _fetchCalls = [];
  _fetchResponder = null;
  _installFetch();
  await _setCsrfToken("initial-token");
});

describe("fetchWithCsrf", () => {
  it("attaches the current CSRF token to the request", async () => {
    _fetchResponder = async () => makeRes(200, { ok: true });
    await mod.fetchWithCsrf("/api/foo", {
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
    _fetchResponder = async () => makeRes(200, { ok: true });
    const r = await mod.fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(_fetchCalls.length, 1);
  });

  it("refreshes and retries once on 403 with Expired CSRF token", async () => {
    let firstCall = true;
    _fetchResponder = async (url) => {
      if (url === "/api/csrf-token") {
        return makeRes(200, {
          token: "fresh-token",
          refreshIntervalMs: 60_000,
        });
      }
      if (firstCall) {
        firstCall = false;
        return makeRes(403, { ok: false, error: "Expired CSRF token" });
      }
      return makeRes(200, { ok: true });
    };
    const r = await mod.fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 200);
    // Two /api/foo calls + one /api/csrf-token refresh.
    const fooCalls = _fetchCalls.filter((c) => c.url === "/api/foo");
    assert.strictEqual(fooCalls.length, 2);
    assert.strictEqual(
      fooCalls[1].init.headers["x-csrf-token"],
      "fresh-token",
      "retry must use the freshly refreshed token",
    );
  });

  it("refreshes and retries once on 403 with Unknown CSRF token", async () => {
    let firstCall = true;
    _fetchResponder = async (url) => {
      if (url === "/api/csrf-token") {
        return makeRes(200, {
          token: "fresh-token",
          refreshIntervalMs: 60_000,
        });
      }
      if (firstCall) {
        firstCall = false;
        return makeRes(403, { ok: false, error: "Unknown CSRF token" });
      }
      return makeRes(200, { ok: true });
    };
    const r = await mod.fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 200);
    const fooCalls = _fetchCalls.filter((c) => c.url === "/api/foo");
    assert.strictEqual(fooCalls.length, 2);
  });

  it("does not retry on 403 with a different reason", async () => {
    _fetchResponder = async () =>
      makeRes(403, { ok: false, error: "Invalid CSRF token" });
    const r = await mod.fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 403);
    const fooCalls = _fetchCalls.filter((c) => c.url === "/api/foo");
    assert.strictEqual(fooCalls.length, 1);
  });

  it("does not retry when 403 body is non-JSON", async () => {
    _fetchResponder = async () => ({
      status: 403,
      clone: () => ({
        json: async () => {
          throw new Error("not JSON");
        },
      }),
    });
    const r = await mod.fetchWithCsrf("/api/foo", { method: "POST" });
    assert.strictEqual(r.status, 403);
    const fooCalls = _fetchCalls.filter((c) => c.url === "/api/foo");
    assert.strictEqual(fooCalls.length, 1);
  });

  it("preserves caller's body and method on retry", async () => {
    let firstCall = true;
    _fetchResponder = async (url) => {
      if (url === "/api/csrf-token") {
        return makeRes(200, {
          token: "fresh-token",
          refreshIntervalMs: 60_000,
        });
      }
      if (firstCall) {
        firstCall = false;
        return makeRes(403, { ok: false, error: "Expired CSRF token" });
      }
      return makeRes(200, { ok: true });
    };
    await mod.fetchWithCsrf("/api/foo", {
      method: "DELETE",
      body: '{"x":1}',
    });
    const fooCalls = _fetchCalls.filter((c) => c.url === "/api/foo");
    assert.strictEqual(fooCalls[1].init.method, "DELETE");
    assert.strictEqual(fooCalls[1].init.body, '{"x":1}');
  });
});
