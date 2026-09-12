/**
 * @file test/clean-pool-cache-wipe.test.js
 * @description
 * Covers the destructive surface of `util/cache/clean-pool-cache.js` —
 * scope abbreviation, file globbing, the four per-surface wipers, RPC
 * token resolution and the `main` orchestration.
 *
 * This is the half that DELETES. An over-broad predicate silently
 * removes another pool's history, and the operator finds out as a
 * wrong number on a dashboard days later. The scope-matching tests
 * below therefore assert what is KEPT as carefully as what is removed.
 *
 * The CLI surface is covered by the sibling
 * `clean-pool-cache-cli.test.js`; the pure `filterPositionsForPool`
 * filter by `clean-pool-cache.test.js`.
 *
 * Every test runs against a scratch directory. The tool's real paths
 * point at `tmp/`, which holds live operator caches — a test that
 * wrote there would be one bad predicate away from doing the very
 * damage it is guarding against.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  captureConsole,
  captureExit,
} = require("../util/diagnostic/test/_capture");

const cpc = require("../util/cache/clean-pool-cache");
const {
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
} = require("./helpers/clean-pool-cache-fixtures");

/* ---------- scope abbreviation + globbing ---------- */

test("_abbrevScope — abbreviates each dimension the way writers do", () => {
  const a = cpc._abbrevScope(SCOPE);
  assert.equal(a.bc, "pulse");
  assert.equal(a.pm, FACTORY.slice(2, 8).toLowerCase());
  assert.equal(a.t0, TOKEN0.slice(2, 10).toLowerCase());
  assert.equal(a.t1, TOKEN1.slice(2, 10).toLowerCase());
  assert.equal(a.fee, "2500");
});

test("_abbrevScope — tolerates missing dimensions", () => {
  const a = cpc._abbrevScope({});
  assert.deepEqual(a, { bc: "", pm: "", t0: "", t1: "", fee: "undefined" });
});

test("findEventCacheFiles — matches every wallet for one pool only", () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, eventCacheName("aaaaaa")), "{}");
  fs.writeFileSync(path.join(dir, eventCacheName("bbbbbb")), "{}");
  /*- Same pair, different fee tier — a DIFFERENT pool. */
  fs.writeFileSync(
    path.join(dir, eventCacheName("aaaaaa", { ...SCOPE, fee: 10000 })),
    "{}",
  );
  fs.writeFileSync(path.join(dir, "unrelated.json"), "{}");

  const found = cpc
    .findEventCacheFiles(SCOPE, dir)
    .map((f) => path.basename(f));
  assert.equal(found.length, 2, "both wallets, and nothing else");
  assert.equal(
    found.every((n) => n.endsWith("-2500.json")),
    true,
    "the 10000-fee pool must not be swept up",
  );
});

test("findEventCacheFiles — empty list when the directory is absent", () => {
  assert.deepEqual(cpc.findEventCacheFiles(SCOPE, "/nonexistent/dir"), []);
});

test("findLpPositionCacheFiles — wildcards the wallet segment", () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, lpCacheName("aaaaaa")), "{}");
  fs.writeFileSync(path.join(dir, lpCacheName("bbbbbb")), "{}");
  fs.writeFileSync(
    path.join(dir, lpCacheName("cccccc", { ...SCOPE, factory: TOKEN0 })),
    "{}",
  );
  const found = cpc.findLpPositionCacheFiles(SCOPE, dir);
  assert.equal(found.length, 2, "other nft-factories are a different scope");
});

test("findLpPositionCacheFiles — empty list when the directory is absent", () => {
  assert.deepEqual(cpc.findLpPositionCacheFiles(SCOPE, "/nonexistent"), []);
});

/* ---------- per-surface wipers ---------- */

test("_wipeEventCache — deletes matching files and counts them", async () => {
  const dir = scratch();
  const a = path.join(dir, eventCacheName("aaaaaa"));
  const other = path.join(dir, "event-cache-other.json");
  fs.writeFileSync(a, "{}");
  fs.writeFileSync(other, "{}");

  const res = await captureConsole(() => cpc._wipeEventCache(SCOPE, dir));
  assert.equal(res.value, 1);
  assert.equal(fs.existsSync(a), false, "matched file deleted");
  assert.equal(fs.existsSync(other), true, "unmatched file untouched");
});

test("_wipeEventCache — reports and returns zero when nothing matches", async () => {
  const res = await captureConsole(() => cpc._wipeEventCache(SCOPE, scratch()));
  assert.equal(res.value, 0);
  assert.match(res.out.join("\n"), /no matching files/);
});

test("_wipePnlEpochs — removes only the six-part key for this pool", async () => {
  const dir = scratch();
  const mine = `pulsechain.${FACTORY}.0xWALLET.${TOKEN0}.${TOKEN1}.2500`;
  const otherFee = `pulsechain.${FACTORY}.0xWALLET.${TOKEN0}.${TOKEN1}.10000`;
  const otherWallet = `pulsechain.${FACTORY}.0xOTHER.${TOKEN0}.${TOKEN1}.2500`;
  const p = writeJson(dir, "epochs.json", {
    [mine]: { a: 1 },
    [otherFee]: { b: 2 },
    [otherWallet]: { c: 3 },
    "too.short": { d: 4 },
  });

  const res = await captureConsole(() =>
    cpc._wipePnlEpochs(
      { chainKey: "pulsechain", factory: FACTORY, tokens: { ...SCOPE } },
      p,
    ),
  );
  /*- Wallet is intentionally wildcarded — every wallet's entry for the
   *  same pool goes.  Fee is not: it identifies a different pool. */
  assert.equal(res.value, 2);
  const left = Object.keys(JSON.parse(fs.readFileSync(p, "utf8")));
  assert.deepEqual(left.sort(), [otherFee, "too.short"].sort());
});

test("_wipePnlEpochs — reports an absent file without failing", async () => {
  const res = await captureConsole(() =>
    cpc._wipePnlEpochs(
      { chainKey: "pulsechain", factory: FACTORY, tokens: { ...SCOPE } },
      path.join(scratch(), "absent.json"),
    ),
  );
  assert.equal(res.value, 0);
  assert.match(res.out.join("\n"), /file absent/);
});

test("_wipeLiquidityPairDetails — matches on prefix AND suffix", async () => {
  const dir = scratch();
  const a = cpc._abbrevScope(SCOPE);
  const mine = `${a.bc}-${a.pm}-abcdef-${a.t0}-${a.t1}-${a.fee}`;
  const otherFee = `${a.bc}-${a.pm}-abcdef-${a.t0}-${a.t1}-10000`;
  const p = writeJson(dir, "pair.json", { [mine]: 1, [otherFee]: 2 });

  const res = await captureConsole(() =>
    cpc._wipeLiquidityPairDetails(SCOPE, p),
  );
  assert.equal(res.value, 1);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(p, "utf8"))), [
    otherFee,
  ]);
});

test("_wipeLiquidityPairDetails — reports an absent file", async () => {
  const res = await captureConsole(() =>
    cpc._wipeLiquidityPairDetails(SCOPE, path.join(scratch(), "absent.json")),
  );
  assert.equal(res.value, 0);
  assert.match(res.out.join("\n"), /file absent/);
});

test("_wipeLpPositionCache — keeps other pools and preserves lastBlock", async () => {
  const dir = scratch();
  const p = path.join(dir, lpCacheName("aaaaaa"));
  fs.writeFileSync(
    p,
    JSON.stringify({
      positions: [
        { tokenId: "1", token0: TOKEN0, token1: TOKEN1, fee: FEE },
        { tokenId: "2", token0: TOKEN0, token1: TOKEN1, fee: 10000 },
      ],
      lastBlock: 987654,
    }),
  );

  const res = await captureConsole(() => cpc._wipeLpPositionCache(SCOPE, dir));
  assert.equal(res.value, 1);
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.deepEqual(
    after.positions.map((x) => x.tokenId),
    ["2"],
  );
  assert.equal(
    after.lastBlock,
    987654,
    "the scan cursor must survive; resetting it would re-walk the chain",
  );
});

test("_wipeLpPositionCache — deletes the file when nothing is left", async () => {
  const dir = scratch();
  const p = path.join(dir, lpCacheName("aaaaaa"));
  fs.writeFileSync(
    p,
    JSON.stringify({
      positions: [{ tokenId: "1", token0: TOKEN0, token1: TOKEN1, fee: FEE }],
      lastBlock: 5,
    }),
  );
  const res = await captureConsole(() => cpc._wipeLpPositionCache(SCOPE, dir));
  assert.equal(res.value, 1);
  assert.equal(fs.existsSync(p), false, "an empty cache is deleted, not kept");
});

test("_wipeLpPositionCache — handles empty and non-matching files", async () => {
  const dir = scratch();
  fs.writeFileSync(
    path.join(dir, lpCacheName("aaaaaa")),
    JSON.stringify({ positions: [] }),
  );
  fs.writeFileSync(
    path.join(dir, lpCacheName("bbbbbb")),
    JSON.stringify({
      positions: [{ tokenId: "9", token0: TOKEN1, token1: TOKEN0, fee: FEE }],
    }),
  );
  const res = await captureConsole(() => cpc._wipeLpPositionCache(SCOPE, dir));
  assert.equal(res.value, 0);
  const text = res.out.join("\n");
  assert.match(text, /nothing to filter/);
  assert.match(text, /no matching positions/);
});

test("_wipeLpPositionCache — returns zero when no files match", async () => {
  const res = await captureConsole(() =>
    cpc._wipeLpPositionCache(SCOPE, scratch()),
  );
  assert.equal(res.value, 0);
  assert.match(res.out.join("\n"), /no matching files/);
});

/* ---------- RPC token resolution ---------- */

/** ethers double whose contract calls resolve or reject per URL. */
function fakeEthers(behaviour) {
  return {
    JsonRpcProvider: class {
      constructor(url) {
        this.url = url;
      }
    },
    Contract: class {
      constructor(_addr, _abi, provider) {
        this.url = provider.url;
      }
      async token0() {
        return behaviour(this.url, "token0");
      }
      async token1() {
        return behaviour(this.url, "token1");
      }
      async fee() {
        return behaviour(this.url, "fee");
      }
    },
  };
}

const CFG = { RPC_URLS: ["http://primary", "http://fallback"] };

test("resolvePoolTokens — reads token0, token1 and a numeric fee", async () => {
  const eth = fakeEthers((_url, m) =>
    m === "fee" ? 2500n : m === "token0" ? TOKEN0 : TOKEN1,
  );
  const out = await cpc.resolvePoolTokens(POOL, eth, CFG);
  assert.deepEqual(out, { token0: TOKEN0, token1: TOKEN1, fee: 2500 });
  assert.equal(typeof out.fee, "number", "fee is normalised out of BigInt");
});

test("resolvePoolTokens — falls back to the secondary RPC", async () => {
  const eth = fakeEthers((url, m) => {
    if (url === "http://primary") throw new Error("primary down");
    return m === "fee" ? 500n : m === "token0" ? TOKEN0 : TOKEN1;
  });
  const res = await captureConsole(() => cpc.resolvePoolTokens(POOL, eth, CFG));
  assert.equal(res.value.fee, 500);
});

test("resolvePoolTokens — rethrows when no fallback is configured", async () => {
  const eth = fakeEthers(() => {
    throw new Error("primary down");
  });
  await assert.rejects(
    () => cpc.resolvePoolTokens(POOL, eth, { RPC_URLS: ["http://primary"] }),
    /primary down/,
  );
});

test("_resolveTokensOrExit — returns the resolved tokens", async () => {
  const res = await captureConsole(() =>
    cpc._resolveTokensOrExit(POOL, async () => ({
      token0: TOKEN0,
      token1: TOKEN1,
      fee: FEE,
    })),
  );
  assert.equal(res.value.fee, FEE);
  assert.match(res.out.join("\n"), /Resolving \(token0, token1, fee\)/);
});

test("_resolveTokensOrExit — aborts BEFORE touching any surface", async () => {
  /*- Without tokens the scope is unknown, so a "best effort" clean
   *  would match on partial dimensions and delete other pools' data. */
  const res = await captureConsole(() =>
    captureExit(() =>
      cpc._resolveTokensOrExit(POOL, async () => {
        throw new Error("rpc dead");
      }),
    ),
  );
  assert.equal(res.value.code, 1);
  const err = res.err.join("\n");
  assert.match(err, /RPC lookup of pool tokens failed: rpc dead/);
  assert.match(err, /Aborting before touching/);
  assert.match(err, /--preserve-pool-history/, "names the usable next step");
});

/* ---------- path resolution + main ---------- */

test("_mainPaths — defaults to the real locations", () => {
  const p = cpc._mainPaths();
  assert.match(p.dir, /tmp$/);
  assert.match(p.poolCreationPath, /pool-creation-blocks-cache\.json$/);
  assert.match(p.geckoPath, /gecko-pool-cache\.json$/);
  assert.match(p.epochPath, /pnl-epochs-cache\.json$/);
  assert.match(p.detailsPath, /liquidity-pair-details-cache\.json$/);
  assert.match(p.chainsPath, /chains\.json$/);
  assert.equal(typeof p.resolveTokens, "function");
});

test("_mainPaths — every key is overridable", () => {
  const p = cpc._mainPaths({ dir: "/d", chainsPath: "/c", geckoPath: "/g" });
  assert.equal(p.dir, "/d");
  assert.equal(p.chainsPath, "/c");
  assert.equal(p.geckoPath, "/g");
  assert.match(
    p.epochPath,
    /pnl-epochs-cache\.json$/,
    "untouched keys default",
  );
});

/** A scratch install with a chains registry and the lookup caches. */
function fixtureInstall() {
  const dir = scratch();
  return {
    dir,
    chainsPath: writeJson(dir, "chains.json", REGISTRY),
    poolCreationPath: writeJson(dir, "pcb.json", {
      [`pulsechain-${POOL}`]: 111,
      "pulsechain-0xotherpool": 222,
    }),
    geckoPath: writeJson(dir, "gecko.json", { [POOL.toLowerCase()]: "x" }),
    epochPath: path.join(dir, "epochs.json"),
    detailsPath: path.join(dir, "pair.json"),
  };
}

test("main — prints help and exits 0", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.main(["n", "s", "--help"])),
  );
  assert.equal(res.value.code, 0);
  assert.match(res.out.join("\n"), /clean-pool-cache/);
});

test("main — exits when the pool address is missing", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.main(["n", "s", "--chain", "pulsechain"])),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /missing required <poolAddress>/);
});

test("main — exits when --chain is missing", async () => {
  const res = await captureConsole(() =>
    captureExit(() => cpc.main(["n", "s", POOL, "--nft-factory", FACTORY])),
  );
  assert.equal(res.value.code, 1);
  assert.match(res.err.join("\n"), /--chain <name> is required/);
});

test("main --preserve-pool-history — cleans lookup caches only", async () => {
  const f = fixtureInstall();
  let rpcCalled = false;
  const res = await captureConsole(() =>
    cpc.main(
      [
        "n",
        "s",
        POOL,
        "--chain",
        "PulseChain",
        "--nft-factory",
        FACTORY,
        "--preserve-pool-history",
      ],
      {
        ...f,
        resolveTokens: async () => {
          rpcCalled = true;
          return {};
        },
      },
    ),
  );
  assert.equal(rpcCalled, false, "preserve mode must not need an RPC at all");
  const out = res.out.join("\n");
  assert.match(out, /preserve-pool-history \(lookup caches only\)/);
  assert.match(out, /across 2 surface\(s\)/);
  /*- The other pool's creation block must survive. */
  const pcb = JSON.parse(fs.readFileSync(f.poolCreationPath, "utf8"));
  assert.deepEqual(Object.keys(pcb), ["pulsechain-0xotherpool"]);
});

test("main — full mode sweeps every surface and totals the removals", async () => {
  const f = fixtureInstall();
  const evFile = path.join(f.dir, eventCacheName("aaaaaa"));
  fs.writeFileSync(evFile, "{}");
  writeJson(f.dir, path.basename(f.epochPath), {
    [`pulsechain.${FACTORY}.0xW.${TOKEN0}.${TOKEN1}.2500`]: {},
  });
  const a = cpc._abbrevScope(SCOPE);
  writeJson(f.dir, path.basename(f.detailsPath), {
    [`${a.bc}-${a.pm}-abcdef-${a.t0}-${a.t1}-${a.fee}`]: {},
  });
  fs.writeFileSync(
    path.join(f.dir, lpCacheName("aaaaaa")),
    JSON.stringify({
      positions: [{ tokenId: "1", token0: TOKEN0, token1: TOKEN1, fee: FEE }],
    }),
  );

  const res = await captureConsole(() =>
    cpc.main(
      ["n", "s", POOL, "--chain", "pulsechain", "--nft-factory", FACTORY],
      {
        ...f,
        resolveTokens: async () => ({
          token0: TOKEN0,
          token1: TOKEN1,
          fee: FEE,
        }),
      },
    ),
  );

  const out = res.out.join("\n");
  assert.match(out, /full \(every pool-scoped surface\)/);
  assert.match(out, /across 6 surface\(s\)/);
  /*- 1 pool-creation + 1 gecko + 1 event file + 1 epoch + 1 pair
   *  detail + 1 lp position = 6. */
  assert.match(out, /Removed 6 entry\(ies\)\/file\(s\)/);
  assert.equal(fs.existsSync(evFile), false);
});
