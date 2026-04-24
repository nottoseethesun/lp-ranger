/**
 * @file test/position-manager-shared-signer.test.js
 * @description Tests for `createPositionManager().getSharedSigner()` —
 * the app-wide NonceManager singleton that fixes the 2026-04-24 nonce
 * storm. Split from position-manager.test.js to keep both files under
 * the 500-line ESLint limit.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPositionManager } = require("../src/position-manager");
const { createRebalanceLock } = require("../src/rebalance-lock");

/** Build a position-manager with sensible defaults. */
function makeMgr(overrides) {
  return createPositionManager({
    rebalanceLock: createRebalanceLock(),
    dailyMax: 20,
    ...overrides,
  });
}

/*- Minimal ethers stub — JsonRpcProvider, Wallet, NonceManager.
 *  The point is to verify memoisation and identity; we don't need
 *  real cryptography. */
function mockEthersLib() {
  let walletCount = 0;
  let nmCount = 0;
  function JsonRpcProvider() {
    this.getBlockNumber = async () => 1;
    this.getFeeData = async () => ({ gasPrice: 1n });
    this.send = async () => "0x1";
  }
  function Wallet(pk, provider) {
    walletCount++;
    this.privateKey = pk;
    this.provider = provider;
    this.address = "0xDEADBEEF";
    this.connect = (p) => {
      this.provider = p;
      return this;
    };
  }
  Wallet.createRandom = () => new Wallet("0xrandom", null);
  function NonceManager(base) {
    nmCount++;
    this.signer = base;
    this.getAddress = async () => base.address;
    this.reset = () => {};
  }
  return {
    JsonRpcProvider,
    Wallet,
    NonceManager,
    get _walletCount() {
      return walletCount;
    },
    get _nmCount() {
      return nmCount;
    },
  };
}

describe("position-manager getSharedSigner()", () => {
  it("memoises {provider, signer, address} after the first call", async () => {
    const mgr = makeMgr();
    const lib = mockEthersLib();
    const first = await mgr.getSharedSigner({
      privateKey: "0xabc",
      ethersLib: lib,
    });
    const second = await mgr.getSharedSigner({
      privateKey: "0xabc",
      ethersLib: lib,
    });
    assert.strictEqual(first.provider, second.provider);
    assert.strictEqual(first.signer, second.signer);
    assert.strictEqual(first.address, second.address);
    assert.strictEqual(
      lib._nmCount,
      1,
      "NonceManager must be constructed exactly once per mgr",
    );
    assert.strictEqual(lib._walletCount, 1, "Wallet constructed exactly once");
  });

  it("serialises concurrent callers to the same instance", async () => {
    const mgr = makeMgr();
    const lib = mockEthersLib();
    const [a, b, c] = await Promise.all([
      mgr.getSharedSigner({ privateKey: "0xabc", ethersLib: lib }),
      mgr.getSharedSigner({ privateKey: "0xabc", ethersLib: lib }),
      mgr.getSharedSigner({ privateKey: "0xabc", ethersLib: lib }),
    ]);
    assert.strictEqual(a.signer, b.signer);
    assert.strictEqual(b.signer, c.signer);
    assert.strictEqual(
      lib._nmCount,
      1,
      "parallel callers must share one NonceManager",
    );
  });

  it("uses a random wallet when dryRun && no privateKey", async () => {
    const mgr = makeMgr();
    const lib = mockEthersLib();
    const shared = await mgr.getSharedSigner({
      privateKey: null,
      ethersLib: lib,
      dryRun: true,
    });
    assert.ok(shared.signer);
    assert.strictEqual(shared.address, "0xDEADBEEF");
  });

  it("_resetSharedSigner() clears the cache so next call rebuilds", async () => {
    const mgr = makeMgr();
    const lib = mockEthersLib();
    await mgr.getSharedSigner({ privateKey: "0xabc", ethersLib: lib });
    mgr._resetSharedSigner();
    await mgr.getSharedSigner({ privateKey: "0xabc", ethersLib: lib });
    assert.strictEqual(
      lib._nmCount,
      2,
      "after reset, a new NonceManager must be created",
    );
  });

  it("rebuilds after a failed first attempt (no poisoned cache)", async () => {
    const mgr = makeMgr();
    /*- Both primary and fallback fail until firstRoundDone is tripped. */
    let firstRoundDone = false;
    let providerCalls = 0;
    const lib = {
      JsonRpcProvider: function () {
        providerCalls++;
        this.getBlockNumber = async () => {
          if (!firstRoundDone) throw new Error("rpc down");
          return 1;
        };
        this.getFeeData = async () => ({ gasPrice: 1n });
        this.send = async () => "0x1";
      },
      Wallet: function (pk, provider) {
        this.provider = provider;
        this.address = "0xAA";
        this.connect = (p) => {
          this.provider = p;
          return this;
        };
      },
      NonceManager: function (base) {
        this.signer = base;
        this.getAddress = async () => base.address;
        this.reset = () => {};
      },
    };
    lib.Wallet.createRandom = () => new lib.Wallet("0xr", null);
    await assert.rejects(
      () => mgr.getSharedSigner({ privateKey: "0xabc", ethersLib: lib }),
      /rpc down/,
    );
    firstRoundDone = true;
    const shared = await mgr.getSharedSigner({
      privateKey: "0xabc",
      ethersLib: lib,
    });
    assert.strictEqual(shared.address, "0xAA");
    assert.ok(
      providerCalls >= 3,
      "first failure used 2 providers, second call builds a new one",
    );
  });
});
