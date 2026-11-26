/**
 * @file test/server-spa-fallback.test.js
 * @description Tests for the SPA catch-all in src/server.js.
 * Extensionless GET paths serve index.html (for client-side routing).
 * Paths with file extensions that don't match a real file return 404.
 * API and health routes are unaffected.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("assert");
const http = require("http");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

/*-
 *  Refused outside the test runner, before the server loads: loading
 *  src/server.js rewrites the backups of bot-config.json and the records,
 *  in the operator's own files unless `node --test` gives this process
 *  files of its own.
 */
if (process.env.NODE_TEST_CONTEXT === undefined)
  throw new Error(
    "Run test/server-spa-fallback.test.js with node --test: it would write the operator's settings",
  );

/*-
 *  The server's settings check, run as it loads, reads an empty folder
 *  for the operator's copies, named before the server loads, so a file
 *  of the operator's cannot stop this run (test/server.test.js does the
 *  same).
 */
process.env.LP_RANGER_USER_CONFIG_DIR = makeTestTempFolder("spa-overrides");

const { start, stop } = require("../src/server");

const PORT = 54370;

/**
 * Make an HTTP request and return { status, headers, body }.
 * @param {object} opts  { port, method?, path? }
 * @returns {Promise<{ status: number, headers: object, body: string }>}
 */
function req(opts) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: opts.port,
      path: opts.path || "/",
      method: opts.method || "GET",
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
    request.end();
  });
}

describe("SPA catch-all routing", () => {
  before(async () => {
    await start(PORT);
  });
  after(async () => {
    await stop();
  });

  it("GET /pulsechain/0xABC123 serves index.html (wallet URL)", async () => {
    const res = await req({ port: PORT, path: "/pulsechain/0xABC123" });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers["content-type"].includes("text/html"));
    assert.ok(res.body.includes("<html") || res.body.includes("<!DOCTYPE"));
  });

  it("GET /pulsechain/0xABC/0xDEF/12345 serves index.html (full position URL)", async () => {
    const res = await req({
      port: PORT,
      path: "/pulsechain/0xABC/0xDEF/12345",
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers["content-type"].includes("text/html"));
  });

  it("GET /missing-file.js returns 404 (has file extension)", async () => {
    const res = await req({ port: PORT, path: "/missing-file.js" });
    assert.strictEqual(res.status, 404);
  });

  it("GET /api/status returns JSON (API route unaffected)", async () => {
    const res = await req({ port: PORT, path: "/api/status" });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok("global" in body, "status should have global section");
    assert.ok("positions" in body, "status should have positions section");
  });

  it("GET /health returns JSON (health route unaffected)", async () => {
    const res = await req({ port: PORT, path: "/health" });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
  });
});
