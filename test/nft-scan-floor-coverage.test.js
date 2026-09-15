/**
 * @file test/nft-scan-floor-coverage.test.js
 * @description Every per-NFT event scan is bounded by that NFT's own
 *   mint block.
 *
 * An NFT cannot emit `IncreaseLiquidity`, `Collect` or
 * `DecreaseLiquidity` before it is minted, so resolving one floor for
 * the POOL and handing it to every NFT in a rebalance chain makes each
 * NFT walk every block before its own mint. On a long chain that is the
 * dominant cost of the whole scan: for a pool created two years before
 * the wallet's first deposit and a 132-rebalance chain, 954 chunks per
 * NFT across ~133 NFTs at the 9,000-block chunk width — the best part
 * of a day of paced requests, nearly all of it blocks where the NFT did
 * not yet exist.
 *
 * Five files scan a chain of NFTs, and nothing in the code connects
 * them, so this is a structural guard rather than a per-file rule. Any
 * file that scans one NFT's events must route its floor through
 * `src/nft-mint-blocks.js`, or be listed in `EXEMPT` below with a
 * reason. A new scan site fails CI until one of those is true.
 *
 * Sites are identified two ways, by helper name and by shape — see the
 * note on `NFT_LABEL`. Name matching alone only covers helpers the list
 * already knows about, which is the same limitation that let the same
 * mistake be made independently five times.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

/*- Named calls that scan one NFT's event history. */
const SCAN_CALLS =
  /\b(scanNftEvents|detectCompoundsOnChain|scanCollectAndDrain)\s*\(/;

/*- The general shape, independent of any helper's name: a chunked scan
 *  whose label names a tokenId is by definition a per-NFT scan.
 *
 *  This detector is what makes the guard complete. The name list above
 *  can only match helpers it already names, so a per-NFT scan reached
 *  through a new helper is invisible to it — and invisible to a guard
 *  is indistinguishable from bounded. */
const NFT_LABEL = /label:\s*`[^`]*#\$\{\s*tokenId\s*\}/;

/**
 * Files allowed to scan without importing the mint-block helper, and
 * why. Each entry is a claim a reader can check.
 */
const EXEMPT = {
  "compounder.js":
    "defines scanNftEvents/detectCompoundsOnChain; the floor is its caller's to set",
  "position-history-scan-helpers.js":
    "defines scanCollectAndDrain; both bounds are passed in by position-history.js",
  "event-scanner-mint-lookup.js":
    "searches FOR a mint block, so cannot be bounded by one; exits at the first hit instead",
  "hodl-baseline.js":
    "searches FOR the current NFT's mint block, so cannot be bounded by one",
  "position-history-mint.js":
    "searches FOR the chain's oldest NFT's mint block, so cannot be bounded by one",
};

/** Every src/ file that scans one NFT's events. */
function scanSites() {
  return fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => {
      const src = fs.readFileSync(path.join(SRC, f), "utf8");
      return SCAN_CALLS.test(src) || NFT_LABEL.test(src);
    });
}

/** Whether a file routes its floor through the shared helper. */
function isBounded(file) {
  const src = fs.readFileSync(path.join(SRC, file), "utf8");
  return /require\(["']\.\/nft-mint-blocks["']\)/.test(src);
}

describe("per-NFT scan floors", () => {
  it("finds the scan sites at all", () => {
    /*- Guards the guard: if the call names are ever renamed, this test
     *  would quietly pass by matching nothing. */
    assert.ok(
      scanSites().length >= 4,
      `expected several NFT scan sites, found ${scanSites().join(", ")}`,
    );
  });

  it("finds sites by label as well as by call name", () => {
    /*- If the label detector stops matching — a label reworded, the
     *  interpolation renamed — the guard narrows to name matching alone
     *  and still reports success. */
    const byLabel = fs
      .readdirSync(SRC)
      .filter((f) => f.endsWith(".js"))
      .filter((f) =>
        NFT_LABEL.test(fs.readFileSync(path.join(SRC, f), "utf8")),
      );
    assert.ok(
      byLabel.length >= 3,
      `the per-NFT label detector matched only ${byLabel.join(", ") || "nothing"}`,
    );
  });

  it("bounds every scan site by the NFT's own mint block", () => {
    const unbounded = scanSites().filter(
      (f) => !isBounded(f) && !(f in EXEMPT),
    );
    assert.deepEqual(
      unbounded,
      [],
      `these scan NFT events without a per-NFT floor: ${unbounded.join(", ")}. ` +
        "Use nftScanFrom() from src/nft-mint-blocks.js, or add an entry to " +
        "EXEMPT in this test saying why the NFT's mint block is not the " +
        "right lower bound.",
    );
  });

  it("keeps the exemption list honest", () => {
    /*- An exemption for a file that no longer scans is dead weight that
     *  makes the list look more considered than it is. */
    const sites = scanSites();
    for (const f of Object.keys(EXEMPT)) {
      assert.ok(
        sites.includes(f),
        `${f} is exempted but no longer scans NFT events — drop the entry`,
      );
    }
  });
});

describe("the loops that walk a rebalance chain", () => {
  /*- The shape this guard is about: iterate a set of tokenIds, scan
   *  each one. Every such loop must derive its floor per NFT. */
  const CHAIN_LOOPS = [
    "bot-recorder-scan-helpers.js",
    "position-details-lifetime-scan.js",
    "position-details-compound.js",
  ];

  for (const file of CHAIN_LOOPS) {
    it(`${file} derives a floor per NFT`, () => {
      const src = fs.readFileSync(path.join(SRC, file), "utf8");
      assert.match(
        src,
        /nftScanFrom|scanFloorFor/,
        `${file} loops over a chain of NFTs, so one shared fromBlock is wrong`,
      );
      assert.match(src, /mintBlocksByTokenId|mintBlocks/);
    });
  }
});
