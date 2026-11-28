/**
 * @file test/server-wallet-clear-wiring.test.js
 * @description Clear Wallet through the running server (src/server.js):
 *   its route table sends `DELETE /api/wallet` to the Clear route, and
 *   that route, the unlock and `GET /api/status` share the server's one
 *   tracker of whether the wallet is in use (src/server/wallet-in-use.js).
 *   While an unlock decrypts, a Clear is refused (409) and the status
 *   answer says why; once the unlock has answered, a Clear goes through
 *   and the server holds no wallet.
 *
 *   The other tests build these routes over trackers of their own, so a
 *   server that gave one route a tracker of its own, or kept the old
 *   Clear, passes them all. Starts the server on a port of its own, over
 *   a wallet this process saves, and sends real requests.
 */

"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

/*-
 *  Refused outside the test runner, before the server loads: under
 *  `node --test` this process's settings, wallet and records are files of
 *  its own, and no `.env` is read.
 */
if (process.env.NODE_TEST_CONTEXT === undefined)
  throw new Error(
    "Run test/server-wallet-clear-wiring.test.js with node --test: it would write the operator's settings",
  );
process.env.LP_RANGER_USER_CONFIG_DIR = makeTestTempFolder(
  "server-clear-wiring-overrides",
);
const { start, stop } = require("../src/server");
const walletManager = require("../src/lib/wallet-manager");
const { freePort } = require("./helpers/free-port");

// The port the server is started on, one the system says is free.
let PORT = 0;
const PASSWORD = "the one password";
const WALLET = {
  address: "0xAbCdEf0000000000000000000000000000000001",
  privateKey: "0x" + "ab".repeat(32),
  mnemonic: null,
  source: "key",
  password: PASSWORD,
};

/**
 * One request to the running server, its answer as `{ status, body }`.
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [opts]  `body` to send as json, `headers` to add.
 * @returns {Promise<{status: number, body: object}>}
 */
function request(method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: urlPath,
        method,
        headers: {
          ...(payload === null
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode, body: JSON.parse(text || "{}") });
        });
      },
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** A fresh CSRF token, which every request but a GET must carry. */
async function csrf() {
  const r = await request("GET", "/api/csrf-token");
  return { "x-csrf-token": r.body.token };
}

/** The status answer's `clearWalletRefusal`. */
async function clearRefusal() {
  return (await request("GET", "/api/status")).body.global.clearWalletRefusal;
}

after(async () => {
  await stop();
});

describe("Clear Wallet through the running server", () => {
  it("is refused while an unlock decrypts, the status saying why, and goes through after", async () => {
    PORT = await freePort();
    await start(PORT);
    await walletManager.importWallet(WALLET);
    assert.equal(await clearRefusal(), null, "nothing using the wallet");

    /*-
     *  A wrong password: the unlock decrypts (600,000 rounds), then
     *  answers 401, taking no key and starting nothing.
     */
    const unlock = request("POST", "/api/wallet/unlock", {
      body: { password: "not the password" },
      headers: await csrf(),
    });
    let refusal = null;
    for (let i = 0; i < 200 && refusal === null; i++)
      refusal = await clearRefusal();
    assert.match(refusal, /decrypting the wallet/, "the status says why");

    const refused = await request("DELETE", "/api/wallet", {
      headers: await csrf(),
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, refusal, "the same refusal");
    assert.equal(walletManager.hasWallet(), true, "the wallet kept");

    assert.equal((await unlock).status, 401);
    assert.equal(await clearRefusal(), null, "the unlock has ended");
    const cleared = await request("DELETE", "/api/wallet", {
      headers: await csrf(),
    });
    assert.equal(cleared.status, 200);
    assert.equal(walletManager.hasWallet(), false, "the wallet removed");
    const status = await request("GET", "/api/status");
    assert.equal(status.body.global.walletAddress, null);
  });
});
