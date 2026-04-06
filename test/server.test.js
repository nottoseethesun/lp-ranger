/**
 * @file test/server.test.js
 * @description Integration tests for server.js.
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
const { start, stop } = require("../server");

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
      headers: payload
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }
        : {},
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

  // ── /api/config ───────────────────────────────────────────────────────────

  it("POST /api/config updates allowed fields", async () => {
    const pk = "pulsechain-0xAb5-0xCd9-42";
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: { slippagePct: 1.0, positionKey: pk },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.applied.slippagePct, 1.0);
  });

  it("POST /api/config rejects position keys without positionKey", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: { slippagePct: 0.5 },
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("positionKey"));
  });

  it("POST /api/config ignores unknown fields", async () => {
    const pk = "pulsechain-0xAb5-0xCd9-42";
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/config",
      body: {
        slippagePct: 0.5,
        positionKey: pk,
        PRIVATE_KEY: "hacked",
        PORT: 9999,
      },
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok("PRIVATE_KEY" in body.applied === false);
    assert.ok("PORT" in body.applied === false);
  });

  it("POST /api/config returns 400 for invalid JSON", async () => {
    const options = {
      hostname: "127.0.0.1",
      port: TEST_PORT,
      path: "/api/config",
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  // ── /api/rebalance ────────────────────────────────────────────────────────

  it("POST /api/rebalance returns 400 without positionKey", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "POST",
      path: "/api/rebalance",
      body: {},
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("positionKey"));
  });

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

  // ── CORS ──────────────────────────────────────────────────────────────────

  it("responses include CORS headers", async () => {
    const res = await req({ port: TEST_PORT, path: "/health" });
    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  });

  it("OPTIONS preflight returns 204", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "OPTIONS",
      path: "/api/status",
    });
    assert.strictEqual(res.status, 204);
  });

  // ── Method not allowed ────────────────────────────────────────────────────

  it("DELETE / returns 405", async () => {
    const res = await req({
      port: TEST_PORT,
      method: "DELETE",
      path: "/",
    });
    assert.strictEqual(res.status, 405);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("stop() closes the server cleanly", async () => {
    await stop();
    assert.strictEqual(serverInstance.listening, false);
  });
});
