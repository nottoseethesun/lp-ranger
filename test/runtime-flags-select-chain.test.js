/**
 * @file test/runtime-flags-select-chain.test.js
 * @description Resolving which blockchain the app runs against, in two
 *   steps: `resolveChainName` picks the name, `selectChain` looks up its
 *   entry in chains.json. Both throw rather than guess.
 *
 * The throws are the point. A chain entry carries the RPC endpoints and
 * the contract addresses every transaction is built against, so serving
 * a different entry for an unrecognised name means transactions go to a
 * chain the operator did not ask for. The name keeps the requested
 * string either way, and that string is what reaches composite position
 * keys, cache filenames and notifications — so a substitution leaves no
 * trace in anything the run records.
 *
 * Both functions are exported and driven directly rather than through a
 * require-cache reload, because `src/runtime-flags.js` resolves the chain
 * at module load: a test going through `process.env` would be asserting
 * on the one module instance the whole test run shares.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const runtimeFlags = require("../src/runtime-flags");
const { resolveChainName, selectChain } = runtimeFlags;
const { loadMergedDefaults } = require("../src/load-merged-defaults");

const CHAINS = loadMergedDefaults("chains.json");
const APP_RUNTIME = loadMergedDefaults("app-runtime.json");

const FIXTURE = {
  pulsechain: { chainId: 369 },
  "pulsechain-testnet": { chainId: 943 },
};

describe("resolveChainName", () => {
  it("lets CHAIN_NAME override the JSON default", () => {
    assert.equal(
      resolveChainName("pulsechain-testnet", "pulsechain"),
      "pulsechain-testnet",
    );
  });

  it("normalises case and surrounding whitespace", () => {
    assert.equal(resolveChainName("  PulseChain  ", "x"), "pulsechain");
    assert.equal(resolveChainName(undefined, " PULSECHAIN "), "pulsechain");
  });

  describe("a CHAIN_NAME that is not a usable name is no override", () => {
    /*- Each source counts only when it yields a non-empty trimmed
     *  string, so a stray .env line cannot defeat the JSON default. The
     *  throw is on the resolved value, not on either source alone. */
    for (const [label, value] of [
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace", "   "],
      ["NaN", NaN],
      ["null", null],
      ["a number", 369],
      ["an object", {}],
    ]) {
      it(`${label} falls through to defaults.chain`, () => {
        assert.equal(resolveChainName(value, "pulsechain"), "pulsechain");
      });
    }
  });

  describe("throws when NEITHER source yields a usable name", () => {
    for (const [label, value] of [
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace", "   "],
      ["NaN", NaN],
      ["null", null],
      ["a number", 369],
    ]) {
      it(`defaults.chain is ${label}`, () => {
        assert.throws(() => resolveChainName(undefined, value), Error);
      });
    }
  });

  it("names the JSON fix first, and .env second", () => {
    /*- The JSON file is where the name belongs; .env is the headless
     *  case. An error that leads with .env sends the reader to the
     *  layer they should be using least. */
    const msg = _messageFrom(() => resolveChainName("  ", ""));
    const json = msg.indexOf("app-runtime.json");
    const env = msg.indexOf(".env");
    assert.ok(json > -1 && env > -1, msg);
    assert.ok(json < env, `.env is named before the JSON fix:\n${msg}`);
  });

  it("points at the user-configurable copy, not the shipped one", () => {
    /*- Editing the shipped copy works until the next upgrade
     *  overwrites it. */
    const msg = _messageFrom(() => resolveChainName(undefined, ""));
    assert.match(msg, /user-configurable\/app-runtime\.json/);
  });

  it("reports what each source actually held", () => {
    const msg = _messageFrom(() => resolveChainName(NaN, undefined));
    assert.match(msg, /defaults\.chain=unset/);
    assert.match(msg, /CHAIN_NAME=NaN/);
  });
});

describe("selectChain", () => {
  it("returns the entry the name asks for", () => {
    assert.equal(selectChain(FIXTURE, "pulsechain").chainId, 369);
  });

  it("returns a different entry for a different name", () => {
    /*- Pinning both directions: a lookup that always returned the first
     *  entry would pass the test above on its own. */
    assert.equal(selectChain(FIXTURE, "pulsechain-testnet").chainId, 943);
  });

  it("throws on a name that matches no entry", () => {
    assert.throws(() => selectChain(FIXTURE, "ethereum"), /ethereum/);
  });

  it("throws on a near-miss rather than serving mainnet", () => {
    /*- The failure this guards: a typo used to resolve to the mainnet
     *  entry, so the bot ran against PulseChain mainnet contracts while
     *  every key and filename it wrote said `pulschain`. */
    assert.throws(() => selectChain(FIXTURE, "pulschain"), Error);
  });

  it("names the configured chains in the error", () => {
    /*- An error that does not say what IS accepted leaves the operator
     *  guessing at the spelling that just failed. */
    assert.throws(
      () => selectChain(FIXTURE, "ethereum"),
      /pulsechain, pulsechain-testnet/,
    );
  });

  it("names the JSON fix first, and .env second", () => {
    const msg = _messageFrom(() => selectChain(FIXTURE, "ethereum"));
    const json = msg.indexOf("app-runtime.json");
    const env = msg.indexOf(".env");
    assert.ok(json > -1 && env > -1, msg);
    assert.ok(json < env, `.env is named before the JSON fix:\n${msg}`);
  });

  it("throws rather than dereferencing an absent chains map", () => {
    assert.throws(() => selectChain(undefined, "pulsechain"), Error);
    assert.throws(() => selectChain({}, "pulsechain"), Error);
  });

  it("throws on a name that is not a usable string", () => {
    for (const bad of [undefined, "", "   ", NaN, null, 369])
      assert.throws(() => selectChain(FIXTURE, bad), Error);
  });
});

describe("the shipped configuration resolves", () => {
  it("defines more than one chain", () => {
    assert.ok(
      Object.keys(CHAINS).length >= 2,
      `chains.json defines only ${Object.keys(CHAINS).length}`,
    );
  });

  it("can select every chain chains.json defines", () => {
    /*- A shipped chain that cannot be selected is now a startup crash
     *  for anyone who sets CHAIN_NAME to it. */
    for (const name of Object.keys(CHAINS))
      assert.ok(selectChain(CHAINS, name));
  });

  it("resolves defaults.chain to a real chains.json entry", () => {
    /*- The wiring itself: app-runtime.json holds the only copy of the
     *  default chain name, so a value that names no entry would crash
     *  every install that has not set CHAIN_NAME. */
    const name = resolveChainName(undefined, APP_RUNTIME.defaults.chain);
    assert.ok(selectChain(CHAINS, name));
  });

  it("is what the module actually resolved at load", () => {
    /*- Guards against the two functions being correct while the module
     *  still picks its chain some other way. Skipped when the
     *  environment sets CHAIN_NAME, since that legitimately wins. */
    if (_cleanEnvChainName()) return;
    assert.equal(runtimeFlags.CHAIN_NAME, APP_RUNTIME.defaults.chain);
    assert.equal(
      runtimeFlags.CHAIN,
      selectChain(CHAINS, APP_RUNTIME.defaults.chain),
    );
  });
});

/** Message text of whatever `fn` throws. Fails the test if it does not. */
function _messageFrom(fn) {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  return assert.fail("expected a throw");
}

/** Trimmed CHAIN_NAME from the environment the test run inherited. */
function _cleanEnvChainName() {
  return (process.env.CHAIN_NAME || "").trim();
}
