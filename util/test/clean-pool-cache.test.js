/**
 * @file util/test/clean-pool-cache.test.js
 * @description
 * Unit tests for the pure `filterPositionsForPool` helper exported by
 * `util/cache/clean-pool-cache.js`. The helper drives the surgical
 * removal of one pool's entries from a wallet-scoped lp-position-cache
 * file (other pools' entries in the same file are preserved).
 *
 * The helper is the new logic added by the
 * `improve-pool-pair-cache-clean-tool` change; the surrounding fs IO
 * (file globbing, write/unlink) is straight-line code that wraps this
 * filter and is exercised manually via the CLI.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { filterPositionsForPool } = require("../cache/clean-pool-cache");

const POS_HEX_HEX_2500_A = {
  tokenId: "156966",
  token0: "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39",
  token1: "0x57fde0a71132198BBeC939B98976993d8D89D225",
  fee: 2500,
  liquidity: "0",
};
const POS_HEX_HEX_2500_B = {
  tokenId: "156978",
  token0: "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39",
  token1: "0x57fde0a71132198BBeC939B98976993d8D89D225",
  fee: 2500,
  liquidity: "0",
};
const POS_HEX_HEX_3000 = {
  // Same tokens, different fee tier — must be preserved.
  tokenId: "200001",
  token0: "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39",
  token1: "0x57fde0a71132198BBeC939B98976993d8D89D225",
  fee: 3000,
  liquidity: "12345",
};
const POS_OTHER_PAIR = {
  // Different pair entirely — must be preserved.
  tokenId: "200002",
  token0: "0xA1077a294dDE1B09bB078844df40758a5D0f9a27",
  token1: "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab",
  fee: 2500,
  liquidity: "67890",
};

test("filterPositionsForPool removes only entries matching token0+token1+fee", () => {
  const positions = [
    POS_HEX_HEX_2500_A,
    POS_HEX_HEX_2500_B,
    POS_HEX_HEX_3000,
    POS_OTHER_PAIR,
  ];
  const { kept, removed } = filterPositionsForPool(positions, {
    token0: POS_HEX_HEX_2500_A.token0,
    token1: POS_HEX_HEX_2500_A.token1,
    fee: 2500,
  });
  assert.equal(removed.length, 2, "two HEX/HEX@2500 entries removed");
  assert.deepEqual(
    removed.map((p) => p.tokenId),
    ["156966", "156978"],
  );
  assert.equal(kept.length, 2, "different-fee + different-pair preserved");
  assert.deepEqual(kept.map((p) => p.tokenId).sort(), ["200001", "200002"]);
});

test("filterPositionsForPool is case-insensitive on token addresses", () => {
  const positions = [POS_HEX_HEX_2500_A];
  const { removed } = filterPositionsForPool(positions, {
    token0: POS_HEX_HEX_2500_A.token0.toLowerCase(),
    token1: POS_HEX_HEX_2500_A.token1.toUpperCase(),
    fee: 2500,
  });
  assert.equal(removed.length, 1);
});

test("filterPositionsForPool treats fee as numeric (string vs number)", () => {
  const positions = [POS_HEX_HEX_2500_A];
  const { removed } = filterPositionsForPool(positions, {
    token0: POS_HEX_HEX_2500_A.token0,
    token1: POS_HEX_HEX_2500_A.token1,
    fee: "2500", // string scope, numeric fee in cache
  });
  assert.equal(removed.length, 1);
});

test("filterPositionsForPool preserves order of kept entries", () => {
  const positions = [
    POS_OTHER_PAIR,
    POS_HEX_HEX_2500_A,
    POS_HEX_HEX_3000,
    POS_HEX_HEX_2500_B,
  ];
  const { kept } = filterPositionsForPool(positions, {
    token0: POS_HEX_HEX_2500_A.token0,
    token1: POS_HEX_HEX_2500_A.token1,
    fee: 2500,
  });
  assert.deepEqual(
    kept.map((p) => p.tokenId),
    ["200002", "200001"],
  );
});

test("filterPositionsForPool with no matches returns full array as kept", () => {
  const positions = [POS_HEX_HEX_3000, POS_OTHER_PAIR];
  const { kept, removed } = filterPositionsForPool(positions, {
    token0: "0x0000000000000000000000000000000000000000",
    token1: "0x1111111111111111111111111111111111111111",
    fee: 500,
  });
  assert.equal(removed.length, 0);
  assert.equal(kept.length, 2);
});

test("filterPositionsForPool tolerates empty/missing positions array", () => {
  assert.deepEqual(
    filterPositionsForPool([], { token0: "0x", token1: "0x", fee: 0 }),
    { kept: [], removed: [] },
  );
  assert.deepEqual(
    filterPositionsForPool(undefined, { token0: "0x", token1: "0x", fee: 0 }),
    { kept: [], removed: [] },
  );
});

test("filterPositionsForPool does NOT match pair-reversed positions", () => {
  // token0 + token1 are pool-ordered; if a cache entry has them
  // swapped (different pool), it must NOT be removed by this scope.
  const reversed = {
    ...POS_HEX_HEX_2500_A,
    tokenId: "999",
    token0: POS_HEX_HEX_2500_A.token1,
    token1: POS_HEX_HEX_2500_A.token0,
  };
  const { kept, removed } = filterPositionsForPool([reversed], {
    token0: POS_HEX_HEX_2500_A.token0,
    token1: POS_HEX_HEX_2500_A.token1,
    fee: 2500,
  });
  assert.equal(removed.length, 0);
  assert.equal(kept.length, 1);
});
