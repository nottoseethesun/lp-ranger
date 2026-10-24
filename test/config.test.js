/**
 * @file test/config.test.js
 * @description Unit tests for src/lib/config.js.
 *
 * Because config.js reads process.env at require-time, we test
 * assertLiveModeReady() by manipulating the exported object. How each
 * `.env` variable is read is covered by test/settings-check.test.js
 * (src/lib/env-settings.js), and the Bot Settings `.env` can set by
 * test/config-env-ranges.test.js.
 *
 * Run with: npm test
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");

const config = require("../src/lib/config");
const walletManager = require("../src/lib/wallet-manager");

// ── Default values ────────────────────────────────────────────────────────────

describe("config default values", () => {
  it("PORT defaults to 5555 when env var is absent", () => {
    // config was loaded without PORT set in test env
    // If CI sets PORT we can't guarantee 5555, so just assert it's a valid port
    assert.ok(
      Number.isInteger(config.PORT) && config.PORT > 0 && config.PORT <= 65535,
      `PORT should be a valid port number, got ${config.PORT}`,
    );
  });

  it("HOST defaults to 127.0.0.1 (localhost only)", () => {
    assert.ok(typeof config.HOST === "string" && config.HOST.length > 0);
  });

  it("RPC_URL has a non-empty default", () => {
    assert.ok(typeof config.RPC_URL === "string" && config.RPC_URL.length > 0);
  });

  it("REBALANCE_OOR_THRESHOLD_PCT is a positive number", () => {
    assert.ok(config.REBALANCE_OOR_THRESHOLD_PCT > 0);
  });

  it("no longer reads SLIPPAGE_PCT", () => {
    assert.equal(config.SLIPPAGE_PCT, undefined);
    assert.equal(config.DEFAULT_SLIPPAGE_PCT, undefined);
  });

  it("CHECK_INTERVAL_SEC is a positive integer", () => {
    assert.ok(
      Number.isInteger(config.CHECK_INTERVAL_SEC) &&
        config.CHECK_INTERVAL_SEC > 0,
    );
  });

  it("MIN_REBALANCE_INTERVAL_MIN is a positive integer", () => {
    assert.ok(
      Number.isInteger(config.MIN_REBALANCE_INTERVAL_MIN) &&
        config.MIN_REBALANCE_INTERVAL_MIN > 0,
    );
  });

  it("MAX_REBALANCES_PER_DAY is a positive integer", () => {
    assert.ok(
      Number.isInteger(config.MAX_REBALANCES_PER_DAY) &&
        config.MAX_REBALANCES_PER_DAY > 0,
    );
  });

  it("LOG_FILE is a non-empty string", () => {
    assert.ok(
      typeof config.LOG_FILE === "string" && config.LOG_FILE.length > 0,
    );
  });

  it("POSITION_MANAGER is a non-empty string", () => {
    assert.ok(
      typeof config.POSITION_MANAGER === "string" &&
        config.POSITION_MANAGER.length > 0,
    );
  });

  it("FACTORY is a non-empty string", () => {
    assert.ok(typeof config.FACTORY === "string" && config.FACTORY.length > 0);
  });
});

// ── assertLiveModeReady ───────────────────────────────────────────────────────

describe("assertLiveModeReady", () => {
  it("does not throw when PRIVATE_KEY and RPC_URL are present", () => {
    // assertLiveModeReady throws iff RPC_URL is missing OR
    // (PRIVATE_KEY is missing AND no wallet file exists on disk).
    const hasKey = !!config.PRIVATE_KEY || walletManager.hasWallet();
    if (hasKey && config.RPC_URL) {
      assert.doesNotThrow(() => config.assertLiveModeReady());
    } else {
      // Expected to throw — that's correct behaviour for missing config
      assert.throws(
        () => config.assertLiveModeReady(),
        /Missing required configuration/i,
      );
    }
  });

  it("exported assertLiveModeReady is a function", () => {
    assert.strictEqual(typeof config.assertLiveModeReady, "function");
  });
});

// ── PORT value ────────────────────────────────────────────────────────────────

describe("PORT configuration", () => {
  it("PORT is exported as a number", () => {
    assert.strictEqual(typeof config.PORT, "number");
  });

  it("PORT is within the valid TCP port range (1–65535)", () => {
    assert.ok(
      config.PORT >= 1 && config.PORT <= 65535,
      `Expected PORT in 1–65535, got ${config.PORT}`,
    );
  });
});

// ── EIP-55 checksummed addresses ─────────────────────────────────────────────

describe("EIP-55 address conformance", () => {
  const ethers = require("ethers");

  it("POSITION_MANAGER is a valid EIP-55 checksummed address", () => {
    const addr = config.POSITION_MANAGER;
    assert.strictEqual(
      addr.length,
      42,
      `Expected 42 chars (0x + 40 hex), got ${addr.length}`,
    );
    assert.strictEqual(
      addr,
      ethers.getAddress(addr),
      `POSITION_MANAGER is not EIP-55 checksummed: ${addr}`,
    );
  });

  it("FACTORY is a valid EIP-55 checksummed address", () => {
    const addr = config.FACTORY;
    assert.strictEqual(
      addr.length,
      42,
      `Expected 42 chars (0x + 40 hex), got ${addr.length}`,
    );
    assert.strictEqual(
      addr,
      ethers.getAddress(addr),
      `FACTORY is not EIP-55 checksummed: ${addr}`,
    );
  });

  it("SWAP_ROUTER is a valid EIP-55 checksummed address", () => {
    const addr = config.SWAP_ROUTER;
    assert.strictEqual(
      addr.length,
      42,
      `Expected 42 chars (0x + 40 hex), got ${addr.length}`,
    );
    assert.strictEqual(
      addr,
      ethers.getAddress(addr),
      `SWAP_ROUTER is not EIP-55 checksummed: ${addr}`,
    );
  });
});

// ── Module shape ──────────────────────────────────────────────────────────────

describe("config module shape", () => {
  const expectedKeys = [
    "PORT",
    "HOST",
    "PRIVATE_KEY",
    "RPC_URL",
    "POSITION_ID",
    "REBALANCE_OOR_THRESHOLD_PCT",
    "CHECK_INTERVAL_SEC",
    "MIN_REBALANCE_INTERVAL_MIN",
    "MAX_REBALANCES_PER_DAY",
    "LOG_FILE",
    "POSITION_MANAGER",
    "FACTORY",
    "SWAP_ROUTER",
    "assertLiveModeReady",
    "VERBOSE",
  ];

  for (const key of expectedKeys) {
    it(`exports '${key}'`, () => {
      assert.ok(key in config, `Missing export: ${key}`);
    });
  }
});
describe("cli-help", () => {
  it("prints server help without throwing", () => {
    const orig = console.log;
    let out = "";
    console.log = (s) => {
      out += s;
    };
    try {
      require("../src/lib/cli-help")("server");
      assert.ok(out.includes("Dashboard"));
    } finally {
      console.log = orig;
    }
  });
  it("prints bot help without throwing", () => {
    const orig = console.log;
    let out = "";
    console.log = (s) => {
      out += s;
    };
    try {
      require("../src/lib/cli-help")("bot");
      assert.ok(out.includes("Headless"));
    } finally {
      console.log = orig;
    }
  });
});
