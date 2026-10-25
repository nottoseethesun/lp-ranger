/**
 * @file test/server.test.js
 * @description Integration tests for src/server.js.
 *
 * Starts the server on a random high port (to avoid conflicts), exercises
 * each route, then shuts down cleanly.  No external HTTP library needed —
 * uses Node's built-in `http` module.
 *
 * Run with: npm test
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const http = require("http");
const { start, stop } = require("../src/server");
const {
  isPaused,
  _resetPauseStateForTests,
} = require("../src/lib/price-fetcher-gate");
const { getAllPositionBotStates } = require("../src/lib/server-positions");
const { isItOkayToStartAscan } = require("../src/lib/scan-state");

// Production file protection is handled globally by scripts/check.sh
// (backup before tests, restore after). No per-test snapshot needed.

// ── HTTP helper ───────────────────────────────────────────────────────────────

/**
 * Make a simple HTTP request and return { status, headers, body }.
 * @param {{ port: number, method?: string, path?: string, body?: object }} opts
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
function req(opts) {
  return new Promise((resolve, reject) => {
    const method = opts.method || "GET";
    const urlPath = opts.path || "/";
    const payload = opts.body ? JSON.stringify(opts.body) : null;

    const options = {
      hostname: "127.0.0.1",
      port: opts.port,
      path: urlPath,
      method,
      headers: {
        ...(payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {}),
        ...(opts.headers || {}),
      },
    };

    const request = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });

    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

const TEST_PORT = 54321;
let serverInstance;

/** Fetch a fresh CSRF token from the running server. */
async function csrfToken() {
  const r = await req({ port: TEST_PORT, path: "/api/csrf-token" });
  return JSON.parse(r.body).token;
}

describe("server", () => {
  // ── Lifecycle ───────────────────────────────────────────────────────────────

  it("starts on the specified port", async () => {
    serverInstance = await start(TEST_PORT);
    assert.ok(
      serverInstance.listening,
      "Server should be listening after start()",
    );
  });

  // ── /health ─────────────────────────────────────────────────────────────────

  it("GET /health returns 200 with ok:true", async () => {
    const res = await req({ port: TEST_PORT, path: "/health" });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.ok(typeof body.port === "number");
    assert.ok(typeof body.ts === "number");
  });

  // ── /api/status (v2: global + positions) ──────────────────────────────────

  it("GET /api/status returns 200 with global and positions", async () => {
    const res = await req({ port: TEST_PORT, path: "/api/status" });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok("global" in body, "status should have global section");
    assert.ok("positions" in body, "status should have positions section");
    assert.ok("port" in body.global);
    assert.ok("walletAddress" in body.global);
  });

  it("GET /api/status sends a BigInt on a bot state as its decimal text", async () => {
    /*-
     *  Each position's entry carries its whole bot state, and json has no
     *  BigInt. The deposit count keeps the wallet's last reading of the
     *  pool's two coins there as BigInts (src/lib/deposit-count.js), so the
     *  answer sends each as its decimal text, every digit kept.
     */
    const key =
      "pulsechain-0x1111111111111111111111111111111111111111-" +
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-424245";
    const states = getAllPositionBotStates();
    states.set(key, {
      running: true,
      _depositWalletSeen: { raw0: 12345678901234567890n, raw1: 7n },
    });
    try {
      const res = await req({ port: TEST_PORT, path: "/api/status" });
      assert.strictEqual(res.status, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body.positions[key]._depositWalletSeen, {
        raw0: "12345678901234567890",
        raw1: "7",
      });
    } finally {
      states.delete(key);
    }
  });

  // ── /api/config ───────────────────────────────────────────────────────────

  it("POST /api/config updates global allowed fields", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: { gasFeePct: 1.5 },
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.applied.gasFeePct, 1.5);
  });

  it("POST /api/config lazy-creates the disk slot when positionKey has none (Save-before-Manage)", async () => {
    /*- The dashboard exposes inputs (OOR threshold, slippage, …) on
     *  every position regardless of managed state.  When the user
     *  edits + Saves for a not-yet-managed position, the server
     *  lazy-creates the per-position slot with the patch.  A later
     *  POST /api/position/manage flips `status: "running"` on the
     *  existing slot and preserves the values. */
    const pk = "pulsechain-0xAb5-0xCd9-42";
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: { slippagePctToken0: 1.0, positionKey: pk },
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.applied.slippagePctToken0, 1.0);
  });

  it("POST /api/config rejects position keys without positionKey", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: { slippagePctToken0: 0.5 },
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("positionKey"));
  });

  it("POST /api/config ignores unknown fields (global-only patch)", async () => {
    /*- Updated to use a global key path so we don't 404 on a missing
     *  position slot; verifies the unknown-field filter still works. */
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: {
        gasFeePct: 1.2,
        PRIVATE_KEY: "hacked",
        PORT: 9999,
      },
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok("PRIVATE_KEY" in body.applied === false);
    assert.ok("PORT" in body.applied === false);
  });

  it("POST /api/config returns 400 for invalid JSON", async () => {
    const tok = await csrfToken();
    const options = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: "/api/config",
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": tok },
    };
    const result = await new Promise((resolve, reject) => {
      const r = http.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
      r.on("error", reject);
      r.write("{not valid json}");
      r.end();
    });
    assert.strictEqual(result.status, 400);
    const body = JSON.parse(result.body);
    assert.strictEqual(body.ok, false);
  });

  // ── /api/positions/managed ────────────────────────────────────────────────

  it("GET /api/positions/managed returns managed list", async () => {
    const res = await req({
      port: TEST_PORT,
      path: "/api/positions/managed",
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.ok(Array.isArray(body.positions));
  });

  // ── Position state questions ──────────────────────────────────────────────

  it("GET /api/is-position-managed takes its key from the query string", async () => {
    /*-
     *  The router names a route by its path alone, so a request carrying
     *  a query string still reaches its handler. Matched on the whole url,
     *  this request fell through to the page and was answered with
     *  index.html.
     */
    const key =
      "pulsechain-0x1111111111111111111111111111111111111111-" +
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-424242";
    const res = await req({
      port: TEST_PORT,
      path: "/api/is-position-managed?key=" + encodeURIComponent(key),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { managed: false });
  });

  // ── /api/rebalance ────────────────────────────────────────────────────────

  it("POST /api/rebalance returns 400 without positionKey", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/rebalance",
      body: {},
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("positionKey"));
  });

  it("POST /api/rebalance names the position in its answer", async () => {
    /*-
     *  A position no bot is running is refused 409, and the refusal
     *  names the position, as every answer about one does
     *  (src/lib/position-answer-tag.js).
     */
    const key =
      "pulsechain-0x1111111111111111111111111111111111111111-" +
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-424242";
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/rebalance",
      body: { positionKey: key },
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(JSON.parse(res.body).positionKey, key);
  });

  for (const [path, move, flag] of [
    ["/api/rebalance", "rebalance", "forceRebalance"],
    ["/api/compound", "compound", "forceCompound"],
  ]) {
    it(`POST ${path} refuses while a scan is running on the position`, async () => {
      /*-
       *  A move made during its position's scan would be left out of the
       *  figures the scan rebuilds (src/lib/scan-state.js). The refusal says
       *  so, names the position, is marked for the dialog to wait on,
       *  and asks nothing of the bot.
       */
      const key =
        "pulsechain-0x1111111111111111111111111111111111111111-" +
        "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-424243";
      const states = getAllPositionBotStates();
      let kicks = 0;
      const state = {
        running: true,
        _scanRunning: true,
        _kickPoll: () => kicks++,
      };
      states.set(key, state);
      try {
        const res = await req({
          port: TEST_PORT,
          method: "POST",
          path,
          body: { positionKey: key },
          headers: { "x-csrf-token": await csrfToken() },
        });
        assert.strictEqual(res.status, 409);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.scanInProgress, true);
        assert.strictEqual(body.positionKey, key);
        assert.match(body.error, /history from the blockchain/);
        assert.match(body.error, new RegExp(`A ${move} made during that read`));
        assert.strictEqual(state[flag], undefined);
        assert.strictEqual(kicks, 0);
      } finally {
        states.delete(key);
      }
    });

    it(`POST ${path} holds the position's scans back until it is made`, async () => {
      /*-
       *  A scan waiting to start, deferred by a move being decided, holds
       *  no request back: it waits for the moves, this one included.
       */
      const key =
        "pulsechain-0x1111111111111111111111111111111111111111-" +
        "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-424244";
      const states = getAllPositionBotStates();
      let kicks = 0;
      const state = {
        running: true,
        _scanWaiting: true,
        _kickPoll: () => kicks++,
      };
      states.set(key, state);
      try {
        const res = await req({
          port: TEST_PORT,
          method: "POST",
          path,
          body: { positionKey: key },
          headers: { "x-csrf-token": await csrfToken() },
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(state[flag], true);
        assert.strictEqual(isItOkayToStartAscan(state), false);
        assert.strictEqual(kicks, 1);
      } finally {
        states.delete(key);
      }
    });
  }

  // ── Static files ─────────────────────────────────────────────────────────

  it("GET / serves index.html with 200", async () => {
    const res = await req({ port: TEST_PORT, path: "/" });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers["content-type"].includes("text/html"));
    assert.ok(
      res.body.includes("<!DOCTYPE html") || res.body.includes("<html"),
    );
  });

  it("GET /nonexistent returns 403 or 404", async () => {
    const res = await req({
      port: TEST_PORT,
      path: "/this-does-not-exist.xyz",
    });
    assert.ok(res.status === 404 || res.status === 403);
  });

  it("GET with path traversal attempt returns 403 or 404", async () => {
    const res = await req({ port: TEST_PORT, path: "/../../etc/passwd" });
    assert.ok(res.status === 403 || res.status === 404);
  });

  it("GET with percent-encoded path traversal returns 403 or 404", async () => {
    const res = await req({
      port: TEST_PORT,
      path: "/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd",
    });
    assert.ok(res.status === 403 || res.status === 404);
  });

  it("GET with malformed percent-encoding returns 400", async () => {
    const res = await req({ port: TEST_PORT, path: "/%E0%A4%A" });
    assert.strictEqual(res.status, 400);
  });

  // ── CORS ──────────────────────────────────────────────────────────────────

  it("responses include localhost-locked CORS header", async () => {
    const res = await req({ port: TEST_PORT, path: "/health" });
    assert.match(
      res.headers["access-control-allow-origin"],
      /^http:\/\/localhost:\d+$/,
    );
  });

  it("OPTIONS preflight returns 204", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "OPTIONS",
      path: "/api/status",
    });
    assert.strictEqual(res.status, 204);
  });

  it("POST with localhost Origin is allowed", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: {},
      headers: {
        Origin: `http://localhost:${TEST_PORT}`,
        "x-csrf-token": await csrfToken(),
      },
    });
    // May be 400 (missing positionKey) but NOT 403
    assert.notStrictEqual(res.status, 403);
  });

  it("POST with foreign Origin is rejected 403", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: {},
      headers: { Origin: "http://evil.com" },
    });
    assert.strictEqual(res.status, 403);
  });

  it("POST with no Origin header is allowed (programmatic)", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: {},
      headers: { "x-csrf-token": await csrfToken() },
    });
    // May be 400 but NOT 403
    assert.notStrictEqual(res.status, 403);
  });

  // ── CSRF ──────────────────────────────────────────────────────────────────

  it("GET /api/csrf-token returns a token", async () => {
    const res = await req({ port: TEST_PORT, path: "/api/csrf-token" });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.token, "should have a token");
    assert.ok(body.expiresAt > Date.now(), "should expire in the future");
  });

  it("POST without CSRF token is rejected 403", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: {},
    });
    assert.strictEqual(res.status, 403);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("csrf") || body.error.includes("CSRF"));
  });

  it("POST with invalid CSRF token is rejected 403", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: {},
      headers: { "x-csrf-token": "bogus-token" },
    });
    assert.strictEqual(res.status, 403);
  });

  // ── Idle-driven pause endpoints ───────────────────────────────────────────

  it("POST /api/pause-price-lookups sets the gate to paused", async () => {
    _resetPauseStateForTests();
    assert.strictEqual(isPaused(), false, "precondition: not paused");
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/pause-price-lookups",
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.paused, true);
    assert.strictEqual(isPaused(), true);
  });

  it("POST /api/unpause-price-lookups clears the gate", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/unpause-price-lookups",
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.paused, false);
    assert.strictEqual(isPaused(), false);
  });

  it("both pause endpoints are idempotent", async () => {
    const t1 = await csrfToken();
    const r1 = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/pause-price-lookups",
      headers: { "x-csrf-token": t1 },
    });
    assert.strictEqual(r1.status, 200);
    const r2 = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/pause-price-lookups",
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(isPaused(), true);
    /*- Restore default-unpaused state for subsequent tests. */
    await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/unpause-price-lookups",
      headers: { "x-csrf-token": await csrfToken() },
    });
    _resetPauseStateForTests();
  });

  // ── Method not allowed ────────────────────────────────────────────────────

  it("DELETE / returns 405", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "DELETE",
      path: "/",
      headers: { "x-csrf-token": await csrfToken() },
    });
    assert.strictEqual(res.status, 405);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("stop() closes the server cleanly", async () => {
    await stop();
    assert.strictEqual(serverInstance.listening, false);
  });
});
