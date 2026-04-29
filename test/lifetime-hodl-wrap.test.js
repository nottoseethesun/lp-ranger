/**
 * @file test/lifetime-hodl-wrap.test.js
 * @description Tests for native-token wrap detection inside the lifetime HODL
 * fresh-deposit classifier.  EVM LPs only accept the wrapped form of the
 * native token (PLS→wPLS, ETH→wETH).  A wrap may not emit a Transfer event
 * at all (PulseChain WPLS emits only `Deposit(dst, wad)` on `deposit()`),
 * and even when it does the wPLS arrival looks identical to an LP return.
 * The classifier scans `Deposit(wallet, wad)` events on the wrapped-native
 * contract and credits the exact `wad` to the wrapped side.  Tests live in
 * their own file to keep `lifetime-hodl.test.js` under the 500-line limit.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { computeLifetimeHodl } = require("../src/lifetime-hodl");

const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEPOSIT_TOPIC0 =
  "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

function _topicsMatch(lt, ft) {
  if (!ft) return true;
  return ft.every((f, i) => f === null || lt[i] === f);
}

function mockProvider(opts = {}) {
  const logs = opts.logs || [];
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
  };
}

function mockEthers() {
  return {
    zeroPadValue(addr, _len) {
      return "0x" + addr.toLowerCase().replace("0x", "").padStart(64, "0");
    },
    id(sig) {
      return sig === "Deposit(address,uint256)"
        ? DEPOSIT_TOPIC0
        : TRANSFER_TOPIC0;
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

function depositLog(wpls, wallet, amount, txHash, block = 205) {
  const wPad = "0x" + wallet.toLowerCase().replace("0x", "").padStart(64, "0");
  return {
    address: wpls,
    topics: [DEPOSIT_TOPIC0, wPad],
    data: hexAmount(amount),
    blockNumber: block,
    transactionHash: txHash,
  };
}

describe("lifetime-hodl native-wrap detection (Deposit event)", () => {
  it("credits a wrap-only TX (no Transfer event, only Deposit)", async () => {
    /*- The defining PulseChain WPLS case: `deposit()` emits Deposit but
        NOT Transfer-from-zero.  The TX has zero token1 Transfer events.
        The Deposit-event scan must still credit `wad` to the wrapped side. */
    const e = mockEthers();
    const prov = mockProvider({
      logs: [depositLog(T1, W, 400_00000000, "0xwraponly")],
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

  it("credits a wrap inside a swap-shaped TX (Deposit + Transfer present)", async () => {
    /*- Wrap bundled with a swap: token0 OUT to router, token1 IN from
        router (looks like a swap), AND a Deposit event credits the wrap
        amount.  The Deposit short-circuits the standard classifier so the
        wrap amount is credited (and not double-counted with the Transfer-IN). */
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const rPad = e.zeroPadValue("0xRouter", 32);
    const swapOut = {
      address: T0,
      topics: [TRANSFER_TOPIC0, wPad, rPad],
      data: hexAmount(100_00000000),
      blockNumber: 205,
      transactionHash: "0xwrapinswap",
    };
    const wrapInTransfer = {
      address: T1,
      topics: [TRANSFER_TOPIC0, rPad, wPad],
      data: hexAmount(250_00000000),
      blockNumber: 205,
      transactionHash: "0xwrapinswap",
    };
    const prov = mockProvider({
      logs: [
        swapOut,
        wrapInTransfer,
        depositLog(T1, W, 250_00000000, "0xwrapinswap"),
      ],
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
    /*- Same swap-shaped TX, but no wrappedNativeAddress.  The Deposit-event
        scan never runs; the standard classifier sees a swap pattern (one
        out, other in) and skips the TX → nothing credited on the wrapped side. */
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const rPad = e.zeroPadValue("0xRouter", 32);
    const swapOut = {
      address: T0,
      topics: [TRANSFER_TOPIC0, wPad, rPad],
      data: hexAmount(100_00000000),
      blockNumber: 205,
      transactionHash: "0xnoaddr",
    };
    const swapIn = {
      address: T1,
      topics: [TRANSFER_TOPIC0, rPad, wPad],
      data: hexAmount(250_00000000),
      blockNumber: 205,
      transactionHash: "0xnoaddr",
    };
    const prov = mockProvider({
      logs: [swapOut, swapIn, depositLog(T1, W, 250_00000000, "0xnoaddr")],
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

  it("does NOT fire when the Deposit event credits a different address", async () => {
    /*- Deposit event topic1 ≠ wallet (e.g. a relayer wraps for itself).
        getLogs filter restricts topic1 to wallet, so the scan returns
        empty and the wrap branch never fires. */
    const e = mockEthers();
    const otherPad = e.zeroPadValue("0xOther", 32);
    const wrapForOther = {
      address: T1,
      topics: [DEPOSIT_TOPIC0, otherPad],
      data: hexAmount(400_00000000),
      blockNumber: 205,
      transactionHash: "0xrelayed",
    };
    const prov = mockProvider({ logs: [wrapForOther] });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      1000_00000000,
      2000_00000000,
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

  it("sums multiple Deposit events in the same TX", async () => {
    /*- A multicall could wrap twice inside one TX (rare but legal).  The
        scan map sums the wads under one txHash key. */
    const e = mockEthers();
    const prov = mockProvider({
      logs: [
        depositLog(T1, W, 100_00000000, "0xtwowrap"),
        depositLog(T1, W, 300_00000000, "0xtwowrap"),
      ],
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

  it("credits wrap on token0 side when token0 is the wrapped native", async () => {
    /*- wrappedTokenIdx = 0 path: pool's token0 is the wrapped native.  The
        Deposit `wad` must land on sum0, not sum1. */
    const e = mockEthers();
    const prov = mockProvider({
      logs: [depositLog(T0, W, 500_00000000, "0xwrap0")],
    });
    const { events, rebalanceEvents } = twoNftFixture(
      1000_00000000,
      2000_00000000,
      1500_00000000,
      2000_00000000,
    );
    const r = await computeLifetimeHodl(events, {
      rebalanceEvents,
      position: { ...pos8, token0: T0, token1: T1 },
      provider: prov,
      ethersLib: e,
      walletAddress: W,
      wrappedNativeAddress: T0,
    });
    assert.strictEqual(r.amount0, 1500);
    assert.strictEqual(r.amount1, 2000);
  });

  it("does not double-count when Deposit and Transfer-IN both appear", async () => {
    /*- Mainnet WETH9 emits both Transfer(0x0,dst,wad) and Deposit(dst,wad).
        We must credit only the Deposit `wad`, not the Deposit + the Transfer
        treated as a normal deposit.  Otherwise the wrap would be counted twice. */
    const e = mockEthers();
    const wPad = e.zeroPadValue(W, 32);
    const zeroPad = e.zeroPadValue("0x0", 32);
    const xferFromZero = {
      address: T1,
      topics: [TRANSFER_TOPIC0, zeroPad, wPad],
      data: hexAmount(400_00000000),
      blockNumber: 205,
      transactionHash: "0xboth",
    };
    const prov = mockProvider({
      logs: [xferFromZero, depositLog(T1, W, 400_00000000, "0xboth")],
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
    /*- 400 credited from the Deposit event, NOT 400+400.  The Transfer-IN
        for this TX is short-circuited (we `continue` after the wrap branch). */
    assert.strictEqual(r.amount0, 1000);
    assert.strictEqual(r.amount1, 2400);
  });
});
