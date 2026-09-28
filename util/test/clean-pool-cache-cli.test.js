/**
 * @file util/test/clean-pool-cache-cli.test.js
 * @description
 * Covers the CLI surface of `util/cache/clean-pool-cache.js` —
 * argument parsing, chain resolution, factory validation and the file
 * IO primitives the wipers are built on.
 *
 * The destructive surface (globbing, the four per-surface wipers, RPC
 * token resolution and `main`) is covered by the sibling
 * `clean-pool-cache-wipe.test.js`; the pure `filterPositionsForPool`
 * filter by `clean-pool-cache.test.js`. Split three ways because one
 * file outgrew the 500-line cap — extracted, not compacted.
 *
 * Every test runs against a scratch directory. The tool's real paths
 * point at `tmp/`, which holds live operator caches.
 *
 * `_capture` sits beside this file in `util/test/`: these tools are
 * console-first, and capturing stdout plus intercepting `process.exit`
 * is the same problem there and here. Copying it would be duplication.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { captureConsole, captureExit } = require("./_capture");

const cpc = require("../cache/clean-pool-cache");
const {
  POOL,
  FACTORY,
  TOKEN0,
  REGISTRY,
  scratch,
  writeJson,
} = require("./helpers/clean-pool-cache-fixtures");

/* ---------- argument parsing ---------- */

test("parseArgs — reads pool, chain, factory and the preserve flag", () => {
  const args = cpc.parseArgs([
    "node",
    "script",
    POOL,
    "--chain",
    "pulsechain",
    "--nft-factory",
    FACTORY,
    "--preserve-pool-history",
  ]);
  assert.equal(args.pool, POOL);
  assert.equal(args.chain, "pulsechain");
  assert.equal(args.factory, FACTORY);
  assert.equal(args.preserve, true);
  assert.equal(args.help, false);
});

test("parseArgs — accepts both --help and -h", () => {
  assert.equal(cpc.parseArgs(["n", "s", "--help"]).help, true);
  assert.equal(cpc.parseArgs(["n", "s", "-h"]).help, true);
});

test("parseArgs — a second address is rejected, not silently dropped", async () => {
  /*- Quietly ignoring it would clean a pool the operator did not name
   *  while appearing to have accepted both. */
  const res = await captureConsole(() =>
    captureExit(() => cpc.parseArgs(["n", "s", POOL, TOKEN0])),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /Unknown argument/);
});

test("parseArgs — exits on an unknown flag", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.parseArgs(["n", "s", "--wat"])),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /Unknown argument: --wat/);
});

test("parseArgs — exits when a value flag has no value", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.parseArgs(["n", "s", "--chain"])),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /--chain requires a value/);
});

test("parseArgs — a following flag does not count as a value", async () => {
  /*- `--chain --nft-factory 0x…` must not set chain to
   *  "--nft-factory"; that would resolve to an unknown chain later and
   *  report a confusing error far from the real mistake. */
  const res = await captureConsole(() =>
    captureExit(() =>
      cpc.parseArgs(["n", "s", "--chain", "--nft-factory", FACTORY]),
    ),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /--chain requires a value/);
});

/* ---------- chain registry ---------- */

test("resolveChainKey — matches the registry key, case-insensitively", () => {
  assert.equal(cpc.resolveChainKey("PulseChain", REGISTRY), "pulsechain");
  assert.equal(cpc.resolveChainKey("  pulsechain  ", REGISTRY), "pulsechain");
});

test("resolveChainKey — matches the human display name", () => {
  assert.equal(
    cpc.resolveChainKey("PulseChain Testnet", REGISTRY),
    "pulsechain-testnet",
  );
});

test("resolveChainKey — exits and lists valid values when unknown", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.resolveChainKey("ethereum", REGISTRY)),
  );
  assert.equal(res.value.code, 1);
  const err = res.err.join("\n");
  assert.match(err, /unknown blockchain "ethereum"/);
  assert.match(err, /pulsechain/, "must list what IS valid");
});

test("resolveChainKey — exits on an empty value", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.resolveChainKey("   ", REGISTRY)),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /--chain value is empty/);
});

test("loadChainsRegistry — reads a registry file", () => {
  const dir = scratch();
  const p = writeJson(dir, "chains.json", REGISTRY);
  assert.deepEqual(cpc.loadChainsRegistry(p), REGISTRY);
});

test("loadChainsRegistry — exits when the file is unreadable", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.loadChainsRegistry("/nonexistent/chains.json")),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /Failed to read/);
});

/* ---------- factory address validation ---------- */

test("validateFactoryAddress — returns a well-formed address unchanged", () => {
  assert.equal(cpc.validateFactoryAddress(FACTORY), FACTORY);
});

test("validateFactoryAddress — exits when missing", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.validateFactoryAddress(null)),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /--nft-factory <addr> is required/);
});

test("validateFactoryAddress — exits on a malformed address", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.validateFactoryAddress("0xdeadbeef")),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /not a 0x-prefixed 20-byte hex address/);
});

/* ---------- file IO primitives ---------- */

test("loadCacheOrNull — null for a missing file, object for a good one", () => {
  const dir = scratch();
  assert.equal(cpc.loadCacheOrNull(path.join(dir, "nope.json")), null);
  const p = writeJson(dir, "ok.json", { a: 1 });
  assert.deepEqual(cpc.loadCacheOrNull(p), { a: 1 });
});

test("loadCacheOrNull — exits on malformed JSON rather than guessing", async () => {
  const dir = scratch();
  const p = path.join(dir, "bad.json");
  fs.writeFileSync(p, "{ not json");
  const res = await captureConsole(() =>
    captureExit(() => cpc.loadCacheOrNull(p)),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /Failed to parse/);
});

test("saveCache — writes via a temp file and leaves none behind", () => {
  const dir = scratch();
  const p = path.join(dir, "out.json");
  cpc.saveCache(p, { hello: "world" });
  assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")), { hello: "world" });
  assert.equal(
    fs.existsSync(p + ".tmp"),
    false,
    "the temp file must be renamed, not left as debris",
  );
});

test("purgeMatchingKeys — removes matches and persists the result", () => {
  const dir = scratch();
  const cache = { keep: 1, dropme: 2, dropalso: 3 };
  const p = writeJson(dir, "c.json", cache);
  const removed = cpc.purgeMatchingKeys(p, cache, (k) => k.startsWith("drop"));
  assert.deepEqual(removed.sort(), ["dropalso", "dropme"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")), { keep: 1 });
});

test("purgeMatchingKeys — does not write when nothing matches", () => {
  /*- Rewriting an untouched cache would bump its mtime and, on a
   *  crash mid-write, risk a file that had no reason to be opened. */
  const dir = scratch();
  const p = path.join(dir, "untouched.json");
  const cache = { a: 1 };
  const removed = cpc.purgeMatchingKeys(p, cache, () => false);
  assert.deepEqual(removed, []);
  assert.equal(fs.existsSync(p), false, "no file should have been created");
});

test("reportFile — distinguishes absent, empty and populated", async () => {
  const absent = await captureConsole(() => cpc.reportFile("x", null));
  assert.match(absent.out.join("\n"), /file absent/);

  const empty = await captureConsole(() => cpc.reportFile("x", []));
  assert.match(empty.out.join("\n"), /no matching entries/);

  const some = await captureConsole(() => cpc.reportFile("x", ["k1", "k2"]));
  const text = some.out.join("\n");
  assert.match(text, /removed 2 entry\(ies\)/);
  assert.match(text, /- k1/, "each removed key is listed for the audit trail");
  assert.match(text, /- k2/);
});
