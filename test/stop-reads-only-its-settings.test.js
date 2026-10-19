"use strict";

/**
 * @file test/stop-reads-only-its-settings.test.js
 * @description `npm stop` (scripts/stop.js) and `npm run gentle-stop`
 *   (scripts/gentle-stop.js) read only the settings they use: where the
 *   server listens (src/server-address.js) and the shutdown timings. An
 *   operator may have just got another setting wrong, about to restart,
 *   and that must not keep them from stopping the server that is
 *   running; it is why both skip the settings check too. The port is
 *   still read by its rule, when it is read.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("the stop scripts", () => {
  it("load with every setting they do not use set wrong", () => {
    Object.assign(process.env, {
      DRY_RUN: "yes",
      VERBOSE: "maybe",
      PRIVATE_KEY: "not-a-key",
      CHAIN_NAME: "no-such-chain",
      PORT: "not-a-port",
    });
    assert.doesNotThrow(() => require("../scripts/stop"));
    assert.doesNotThrow(() => require("../scripts/gentle-stop"));
  });

  it("refuse a wrong port when they read it, naming it", () => {
    process.env.PORT = "not-a-port";
    const { serverPort } = require("../src/server-address");
    assert.throws(() => serverPort(), /PORT in \.env must be/);
  });
});
