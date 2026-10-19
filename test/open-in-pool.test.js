"use strict";

/**
 * @file test/open-in-pool.test.js
 * @description Whether the wallet holds an open position in a pool,
 *   other than the one being re-opened (src/open-in-pool.js).
 *
 *   The candidates are the positions the last wallet scan saw open in the
 *   pool. The scan can be old, so the chain is asked about each, and only
 *   its answer overturns the scan's: a read that fails leaves the
 *   candidate open. Driven with the scan cache and the chain stood in for.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { openInPool } = require("../src/open-in-pool");
const { createPositionManager } = require("../src/position-manager");
const { captureWarnings } = require("./helpers/capture-warnings");
const {
  contractReverted,
  endpointFailedRead,
} = require("./helpers/ethers-rpc-errors");

const A = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const B = "0x57fde0a71132198BBeC939B98976993d8D89D225";
const C = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab";
const WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const SOMEONE = "0x1111111111111111111111111111111111111111";
const POOL = { token0: A, token1: B, fee: 2500 };

const _pm = createPositionManager({ rebalanceLock: null });
const poolKeyFn = (t0, t1, fee) =>
  _pm.poolKey("pulsechain", "0xCC05", WALLET, t0, t1, fee);

/**
 * Ask about the pool for position #999, with the scan holding `scanned`
 * and the chain answering from `chain`: token id → `{ liquidity, owner }`,
 * or `{ fails }`, the error every read about it throws.
 * @returns {Promise<{answer: string|null, asked: string[]}>}  `asked`
 *   lists the positions the chain was asked about.
 */
async function ask(scanned, chain) {
  const asked = [];
  const answer = await openInPool({
    wallet: WALLET,
    pool: POOL,
    tokenId: "999",
    poolKeyFn,
    provider: {},
    ethersLib: {
      Contract: class {
        async positions(id) {
          asked.push(String(id));
          const c = chain[String(id)];
          if (c.fails !== undefined) throw c.fails;
          return { ...POOL, liquidity: c.liquidity };
        }
        async ownerOf(id) {
          const c = chain[String(id)];
          if (c.fails !== undefined) throw c.fails;
          return c.owner;
        }
      },
    },
    positionManager: "0xCC05",
    blockchain: "pulsechain",
    loadCache: () =>
      scanned === null ? null : { positions: scanned, lastBlock: 1 },
  });
  return { answer, asked };
}

/** A scanned position in POOL, or in `pool`. */
const scannedAt = (tokenId, liquidity, pool = POOL) => ({
  tokenId,
  ...pool,
  liquidity,
});

describe("an open position in the pool", () => {
  it("is found when the scan saw it open and the chain still shows it open in the wallet", async () => {
    const { answer } = await ask([scannedAt("111", "5000")], {
      111: { liquidity: 5000n, owner: WALLET },
    });
    assert.equal(answer, "111");
  });

  it("counts no longer once the chain shows it closed", async () => {
    const { answer } = await ask([scannedAt("111", "5000")], {
      111: { liquidity: 0n, owner: WALLET },
    });
    assert.equal(answer, null);
  });

  it("counts no longer once it has left the wallet", async () => {
    const { answer } = await ask([scannedAt("111", "5000")], {
      111: { liquidity: 5000n, owner: SOMEONE },
    });
    assert.equal(answer, null);
  });

  it("counts no longer once it has been burned", async () => {
    // The contract reverts when asked about an NFT that no longer exists.
    const reverted = contractReverted(
      "ERC721: owner query for nonexistent token",
    );
    const { answer } = await ask([scannedAt("111", "5000")], {
      111: { fails: reverted },
    });
    assert.equal(answer, null);
  });

  it("still counts when an endpoint answers who owns it with an error", async () => {
    /*-
     *  ethers labels an endpoint's error answer to a contract read as it
     *  labels the contract's revert. Only the revert says the NFT is
     *  gone, so this leaves the scan's answer standing.
     */
    const warned = captureWarnings();
    let answer;
    try {
      ({ answer } = await ask([scannedAt("111", "5000")], {
        111: { fails: endpointFailedRead("rate limit exceeded") },
      }));
    } finally {
      warned.restore();
    }
    assert.equal(answer, "111");
    assert.match(warned.lines.join("\n"), /who owns NFT #111 /);
  });

  it("still counts when the chain cannot be read", async () => {
    /*-
     *  Only an answer from the chain overturns the scan's. Counted as
     *  gone, an open position the chain could not be asked about would
     *  let a re-open put a second open position in its pool.
     */
    const warned = captureWarnings();
    let answer;
    try {
      ({ answer } = await ask([scannedAt("111", "5000")], {
        111: { fails: new Error("could not reach the endpoint") },
      }));
    } finally {
      warned.restore();
    }
    assert.equal(answer, "111");
    // Each failed read is logged, with the chain's own error.
    const log = warned.lines.join("\n");
    assert.match(log, /pool of NFT #111 .* could not reach the endpoint/);
    assert.match(log, /who owns NFT #111 .* could not reach the endpoint/);
  });

  it("is not looked for among the positions the scan saw closed", async () => {
    const { answer, asked } = await ask([scannedAt("111", "0")], {
      111: { liquidity: 5000n, owner: WALLET },
    });
    assert.equal(answer, null);
    assert.deepEqual(asked, [], "the chain is not asked about it");
  });

  it("is not the position being re-opened", async () => {
    const { answer } = await ask([scannedAt("999", "5000")], {
      999: { liquidity: 5000n, owner: WALLET },
    });
    assert.equal(answer, null);
  });

  it("is not one in another pool", async () => {
    const other = { token0: A, token1: C, fee: 2500 };
    const { answer } = await ask([scannedAt("111", "5000", other)], {
      111: { liquidity: 5000n, owner: WALLET },
    });
    assert.equal(answer, null);
  });

  it("is unknown with no scan", async () => {
    const { answer } = await ask(null, {});
    assert.equal(answer, null);
  });
});
