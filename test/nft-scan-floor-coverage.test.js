/**
 * @file test/nft-scan-floor-coverage.test.js
 * @description Every per-NFT event scan is bounded by that NFT's own
 *   mint block.
 *
 * This mistake has now been made four separate times, in four files,
 * because nothing connected them: each one resolved a floor for the
 * POOL and handed the same floor to every NFT in the rebalance chain.
 * An NFT cannot emit `IncreaseLiquidity`, `Collect` or
 * `DecreaseLiquidity` before it is minted, so those pre-mint blocks are
 * a guaranteed-empty walk — and on a long chain they are the dominant
 * cost of the entire scan.
 *
 * Measured on a real position: a pool created two years before the
 * operator's first deposit, a 132-rebalance chain, 1,144 chunks per NFT
 * across ~133 NFTs at three queries each. About 32 hours, nearly all of
 * it scanning blocks where the NFT did not yet exist. The first fix
 * caught two of the four sites; the operator's log then showed the same
 * NFT scanned at 21 chunks by a fixed path and 1,144 by an unfixed one,
 * four minutes apart.
 *
 * So this is a structural guard rather than another point fix. Any file
 * that scans NFT events must route its floor through
 * `src/nft-mint-blocks.js`, or be listed below with a reason. A new
 * scan site fails CI until one of those is true.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

/** Calls that scan one NFT's event history. */
const SCAN_CALLS = /\b(scanNftEvents|detectCompoundsOnChain)\s*\(/;

/**
 * Files allowed to call a scan without importing the mint-block helper,
 * and why. Each entry is a claim a reader can check.
 */
const EXEMPT = {
  "compounder.js":
    "defines scanNftEvents/detectCompoundsOnChain; the floor is its caller's to set",
};

/** Every src/ file that scans NFT events. */
function scanSites() {
  return fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => SCAN_CALLS.test(fs.readFileSync(path.join(SRC, f), "utf8")));
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
  /*- The specific shape that went wrong: iterate a set of tokenIds,
   *  scan each one. Every such loop must derive its floor per NFT. */
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
