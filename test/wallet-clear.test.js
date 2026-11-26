"use strict";

/**
 * @file test/wallet-clear.test.js
 * @description Clear Wallet (`DELETE /api/wallet`,
 *   src/server/wallet-clear.js) is refused, with a 409 saying why, while
 *   the server is using the wallet: an unlock or the launch's key step
 *   (src/server/wallet-in-use.js), or a wallet import (src/bot/app-phase.js).
 *   Otherwise it removes the wallet. The unlock's and the launch's windows
 *   are tested in test/server-unlock.test.js and
 *   test/server-launch-key-step.test.js, the import's in
 *   test/decrypts-before-start.test.js.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const appPhase = require("../src/bot/app-phase");
const { createWalletInUse } = require("../src/server/wallet-in-use");
const { clearRequestOver } = require("./helpers/wallet-clear-request");

/** A Clear route over a tracker of its own, counting removals. */
function clearRoute() {
  const walletInUse = createWalletInUse();
  const removed = { count: 0 };
  const clearNow = clearRequestOver(walletInUse, () => {
    removed.count++;
  });
  return { walletInUse, removed, clearNow };
}

describe("Clear Wallet", () => {
  afterEach(() => appPhase._resetAppPhaseForTests());

  it("removes the wallet when nothing is using it", () => {
    const c = clearRoute();
    const res = c.clearNow();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(c.removed.count, 1);
  });

  it("is refused while an unlock or the launch's key step uses the wallet", () => {
    const c = clearRoute();
    c.walletInUse.begin();
    const res = c.clearNow();
    assert.equal(res.status, 409);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /unlocking the wallet/);
    assert.equal(c.removed.count, 0, "the wallet kept");
  });

  it("stays refused until every unlock under way has ended", () => {
    // Two tabs can send the password at once: each unlock marks its own.
    const c = clearRoute();
    c.walletInUse.begin();
    c.walletInUse.begin();
    c.walletInUse.end();
    assert.equal(c.clearNow().status, 409, "one unlock still decrypting");
    c.walletInUse.end();
    assert.equal(c.clearNow().status, 200);
    assert.equal(c.removed.count, 1);
  });

  it("is refused while a wallet import is under way", () => {
    const c = clearRoute();
    appPhase.beginWalletImport();
    const res = c.clearNow();
    assert.equal(res.status, 409);
    assert.match(res.body.error, /importing a wallet/);
    assert.equal(c.removed.count, 0, "the wallet kept");
    appPhase.endWalletImport();
    assert.equal(c.clearNow().status, 200, "taken once the import ended");
  });
});
