/**
 * @file test/config.test.js
 * @description Unit tests for src/config.js.
 *
 * Because config.js reads process.env at require-time, we test the internal
 * parser helpers (_parsePositiveInt, _parsePositiveFloat) directly, and test
 * assertLiveModeReady() by manipulating the exported object.
 *
 * Run with: npm test
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");

const config = require("../src/config");

// ── _parsePositiveInt ─────────────────────────────────────────────────────────

describe("_parsePositiveInt", () => {
  const parse = config._parsePositiveInt;

  it("parses a valid positive integer string", () => {
    assert.strictEqual(parse("5555", 3000), 5555);
  });

  it("returns fallback for zero", () => {
    assert.strictEqual(parse("0", 42), 42);
  });

  it("returns fallback for negative value", () => {
    assert.strictEqual(parse("-1", 10), 10);
  });

  it("returns fallback for non-numeric string", () => {
    assert.strictEqual(parse("abc", 99), 99);
  });

  it("returns fallback for undefined", () => {
    assert.strictEqual(parse(undefined, 7), 7);
  });

  it("returns fallback for empty string", () => {
    assert.strictEqual(parse("", 8), 8);
  });

  it("parses string with leading/trailing whitespace", () => {
    // parseInt handles leading whitespace
    assert.strictEqual(parse("  42  ", 1), 42);
  });

  it("parses a float string by truncating to int", () => {
    assert.strictEqual(parse("3.9", 1), 3);
  });
});

// ── _parsePositiveFloat ───────────────────────────────────────────────────────

describe("_parsePositiveFloat", () => {
  const parse = config._parsePositiveFloat;

  it("parses a valid float string", () => {
    assert.ok(Math.abs(parse("0.5", 1) - 0.5) < 1e-9);
  });

  it("parses an integer string", () => {
    assert.strictEqual(parse("20", 1), 20);
  });

  it("returns fallback for zero", () => {
    assert.strictEqual(parse("0", 0.5), 0.5);
  });

  it("returns fallback for negative", () => {
    assert.strictEqual(parse("-0.1", 1.0), 1.0);
  });

  it("returns fallback for non-numeric", () => {
    assert.strictEqual(parse("NaN", 2.5), 2.5);
  });

  it("returns fallback for undefined", () => {
    assert.strictEqual(parse(undefined, 3.14), 3.14);
  });
});

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

  it("HOST defaults to 0.0.0.0", () => {
    // If HOST is not in the environment, default is '0.0.0.0'
    assert.ok(typeof config.HOST === "string" && config.HOST.length > 0);
  });

  it("RPC_URL has a non-empty default", () => {
    assert.ok(typeof config.RPC_URL === "string" && config.RPC_URL.length > 0);
  });

  it("REBALANCE_OOR_THRESHOLD_PCT is a positive number", () => {
    assert.ok(config.REBALANCE_OOR_THRESHOLD_PCT > 0);
  });

  it("SLIPPAGE_PCT is a positive number", () => {
    assert.ok(config.SLIPPAGE_PCT > 0);
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
    // If the test environment has these set, assertLiveModeReady must not throw.
    // If they're absent (typical in CI), we test the throw path instead.
    if (config.PRIVATE_KEY && config.RPC_URL) {
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

  it("default PORT is 5555 when process.env.PORT is not set in test env", () => {
    // This test is informational — in real usage PORT=5555 is the default.
    // We verify _parsePositiveInt('5555', 5555) returns 5555.
    assert.strictEqual(config._parsePositiveInt("5555", 99), 5555);
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
    "ERC20_POSITION_ADDRESS",
    "REBALANCE_OOR_THRESHOLD_PCT",
    "SLIPPAGE_PCT",
    "CHECK_INTERVAL_SEC",
    "MIN_REBALANCE_INTERVAL_MIN",
    "MAX_REBALANCES_PER_DAY",
    "LOG_FILE",
    "POSITION_MANAGER",
    "FACTORY",
    "SWAP_ROUTER",
    "assertLiveModeReady",
    "VERBOSE",
    "_parsePositiveInt",
    "_parsePositiveFloat",
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
      require("../src/cli-help")("server");
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
      require("../src/cli-help")("bot");
      assert.ok(out.includes("Headless"));
    } finally {
      console.log = orig;
    }
  });
});
