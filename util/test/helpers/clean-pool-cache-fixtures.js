/**
 * @file test/helpers/clean-pool-cache-fixtures.js
 * @description
 * Shared fixtures for the `util/cache/clean-pool-cache` suites.
 *
 * The tool's tests are split across two files — the CLI surface
 * (`clean-pool-cache-cli.test.js`) and the destructive surface
 * (`clean-pool-cache-wipe.test.js`) — because one file outgrew the
 * 500-line cap. Both need the same pool scope and the same scratch
 * directory helper, so they live here rather than being copied.
 *
 * `eventCacheName` / `lpCacheName` build filenames by calling the
 * tool's OWN abbreviation helper. Hand-rolling the abbreviations would
 * let a change to the scheme leave these fixtures silently stale, and
 * the tests would keep passing against filenames the real cache
 * writers no longer produce.
 *
 * Not a `*.test.js` file, so `node --test` never runs it directly.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cpc = require("../../cache/clean-pool-cache");

const POOL = "0x1234567890abcdef1234567890ABCDEF12345678";
const FACTORY = "0xCC05bf158fF2Bdc37eb0d2A2Ea6D2A4Ba1Bd0Ee7";
const TOKEN0 = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const TOKEN1 = "0x57fde0a71132198BBeC939B98976993d8D89D225";
const FEE = 2500;

const REGISTRY = {
  pulsechain: { displayName: "PulseChain" },
  "pulsechain-testnet": { displayName: "PulseChain Testnet" },
};

const SCOPE = {
  blockchain: "pulsechain",
  factory: FACTORY,
  token0: TOKEN0,
  token1: TOKEN1,
  fee: FEE,
};

/**
 * A fresh scratch directory, removed when the process exits.
 *
 * The tool's real paths point at `tmp/`, which holds live operator
 * caches; a test that wrote there would be one bad predicate away from
 * doing the very damage these tests exist to prevent.
 */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpc-test-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write `obj` as JSON to `dir/name` and return the full path. */
function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

/** Event-cache filename for one wallet under a pool scope. */
function eventCacheName(wallet, scope = SCOPE) {
  const a = cpc._abbrevScope(scope);
  return `event-cache-${a.bc}-${a.pm}-${wallet}-${a.t0}-${a.t1}-${a.fee}.json`;
}

/** lp-position-cache filename for one wallet under a chain+factory. */
function lpCacheName(wallet, scope = SCOPE) {
  const a = cpc._abbrevScope(scope);
  return `lp-position-cache-${a.bc}-${a.pm}-${wallet}.json`;
}

module.exports = {
  POOL,
  FACTORY,
  TOKEN0,
  TOKEN1,
  FEE,
  REGISTRY,
  SCOPE,
  scratch,
  writeJson,
  eventCacheName,
  lpCacheName,
};
