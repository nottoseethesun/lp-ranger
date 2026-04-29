/**
 * @file test/lifetime-hodl-wrap.test.js
 * @description Tests for native-token wrap detection inside the lifetime HODL
 * fresh-deposit classifier.  EVM LPs only accept the wrapped form of the
 * native token (PLS→wPLS, ETH→wETH).  When a user wraps inside a swap or
 * rebalance multicall, the wPLS arrival looks identical to an LP return; the
 * heuristic implemented in `_sumNonSwapInbound` recognises a wrap by matching
 * `tx.value` (native sent by wallet) to a wrapped-token Transfer-IN of equal
 * amount in the same TX.  Tests live in their own file to keep the main
 * `lifetime-hodl.test.js` under the 500-line limit.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeLifetimeHodl } = require("../src/lifetime-hodl");

const TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function _topicsMatch(lt, ft) {
  if (!ft) return true;
  return ft.every((f, i) => f === null || lt[i] === f);
}

function mockProvider(opts = {}) {
  const logs = opts.logs || [];
  const txs = opts.txs || {};
  return {
    getLogs(filter) {
      return Promise.resolve(
        logs.filter(
          (l) =>
            l.address === filter.address &&
            l.blockNumber >= filter.fromBlock &&
            l.blockNumber <= filter.toBlock &&
            _topicsMatch(l.topics, filter.topics),
        ),
      );
    },
    getTransaction(hash) {
      return Promise.resolve(txs[hash] || null);
    },
  };
}

function mockEthers() {
  return {
    zeroPadValue(addr, _len) {
      return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
    },
    id(_s) {
      return TOPIC0;
    },
  };
}

function ilEvent(a0, a1, block = 100) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}
function colEvent(a0, a1, block = 200) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}
function dlEvent(liq, block = 150, a0 = 0, a1 = 0) {
  return {
    amount0: BigInt(a0),
    amount1: BigInt(a1),
    liquidity: BigInt(liq),
    blockNumber: block,
    txHash: "0x" + block.toString(16),
  };
}

function twoNftFixture(drain0, drain1, mint0, mint1) {
  const events = new Map();
  events.set("50", {
    ilEvents: [ilEvent(1000_00000000, 2000_00000000, 10)],
    collectEvents: [colEvent(drain0, drain1, 200)],
    dlEvents: [dlEvent(1000, 150)],
  });
  events.set("100", {
    ilEvents: [ilEvent(mint0, mint1, 210)],
    collectEvents: [],
    dlEvents: [],
  });
  return {
    events,
    rebalanceEvents: [{ oldTokenId: "50", newTokenId: "100" }],
  };
}

const pos8 = { tokenId: "100", decimals0: 8, decimals1: 8 };
const W = "0xWallet";
const T0 = "0xToken0";
const T1 = "0xToken1";

function hexAmount(amt) {
  return "0x" + BigInt(amt).toString(16).padStart(64, "0");
}

describe("lifetime-hodl native-wrap detection", () => {
  it("credits tx.value when it matches a wrapped-token IN amount in the same TX", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const wpls = e.zeroPadValue("0xWplsContract", 32);
    /*- Wallet wraps 400 raw PLS → exactly 400 raw wPLS in tx 0xwrap1.
        tx.from === wallet, tx.value === wrapped IN amount → wrap detected,
        400 credited as fresh wrapped-side capital. */
    const wrapIn = {
      address: T1,
      topics: [TOPIC0, wpls, wPad],
      data: hexAmount(400_00000000),
      blockNumber: 205,
      transactionHash: "0xwrap1",
    };
    const prov = mockProvider({
      logs: [wrapIn],
      txs: { "0xwrap1": { from: W, value: 400_00000000n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      1000_00000000,
      2400_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T1,
    });
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2400);
  });

  it("credits a wrap inside a TX that would otherwise classify as a swap", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const rPad = e.zeroPadValue("0xRouter", 32);
    /*- Realistic shape: wallet sends token0 out (looks like swap) AND
        receives wrapped token1 with amount === tx.value.  Without wrap
        detection the TX is skipped as a swap; with detection the wrap
        amount is credited to fresh wrapped-side capital. */
    const swapOut = {
      address: T0,
      topics: [TOPIC0, wPad, rPad],
      data: hexAmount(100_00000000),
      blockNumber: 205,
      transactionHash: "0xwrapinswap",
    };
    const wrapIn = {
      address: T1,
      topics: [TOPIC0, rPad, wPad],
      data: hexAmount(250_00000000),
      blockNumber: 205,
      transactionHash: "0xwrapinswap",
    };
    const prov = mockProvider({
      logs: [swapOut, wrapIn],
      txs: { "0xwrapinswap": { from: W, value: 250_00000000n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      900_00000000,
      2250_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T1,
    });
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2250);
  });

  it("wrap branch is disabled when wrappedNativeAddress is not provided", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const rPad = e.zeroPadValue("0xRouter", 32);
    /*- Same swap-shaped TX as the prior test, but without wrappedNativeAddress.
        The wrap branch never runs, the TX is classified as a swap, and the
        wPLS-IN is NOT credited. */
    const swapOut = {
      address: T0,
      topics: [TOPIC0, wPad, rPad],
      data: hexAmount(100_00000000),
      blockNumber: 205,
      transactionHash: "0xwrapinswap2",
    };
    const wrapIn = {
      address: T1,
      topics: [TOPIC0, rPad, wPad],
      data: hexAmount(250_00000000),
      blockNumber: 205,
      transactionHash: "0xwrapinswap2",
    };
    const prov = mockProvider({
      logs: [swapOut, wrapIn],
      txs: { "0xwrapinswap2": { from: W, value: 250_00000000n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      900_00000000,
      2250_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
    });
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2000);
  });

  it("does not fire when tx.from is not the wallet", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const wpls = e.zeroPadValue("0xWplsContract", 32);
    /*- Wrapped-token IN amount === tx.value, but the TX was signed by a
        different EOA (relayer / refund / etc.).  The wallet did not spend
        native PLS, so this should NOT be credited as a wrap. */
    const wrapIn = {
      address: T1,
      topics: [TOPIC0, wpls, wPad],
      data: hexAmount(400_00000000),
      blockNumber: 205,
      transactionHash: "0xrelayed",
    };
    const prov = mockProvider({
      logs: [wrapIn],
      txs: { "0xrelayed": { from: "0xRelayer", value: 400_00000000n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      1000_00000000,
      2400_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T1,
    });
    /*- Wrap not credited; the standard non-swap inbound path still credits
        the 400 token1-IN as a regular deposit. */
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2400);
  });

  it("credits a gasless wrap up to 1% short on the wrapped side", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const wpls = e.zeroPadValue("0xWplsContract", 32);
    /*- Wallet sends 400 native PLS, receives 396 wPLS — gas drawn from the
        wrapped side (1% short).  Within tolerance ⇒ wrap detected, the
        actual wrapped amount (396) is credited (gas delta is not capital). */
    const wrapIn = {
      address: T1,
      topics: [TOPIC0, wpls, wPad],
      data: hexAmount(396_00000000),
      blockNumber: 205,
      transactionHash: "0xgasless1",
    };
    const prov = mockProvider({
      logs: [wrapIn],
      txs: { "0xgasless1": { from: W, value: 400_00000000n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      1000_00000000,
      2396_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T1,
    });
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2396);
  });

  it("does NOT credit a wrap that's more than 1% short on the wrapped side", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const rPad = e.zeroPadValue("0xRouter", 32);
    /*- Wallet sends 400 native PLS, receives only 380 wPLS (5% short) in a
        swap-shaped TX.  Outside tolerance ⇒ wrap NOT detected, and the
        swap-pattern branch skips the TX.  No fresh wrapped credited. */
    const swapOut = {
      address: T0,
      topics: [TOPIC0, wPad, rPad],
      data: hexAmount(50_00000000),
      blockNumber: 205,
      transactionHash: "0xtoolossy",
    };
    const wrapIn = {
      address: T1,
      topics: [TOPIC0, rPad, wPad],
      data: hexAmount(380_00000000),
      blockNumber: 205,
      transactionHash: "0xtoolossy",
    };
    const prov = mockProvider({
      logs: [swapOut, wrapIn],
      txs: { "0xtoolossy": { from: W, value: 400_00000000n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      950_00000000,
      2380_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T1,
    });
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2000);
  });

  it("does NOT credit a wrap when wrapped received exceeds native sent", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const wpls = e.zeroPadValue("0xWplsContract", 32);
    /*- Wallet sends 400 native PLS but receives 410 wPLS — implausible for a
        true wrap (wraps are at most 1:1).  This is more likely an LP return
        plus a small wrap, or some other artifact.  Heuristic must NOT fire
        here, lest it credit non-wrap inflows. */
    const xferIn = {
      address: T1,
      topics: [TOPIC0, wpls, wPad],
      data: hexAmount(410_00000000),
      blockNumber: 205,
      transactionHash: "0xover",
    };
    const prov = mockProvider({
      logs: [xferIn],
      txs: { "0xover": { from: W, value: 400_00000000n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      1000_00000000,
      2410_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T1,
    });
    /*- Wrap branch declines (410 > 400).  Standard non-swap inbound path
        still credits the 410 transfer as a regular deposit. */
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2410);
  });

  it("picks the largest wrapped-IN within tolerance when multiple match", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const wpls = e.zeroPadValue("0xWplsContract", 32);
    const rPad = e.zeroPadValue("0xRouter", 32);
    /*- Two wrapped-IN events in one TX: 397 (likely wrap) and 100 (likely
        an LP-return / fee refund).  tx.value = 400.  Both pass the upper
        bound (≤ 400) but only 397 passes the lower bound (≥ 396).  The
        heuristic credits 397 (the wrap), not 100. */
    const wrapIn = {
      address: T1,
      topics: [TOPIC0, wpls, wPad],
      data: hexAmount(397_00000000),
      blockNumber: 205,
      transactionHash: "0xtwoin",
    };
    const otherIn = {
      address: T1,
      topics: [TOPIC0, rPad, wPad],
      data: hexAmount(100_00000000),
      blockNumber: 205,
      transactionHash: "0xtwoin",
    };
    const prov = mockProvider({
      logs: [wrapIn, otherIn],
      txs: { "0xtwoin": { from: W, value: 400_00000000n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      1000_00000000,
      2397_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T1,
    });
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2397);
  });

  it("does not fire when tx.value is zero", async () => {
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const rPad = e.zeroPadValue("0xRouter", 32);
    /*- Swap-shaped TX from wallet, tx.value === 0n: heuristic must NOT
        misclassify a plain swap as a wrap.  Result: TX is skipped as a
        swap and nothing is credited. */
    const swapOut = {
      address: T0,
      topics: [TOPIC0, wPad, rPad],
      data: hexAmount(100_00000000),
      blockNumber: 205,
      transactionHash: "0xplainswap",
    };
    const swapIn = {
      address: T1,
      topics: [TOPIC0, rPad, wPad],
      data: hexAmount(250_00000000),
      blockNumber: 205,
      transactionHash: "0xplainswap",
    };
    const prov = mockProvider({
      logs: [swapOut, swapIn],
      txs: { "0xplainswap": { from: W, value: 0n } },
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      900_00000000,
      2250_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T1,
    });
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2000);
  });
});
