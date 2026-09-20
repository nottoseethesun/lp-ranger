/**
 * @file util/diagnostic/test/rescan-pool-history.test.js
 * @description
 * Tests for the pure helpers in rescan-pool-history.js.  This tool had
 * no test file at all and, until this suite was added, no
 * `require.main === module` guard either — requiring it launched the
 * CLI.  The guard plus a `module.exports` of the helpers is what makes
 * these assertions possible.
 *
 * The tool MUTATES operator state (bot-config.json, the epoch cache),
 * so nothing here touches the real files: every test drives the pure
 * key-resolution helpers, and the one write path is exercised against a
 * temp file.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  _parseArgs,
  _findPositionKey,
  _filterDescription,
  _findPoolKey,
  _clearsHodl,
  _writeJson,
} = require("../rescan-pool-history");
const { captureConsole, captureExit } = require("./_capture");

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const KEY = `pulsechain-${WALLET}-${PM}-162980`;

test("_parseArgs — splits positionals from --flag value pairs", () => {
  const { positional, flags } = _parseArgs([
    "162980",
    "--wallet",
    WALLET,
    "--fee",
    "2500",
  ]);
  assert.deepEqual(positional, ["162980"]);
  assert.equal(flags.wallet, WALLET);
  assert.equal(flags.fee, "2500");
});

test("_parseArgs — a flag with no value is boolean true", () => {
  const { flags } = _parseArgs(["1", "--clear-hodl", "--yes"]);
  assert.equal(flags["clear-hodl"], true);
  assert.equal(flags.yes, true);
});

test("_parseArgs — a flag followed by another flag stays boolean", () => {
  const { flags } = _parseArgs(["--yes", "--fee", "2500"]);
  assert.equal(flags.yes, true);
  assert.equal(flags.fee, "2500");
});

test("_parseArgs — empty argv yields empty positionals and flags", () => {
  const { positional, flags } = _parseArgs([]);
  assert.deepEqual(positional, []);
  assert.deepEqual(flags, {});
});

test("_filterDescription — renders only the flags that are set", () => {
  assert.equal(_filterDescription({}), "");
  assert.equal(
    _filterDescription({ blockchain: "pulsechain" }),
    " (blockchain=pulsechain)",
  );
  assert.equal(
    _filterDescription({ wallet: "0xW", contract: "0xC" }),
    " (wallet=0xW, contract=0xC)",
  );
});

test("_findPositionKey — returns the single matching composite key", () => {
  const positions = { [KEY]: {}, "pulsechain-0xW-0xC-1": {} };
  assert.equal(_findPositionKey(positions, "162980", {}), KEY);
});

test("_findPositionKey — wallet filter is case-insensitive", () => {
  const positions = { [KEY]: {} };
  const found = _findPositionKey(positions, "162980", {
    wallet: WALLET.toLowerCase(),
  });
  assert.equal(found, KEY);
});

test("_findPositionKey — ignores keys that are not 4 segments", () => {
  const positions = { "too-few-parts": {}, [KEY]: {} };
  assert.equal(_findPositionKey(positions, "162980", {}), KEY);
});

test("_findPositionKey — exits 1 when nothing matches", async () => {
  const res = await captureConsole(() =>
    captureExit(() => _findPositionKey({}, "162980", { wallet: "0xW" })),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /no position with tokenId/);
  /*- The filter context must be echoed so the operator can see WHY
   *  nothing matched. */
  assert.match(res.err.join("\n"), /wallet=0xW/);
});

test("_findPositionKey — exits 1 and lists both on ambiguity", async () => {
  const positions = {
    [`pulsechain-${WALLET}-${PM}-162980`]: {},
    [`pulsechain-0xOTHER-${PM}-162980`]: {},
  };
  const res = await captureConsole(() =>
    captureExit(() => _findPositionKey(positions, "162980", {})),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /AMBIGUOUS/);
  assert.equal(
    res.err.filter((l) => l.includes("162980")).length >= 2,
    true,
    "both candidate keys must be printed",
  );
});

test("_findPoolKey — matches on blockchain.contract.wallet prefix", () => {
  const poolKey =
    `pulsechain.${PM}.${WALLET}.0x2b591e99.0x57fde0a7.2500`.toLowerCase();
  const found = _findPoolKey({ [poolKey]: {} }, KEY, {});
  assert.deepEqual(found, [poolKey]);
});

test("_findPoolKey — returns null when no pool entry matches", () => {
  assert.equal(_findPoolKey({}, KEY, {}), null);
});

test("_findPoolKey — token0 must match a whole segment, not a prefix", () => {
  /*- Guards the documented `.`-boundary rule: token0=0xabc must not
   *  false-match a key whose token0 is 0xabcdef. */
  const k = `pulsechain.${PM}.${WALLET}.0xabcdef.0x57fde0a7.2500`.toLowerCase();
  assert.equal(_findPoolKey({ [k]: {} }, KEY, { token0: "0xabc" }), null);
});

test("_findPoolKey — full six-component key matches exactly", () => {
  const k =
    `pulsechain.${PM}.${WALLET}.0x2b591e99.0x57fde0a7.2500`.toLowerCase();
  const found = _findPoolKey({ [k]: {} }, KEY, {
    token0: "0x2b591e99",
    token1: "0x57fde0a7",
    fee: 2500,
  });
  assert.deepEqual(found, [k]);
});

test("_findPoolKey — exits 1 when several pools share the prefix", async () => {
  const base = `pulsechain.${PM}.${WALLET}`.toLowerCase();
  const cache = {
    [`${base}.0xaaa.0xbbb.2500`]: {},
    [`${base}.0xccc.0xddd.10000`]: {},
  };
  const res = await captureConsole(() =>
    captureExit(() => _findPoolKey(cache, KEY, {})),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /AMBIGUOUS/);
  assert.match(res.err.join("\n"), /--token0/);
});

test("_clearsHodl — only with --clear-hodl and a pool entry to clear", () => {
  const flag = { "clear-hodl": true };
  const cases = [
    { keys: ["k"], flags: flag, want: true, why: "asked, entry found" },
    { keys: ["k"], flags: {}, want: false, why: "not asked" },
    {
      keys: ["k"],
      flags: { "clear-hodl": null },
      want: false,
      why: "a null flag is not a request",
    },
    { keys: [], flags: flag, want: false, why: "no entry found" },
    { keys: null, flags: flag, want: false, why: "no entry looked up" },
  ];
  for (const c of cases) {
    const got = _clearsHodl(c.keys, c.flags);
    assert.equal(got, c.want, c.why);
  }
});

test("_writeJson — writes via a temp file and leaves no .tmp behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescan-test-"));
  const target = path.join(dir, "out.json");
  try {
    _writeJson(target, { a: 1, b: [2, 3] });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), {
      a: 1,
      b: [2, 3],
    });
    assert.equal(fs.existsSync(target + ".tmp"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("_writeJson — overwrites an existing file atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescan-test-"));
  const target = path.join(dir, "out.json");
  try {
    fs.writeFileSync(target, '{"old":true}');
    _writeJson(target, { fresh: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), {
      fresh: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
