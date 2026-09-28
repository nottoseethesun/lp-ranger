/**
 * @file util/test/reconcile-hodl.test.js
 * @description
 * Tests for the pure helpers in reconcile-hodl/index.js.  The CLI `main()`
 * is gated behind `require.main === module` so it does not start
 * an RPC scan when this test file requires the tool.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { captureConsole, captureExit } = require("./_capture");

const {
  parseKey,
  totals,
  deriveAggregates,
  readDecimals,
  accumulateChain,
  loadConfigOrExit,
  resolveKey,
} = require("../diagnostic/reconcile-hodl");
/*- toFloat / fmtDelta live in the render module now — imported from
 *  their owner, never re-exported through reconcile-hodl/index.js. */
const { toFloat, fmtDelta } = require("../diagnostic/reconcile-hodl/render");

const TOKEN = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";

test("parseKey — splits a well-formed composite key", () => {
  const out = parseKey("pulsechain-0xWALLET-0xPM-159250");
  assert.deepEqual(out, {
    blockchain: "pulsechain",
    wallet: "0xWALLET",
    contract: "0xPM",
    tokenId: "159250",
  });
});

test("parseKey — returns null for malformed keys", () => {
  assert.equal(parseKey("only-three-parts"), null);
  assert.equal(parseKey("a-b-c-d-e"), null);
  assert.equal(parseKey(""), null);
});

test("totals — sums amount0 and amount1 across event list", () => {
  const events = [
    { args: { amount0: 1000n, amount1: 2000n } },
    { args: { amount0: 500n, amount1: 1500n } },
  ];
  assert.deepEqual(totals(events), { s0: 1500n, s1: 3500n });
});

test("totals — empty list returns zeros", () => {
  assert.deepEqual(totals([]), { s0: 0n, s1: 0n });
});

test("totals — handles BigInt inputs correctly", () => {
  /*- Realistic large 18-decimal raw values. */
  const events = [
    { args: { amount0: 123456789012345678n, amount1: 0n } },
    { args: { amount0: 876543210987654322n, amount1: 0n } },
  ];
  assert.equal(totals(events).s0, 1000000000000000000n);
});

test("toFloat — converts raw BigInt to a JS number using decimals", () => {
  assert.equal(toFloat(10n ** 18n, 18), 1);
  assert.equal(toFloat(5n * 10n ** 17n, 18), 0.5);
});

test("toFloat — returns 0 for zero input", () => {
  assert.equal(toFloat(0n, 18), 0);
  assert.equal(toFloat(0n, 6), 0);
});

test("toFloat — handles 6-decimal tokens (like USDC)", () => {
  /*- 1.5 USDC = 1_500_000 raw units. */
  assert.equal(toFloat(1_500_000n, 6), 1.5);
});

test("fmtDelta — shows actual + cached + signed delta", () => {
  /*- on-chain 1.5, cached 1.2 → Δ +0.3. */
  const out = fmtDelta(15n * 10n ** 17n, 1.2, 18);
  assert.match(out, /1\.500000/);
  assert.match(out, /cached: 1\.200000/);
  assert.match(out, /Δ \+0\.300000/);
});

test("fmtDelta — shows negative delta with a leading minus", () => {
  /*- on-chain 1.0, cached 1.5 → Δ -0.5 (no leading +). */
  const out = fmtDelta(10n ** 18n, 1.5, 18);
  assert.match(out, /Δ -0\.500000/);
});

test("fmtDelta — shows '(cached: —)' when cached value is missing", () => {
  assert.match(fmtDelta(10n ** 18n, undefined, 18), /cached: —/);
  assert.match(fmtDelta(10n ** 18n, null, 18), /cached: —/);
  assert.match(fmtDelta(10n ** 18n, NaN, 18), /cached: —/);
});

/* ---------- aggregate derivation ---------- */

test("deriveAggregates — net principal is IL minus DL", () => {
  const d = deriveAggregates({
    ilSum0: 1000n,
    ilSum1: 2000n,
    dlSum0: 400n,
    dlSum1: 500n,
    colSum0: 900n,
    colSum1: 800n,
  });
  assert.equal(d.netPrincipal0, 600n);
  assert.equal(d.netPrincipal1, 1500n);
});

test("deriveAggregates — approximate fees are Collect minus DL", () => {
  const d = deriveAggregates({
    ilSum0: 0n,
    ilSum1: 0n,
    dlSum0: 100n,
    dlSum1: 100n,
    colSum0: 175n,
    colSum1: 250n,
  });
  assert.equal(d.fees0, 75n);
  assert.equal(d.fees1, 150n);
});

test("deriveAggregates — clamps at zero instead of going negative", () => {
  /*- A negative "net principal" or "fees" is not a small number, it is
   *  a nonsense one; printing it would invite the operator to act on
   *  an artefact of event ordering. */
  const d = deriveAggregates({
    ilSum0: 10n,
    ilSum1: 10n,
    dlSum0: 999n,
    dlSum1: 999n,
    colSum0: 1n,
    colSum1: 1n,
  });
  assert.equal(d.netPrincipal0, 0n);
  assert.equal(d.netPrincipal1, 0n);
  assert.equal(d.fees0, 0n);
  assert.equal(d.fees1, 0n);
});

test("deriveAggregates — equal sums clamp to zero, not to a negative", () => {
  const d = deriveAggregates({
    ilSum0: 500n,
    ilSum1: 500n,
    dlSum0: 500n,
    dlSum1: 500n,
    colSum0: 500n,
    colSum1: 500n,
  });
  assert.equal(d.netPrincipal0, 0n);
  assert.equal(d.fees1, 0n);
});

/* ---------- chain accumulation ---------- */

/** One NFT's worth of events, shaped as the tool consumes them. */
function evt(amount0, amount1) {
  return { args: { amount0, amount1 } };
}

test("accumulateChain — sums IL, DL and Collect across every NFT", async () => {
  const perToken = {
    100: {
      ilEvents: [evt(10n, 20n), evt(5n, 5n)],
      dlEvents: [evt(3n, 4n)],
      collectEvents: [evt(7n, 8n)],
    },
    200: {
      ilEvents: [evt(1n, 2n)],
      dlEvents: [],
      collectEvents: [evt(1n, 1n)],
    },
  };
  const res = await captureConsole(() =>
    accumulateChain(
      null,
      ["100", "200"],
      0,
      0,
      async (_p, tid) => perToken[tid],
    ),
  );
  assert.deepEqual(res.value, {
    ilSum0: 16n,
    ilSum1: 27n,
    dlSum0: 3n,
    dlSum1: 4n,
    colSum0: 8n,
    colSum1: 9n,
  });
});

test("accumulateChain — prints a header plus one row per NFT", async () => {
  const res = await captureConsole(() =>
    accumulateChain(null, ["100", "200"], 0, 0, async () => ({
      ilEvents: [evt(1n, 1n)],
      dlEvents: [],
      collectEvents: [],
    })),
  );
  const rows = res.out.filter((l) => /^\d+\s/.test(l));
  assert.equal(rows.length, 2, "one row per token id");
  assert.match(res.out.join("\n"), /tokenId\s+IL_count/);
});

test("accumulateChain — an empty chain yields zero sums, no rows", async () => {
  const res = await captureConsole(() => accumulateChain(null, [], 8, 8));
  assert.equal(res.value.ilSum0, 0n);
  assert.equal(
    res.out.filter((l) => /^\d+\s/.test(l)).length,
    0,
    "no NFTs means no table rows",
  );
});

/** Provider double returning an ABI-encoded uint8 for every eth_call. */
function decimalsProvider(value) {
  return { call: async () => "0x" + value.toString(16).padStart(64, "0") };
}

test("readDecimals — normalises the contract's uint8 to a number", async () => {
  /*- ethers hands back a BigInt.  A BigInt reaching toFloat throws on
   *  the mixed-type arithmetic there; a string would silently scale
   *  every displayed amount by orders of magnitude. */
  const d = await readDecimals(decimalsProvider(8), TOKEN);
  assert.equal(d, 8);
  assert.equal(typeof d, "number");
});

test("readDecimals — reads 18-decimal tokens as 18, not as truthy", async () => {
  assert.equal(await readDecimals(decimalsProvider(18), TOKEN), 18);
});

test("readDecimals — a zero-decimal token stays 0", async () => {
  /*- 0 is falsy: any `decimals || 18` style fallback downstream would
   *  turn this into 18 and shrink every amount by 10^18. */
  assert.equal(await readDecimals(decimalsProvider(0), TOKEN), 0);
});

/* ---------- config + key resolution failures ---------- */

test("loadConfigOrExit — reads a config file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-test-"));
  const p = path.join(dir, "bot-config.json");
  fs.writeFileSync(p, JSON.stringify({ positions: { a: 1 } }));
  assert.deepEqual(loadConfigOrExit(p), { positions: { a: 1 } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadConfigOrExit — exits when the config is absent", async () => {
  const res = await captureConsole(() =>
    captureExit(() => loadConfigOrExit("/nonexistent/bot-config.json")),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /No config at/);
});

test("resolveKey — exact key wins over fragment matching", () => {
  const positions = { "pulsechain-0xW-0xC-1": {}, "pulsechain-0xW-0xC-12": {} };
  assert.equal(
    resolveKey(positions, "pulsechain-0xW-0xC-1"),
    "pulsechain-0xW-0xC-1",
    "an exact hit must not be treated as an ambiguous fragment",
  );
});

test("resolveKey — resolves a unique fragment", () => {
  const positions = { "pulsechain-0xW-0xC-162980": {} };
  assert.equal(resolveKey(positions, "162980"), "pulsechain-0xW-0xC-162980");
});

test("resolveKey — exits and lists configured positions when nothing matches", async () => {
  const positions = { "pulsechain-0xW-0xC-1": {} };
  const res = await captureConsole(() =>
    captureExit(() => resolveKey(positions, "999")),
  );
  assert.equal(res.value.code, 1);
  const err = res.err.join("\n");
  assert.match(err, /No position matches "999"/);
  assert.match(err, /pulsechain-0xW-0xC-1/, "shows what IS configured");
});

test("resolveKey — exits and lists both candidates when ambiguous", async () => {
  /*- Guessing here would reconcile a position the operator did not
   *  name, and the report would look perfectly plausible. */
  const positions = {
    "pulsechain-0xW-0xC-162980": {},
    "pulsechain-0xW-0xC-1629801": {},
  };
  const res = await captureConsole(() =>
    captureExit(() => resolveKey(positions, "162980")),
  );
  assert.equal(res.value.code, 1);
  const err = res.err.join("\n");
  assert.match(err, /is ambiguous/);
  assert.equal(
    err.split("\n").filter((l) => l.includes("162980")).length >= 2,
    true,
  );
});
