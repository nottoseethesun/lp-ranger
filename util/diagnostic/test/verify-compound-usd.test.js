/**
 * @file util/diagnostic/test/verify-compound-usd.test.js
 * @description
 * Tests for verify-compound-usd/: the pure helpers in
 * analysis.js and the CLI helpers in index.js.  The CLI
 * `main()` is gated behind `require.main === module` so it does not
 * start an RPC scan when this test file requires the tool.
 *
 * The fixtures are the real HEX / eHEX numbers from the 2026-08-04
 * compound on NFT #162980 that motivated the tool: 978.7011 HEX +
 * 1925.0556 eHEX deposited, both tokens 8 decimals, priced at
 * $0.00209314 and $0.00111662 — about $4.20 of fees, reported by the
 * bot as $240.10.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { captureConsole, captureExit } = require("./_capture");

const {
  usdOf,
  impliedPrices,
  decimalsShiftCandidates,
  recordedAmountsMatch,
  splitHistoryByNft,
  findPositionForTokenId,
  classifyIl,
  fmtUsd,
  fmtPrice,
  fmtRatio,
} = require("../verify-compound-usd/analysis");
const {
  buildProgram,
  argsFrom,
  resolveKey,
  tokenIdFromKey,
  loadConfig,
  resolveTarget,
} = require("../verify-compound-usd");

/** The compound that motivated this tool. */
const EV = { raw0: 97870110000n, raw1: 192505560000n };
const TOK = { d0: 8, d1: 8, p0: 0.00209314, p1: 0.00111662 };

test("usdOf — matches the compounder's own expression", () => {
  const usd = usdOf(EV.raw0, EV.raw1, TOK.d0, TOK.d1, TOK.p0, TOK.p1);
  assert.ok(Math.abs(usd - 4.198) < 0.01, `expected ~$4.20, got ${usd}`);
});

test("usdOf — treats missing prices as zero rather than NaN", () => {
  assert.equal(usdOf(100n, 100n, 2, 2, undefined, null), 0);
  assert.equal(usdOf(100n, 0n, 2, 2, 1, null), 1);
});

test("usdOf — a decimals shift scales the result by a power of ten", () => {
  const base = usdOf(EV.raw0, EV.raw1, 8, 8, TOK.p0, TOK.p1);
  const shifted = usdOf(EV.raw0, EV.raw1, 7, 8, TOK.p0, TOK.p1);
  const only0 = (Number(EV.raw0) / 1e8) * TOK.p0;
  assert.ok(Math.abs(shifted - (base + only0 * 9)) < 1e-6);
});

test("impliedPrices — names the token whose price explains the gap", () => {
  /*- Hold price1 live: what would price0 have to be for $240.10? */
  const imp = impliedPrices(240.1, EV, TOK);
  assert.ok(Math.abs(imp.liveUsd - 4.198) < 0.01);
  assert.ok(imp.impliedP0 > TOK.p0 * 100, "price0 must be wildly inflated");
  assert.ok(imp.impliedP1 > TOK.p1 * 100, "price1 must be wildly inflated");
  assert.ok(Math.abs(imp.uniformScale - 57.2) < 0.5);
});

test("impliedPrices — a correct figure implies the live prices back", () => {
  const live = usdOf(EV.raw0, EV.raw1, TOK.d0, TOK.d1, TOK.p0, TOK.p1);
  const imp = impliedPrices(live, EV, TOK);
  assert.ok(Math.abs(imp.impliedP0 - TOK.p0) < 1e-9);
  assert.ok(Math.abs(imp.impliedP1 - TOK.p1) < 1e-9);
  assert.ok(Math.abs(imp.uniformScale - 1) < 1e-9);
});

test("impliedPrices — a one-sided event yields a null implied price", () => {
  const imp = impliedPrices(10, { raw0: 100n, raw1: 0n }, TOK);
  assert.equal(imp.impliedP1, null);
  assert.ok(Number.isFinite(imp.impliedP0));
});

test("impliedPrices — zero-value event does not divide by zero", () => {
  const imp = impliedPrices(10, { raw0: 0n, raw1: 0n }, TOK);
  assert.equal(imp.liveUsd, 0);
  assert.equal(imp.uniformScale, null);
  assert.equal(imp.impliedP0, null);
  assert.equal(imp.impliedP1, null);
});

test("decimalsShiftCandidates — finds the reproducing shift", () => {
  /*- Build a figure that IS a pure decimals error: d1 read as 6. */
  const wrong = usdOf(EV.raw0, EV.raw1, 8, 6, TOK.p0, TOK.p1);
  const hits = decimalsShiftCandidates(wrong, EV, TOK);
  assert.ok(hits.length > 0);
  assert.equal(hits[0].d0, 8);
  assert.equal(hits[0].d1, 6);
  assert.ok(hits[0].rel < 1e-9);
});

test("decimalsShiftCandidates — no false hit for a pure price error", () => {
  /*- $240.10 is not reachable by any decimals shift within ±4 at 5%. */
  const hits = decimalsShiftCandidates(240.1, EV, TOK);
  for (const h of hits) assert.ok(h.rel <= 0.05);
  assert.ok(hits.length <= 3);
});

test("decimalsShiftCandidates — never proposes negative decimals", () => {
  const hits = decimalsShiftCandidates(1, EV, { ...TOK, d0: 1, d1: 1 });
  for (const h of hits) {
    assert.ok(h.d0 >= 0);
    assert.ok(h.d1 >= 0);
  }
});

test("decimalsShiftCandidates — a non-positive target returns nothing", () => {
  assert.deepEqual(decimalsShiftCandidates(0, EV, TOK), []);
  assert.deepEqual(decimalsShiftCandidates(-5, EV, TOK), []);
});

test("recordedAmountsMatch — string amounts equal chain BigInts", () => {
  const row = {
    amount0Deposited: "97870110000",
    amount1Deposited: "192505560000",
  };
  assert.equal(recordedAmountsMatch(row, EV), true);
});

test("recordedAmountsMatch — a differing amount is a mismatch", () => {
  const row = { amount0Deposited: "1", amount1Deposited: "192505560000" };
  assert.equal(recordedAmountsMatch(row, EV), false);
});

test("recordedAmountsMatch — missing/unparseable is a mismatch", () => {
  assert.equal(recordedAmountsMatch({}, EV), false);
  assert.equal(
    recordedAmountsMatch(
      { amount0Deposited: "not-a-number", amount1Deposited: "192505560000" },
      EV,
    ),
    false,
  );
  assert.equal(
    recordedAmountsMatch(
      { amount0Deposited: null, amount1Deposited: null },
      { raw0: 0n, raw1: 0n },
    ),
    false,
  );
});

test("splitHistoryByNft — separates own rows from siblings", () => {
  /*- Real shape: position 162272's compoundHistory carries rows for
   *  earlier NFTs in the same rebalance chain (e.g. 162237). */
  const history = [
    { tokenId: "162272", usdValue: 1 },
    { tokenId: "162237", usdValue: 2 },
    { tokenId: "162237", usdValue: 3 },
    { tokenId: "161973", usdValue: 4 },
  ];
  const { own, others } = splitHistoryByNft(history, "162272");
  assert.equal(own.length, 1);
  assert.equal(own[0].usdValue, 1);
  assert.equal(others.get("162237"), 2);
  assert.equal(others.get("161973"), 1);
});

test("splitHistoryByNft — numeric tokenId matches string target", () => {
  const { own, others } = splitHistoryByNft([{ tokenId: 162272 }], "162272");
  assert.equal(own.length, 1);
  assert.equal(others.size, 0);
});

test("splitHistoryByNft — rows with no tokenId count as own", () => {
  /*- Older rows have no tokenId; they must still be compared by txHash
   *  rather than being silently dropped. */
  const { own, others } = splitHistoryByNft([{ usdValue: 1 }], "162272");
  assert.equal(own.length, 1);
  assert.equal(others.size, 0);
});

test("splitHistoryByNft — empty history yields nothing", () => {
  const { own, others } = splitHistoryByNft([], "162272");
  assert.equal(own.length, 0);
  assert.equal(others.size, 0);
});

test("findPositionForTokenId — prefers the key matching the NFT", () => {
  const positions = {
    "pulsechain-0xW-0xPM-162272": { compoundHistory: [{ tokenId: "162237" }] },
    "pulsechain-0xW-0xPM-161973": { compoundHistory: [] },
  };
  const hit = findPositionForTokenId(positions, "162272");
  assert.equal(hit.key, "pulsechain-0xW-0xPM-162272");
});

test("findPositionForTokenId — falls back to the recorder", () => {
  /*- The rerun the tool prints for a sibling NFT must still find the
   *  config, or the recorded-row comparison silently never runs. */
  const positions = {
    "pulsechain-0xW-0xPM-162272": { compoundHistory: [{ tokenId: "162237" }] },
  };
  const hit = findPositionForTokenId(positions, "162237");
  assert.equal(hit.key, "pulsechain-0xW-0xPM-162272");
  assert.equal(hit.config.compoundHistory.length, 1);
});

test("findPositionForTokenId — null when no position knows it", () => {
  assert.equal(findPositionForTokenId({}, "162237"), null);
  assert.equal(
    findPositionForTokenId(
      { "pulsechain-0xW-0xPM-1": { compoundHistory: [] } },
      "162237",
    ),
    null,
  );
});

test("findPositionForTokenId — tolerates a missing positions map", () => {
  assert.equal(findPositionForTokenId(undefined, "1"), null);
});

test("classifyIl — first event is the mint when the mint is in window", () => {
  const il = [
    { amount0: 1n, amount1: 1n, blockNumber: 100 },
    { amount0: 2n, amount1: 2n, blockNumber: 200 },
  ];
  const out = classifyIl(il, [], true);
  assert.equal(out[0].kind, "mint");
  assert.equal(out[1].kind, "compound");
});

test("classifyIl — nothing is a mint when the mint predates the window", () => {
  const il = [
    { amount0: 1n, amount1: 1n, blockNumber: 100 },
    { amount0: 2n, amount1: 2n, blockNumber: 200 },
  ];
  const out = classifyIl(il, [], false);
  assert.deepEqual(
    out.map((o) => o.kind),
    ["compound", "compound"],
  );
});

test("classifyIl — an IL soon after a drain is a rebalance", () => {
  const il = [
    { amount0: 1n, amount1: 1n, blockNumber: 100 },
    { amount0: 2n, amount1: 2n, blockNumber: 5000 },
  ];
  const dl = [{ amount0: 9n, amount1: 9n, liquidity: 5n, blockNumber: 4990 }];
  const out = classifyIl(il, dl, true);
  assert.equal(out[0].kind, "mint");
  assert.equal(out[1].kind, "rebalance");
});

test("classifyIl — an empty event list stays empty", () => {
  assert.deepEqual(classifyIl([], [], false), []);
});

/** Parse an argv through the tool's Commander declaration. */
function args(argv) {
  return argsFrom(buildProgram().parse(argv, { from: "user" }));
}

/** A program that throws instead of exiting, and prints nothing. */
function quiet() {
  return buildProgram()
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
}

test("argsFrom — bare fragment plus the reported figure", () => {
  const a = args(["162980", "--usd", "240.10"]);
  assert.equal(a.target, "162980");
  assert.equal(a.usd, 240.1);
  assert.equal(a.days, 30);
  assert.equal(a.error, null);
});

test("argsFrom — --token-id skips the config lookup", () => {
  const a = args(["--token-id", "162980"]);
  assert.equal(a.tokenId, "162980");
  assert.equal(a.target, null);
  assert.equal(a.error, null);
});

test("buildProgram — rejects an unknown option instead of ignoring it", () => {
  assert.throws(
    () => quiet().parse(["--dayz", "5"], { from: "user" }),
    /unknown option/,
  );
});

test("buildProgram — rejects a non-numeric window", () => {
  assert.throws(
    () => quiet().parse(["162980", "--days", "lots"], { from: "user" }),
    /needs a number/,
  );
});

test("argsFrom — requires a target or --token-id", () => {
  /*- Commander cannot express "either of these two", since each alone
   *  satisfies it, so the rule lives in argsFrom and is asserted here. */
  assert.match(args([]).error, /need a composite key/);
  assert.equal(args(["162980"]).error, null);
  assert.equal(args(["--token-id", "1"]).error, null);
});

test("argsFrom — --from-block overrides are parsed as numbers", () => {
  assert.equal(
    args(["162980", "--from-block", "27000000"]).fromBlock,
    27000000,
  );
});

test("resolveKey — exact key, fragment, miss, and ambiguity", () => {
  const positions = {
    "pulsechain-0xW-0xPM-162980": {},
    "pulsechain-0xW-0xPM-161973": {},
  };
  assert.equal(
    resolveKey(positions, "pulsechain-0xW-0xPM-162980").key,
    "pulsechain-0xW-0xPM-162980",
  );
  assert.equal(
    resolveKey(positions, "162980").key,
    "pulsechain-0xW-0xPM-162980",
  );
  assert.match(resolveKey(positions, "999").error, /No position matches/);
  const amb = resolveKey(positions, "0xPM");
  assert.match(amb.error, /ambiguous/);
  assert.equal(amb.matches.length, 2);
});

test("tokenIdFromKey — extracts the tokenId, null when malformed", () => {
  assert.equal(tokenIdFromKey("pulsechain-0xW-0xPM-162980"), "162980");
  assert.equal(tokenIdFromKey("too-few-parts"), null);
});

test("formatters — render values and degrade to an em dash", () => {
  assert.equal(fmtUsd(1234.5), "$1,234.50");
  assert.equal(fmtUsd(null), "—");
  assert.equal(fmtUsd(Number.NaN), "—");
  assert.equal(fmtPrice(1.5), "$1.500000");
  assert.equal(fmtPrice(0.00209314), "$0.00209314");
  assert.equal(fmtPrice(null), "—");
  assert.equal(fmtRatio(57.14), "57.14x");
  assert.equal(fmtRatio(null), "—");
});

/* ---------- target resolution ---------- */

/** A scratch bot-config on disk; returns its path. */
function configFixture(positions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcu-test-"));
  const p = path.join(dir, "bot-config.json");
  fs.writeFileSync(p, JSON.stringify({ global: {}, positions }));
  return p;
}

const VCU_WALLET = "0x4e448D6fd48B2Bb0F2Ca5c1D1d34E4bDd5FE6E8f";
const VCU_PM = "0xCC05bf158fF2Bdc37eb0d2A2Ea6D2A4Ba1Bd0Ee7";
const VCU_KEY = `pulsechain-${VCU_WALLET}-${VCU_PM}-162980`;

test("loadConfig — returns null rather than throwing when absent", () => {
  /*- Absence is a normal state in --token-id mode, so it must not be
   *  an error at this layer. */
  assert.equal(loadConfig("/nonexistent/bot-config.json"), null);
});

test("loadConfig — parses a config that is present", () => {
  const p = configFixture({ [VCU_KEY]: { slippagePct: 1 } });
  assert.equal(loadConfig(p).positions[VCU_KEY].slippagePct, 1);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test("resolveTarget — a fragment resolves to its key and config row", () => {
  const p = configFixture({ [VCU_KEY]: { totalCompoundedUsd: 240.1 } });
  const out = resolveTarget({ target: "162980", tokenId: null }, p);
  assert.equal(out.tokenId, "162980");
  assert.equal(out.key, VCU_KEY);
  assert.equal(out.posConfig.totalCompoundedUsd, 240.1);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test("resolveTarget — --token-id still consults the config", () => {
  /*- The rows for a SIBLING nft live under the position key of the
   *  chain's current NFT.  Skipping the lookup would silently drop the
   *  recorded-row comparison for exactly the rerun this tool tells
   *  operators to perform. */
  const p = configFixture({
    [VCU_KEY]: { compoundHistory: [{ tokenId: "150000", usdValue: 4.2 }] },
  });
  const out = resolveTarget({ tokenId: "150000", target: null }, p);
  assert.equal(out.tokenId, "150000");
  assert.equal(out.key, VCU_KEY, "matched through the compound history");
  assert.equal(out.posConfig.compoundHistory[0].usdValue, 4.2);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test("resolveTarget — --token-id works with no config at all", () => {
  const out = resolveTarget(
    { tokenId: "162980", target: null },
    "/nonexistent/bot-config.json",
  );
  assert.deepEqual(out, { tokenId: "162980", posConfig: null, key: null });
});

test("resolveTarget — --token-id with an unmatched id keeps the id", () => {
  const p = configFixture({ [VCU_KEY]: {} });
  const out = resolveTarget({ tokenId: "999999", target: null }, p);
  assert.equal(out.tokenId, "999999");
  assert.equal(out.key, null, "no row found, but the scan can still run");
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test("resolveTarget — exits and points at --token-id when no config exists", async () => {
  const res = await captureConsole(() =>
    captureExit(() =>
      resolveTarget(
        { target: "162980", tokenId: null },
        "/nonexistent/bc.json",
      ),
    ),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /use --token-id instead/);
});

test("resolveTarget — exits and lists candidates when the fragment is ambiguous", async () => {
  const p = configFixture({
    [VCU_KEY]: {},
    [`pulsechain-${VCU_WALLET}-${VCU_PM}-1629801`]: {},
  });
  const res = await captureConsole(() =>
    captureExit(() => resolveTarget({ target: "162980", tokenId: null }, p)),
  );
  assert.equal(res.value.code, 1);
  assert.equal(
    res.err.filter((l) => l.includes("162980")).length >= 2,
    true,
    "both candidates are listed so the operator can disambiguate",
  );
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test("resolveTarget — exits and lists all positions when nothing matches", async () => {
  const p = configFixture({ [VCU_KEY]: {} });
  const res = await captureConsole(() =>
    captureExit(() => resolveTarget({ target: "999999", tokenId: null }, p)),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), new RegExp(VCU_KEY));
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test("buildProgram — a second positional is an error, not a silent drop", () => {
  assert.throws(
    () =>
      buildProgram()
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
        .parse(["162980", "extra"], { from: "user" }),
    /too many arguments/i,
  );
});
