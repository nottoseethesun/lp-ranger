/**
 * @file test/nonce-manager-wrapper.test.js
 * @description Unit tests for src/nonce-manager-wrapper.js.
 *
 * Covers:
 *   - lazy `_sync()` rebinds when the active RPC URL changes
 *   - `sendTransaction` succeeds without failover on success
 *   - transient error → `failoverToNextRPC` + retry once on fallback
 *   - terminal error (nonce-consumed) bubbles up without failover
 *   - no retry when failover would no-op (already on fallback / same URL)
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const sendTx = require("../src/send-transaction");
const {
  FailoverNonceManager,
  createFailoverSigner,
} = require("../src/nonce-manager-wrapper");

/*- Stand-in NonceManager: records its constructed provider URL so
    tests can assert which RPC the inner NM is currently bound to. */
class StubNonceManager {
  constructor(wallet) {
    this.signer = wallet;
    this.provider = wallet.provider;
    this._url = wallet.provider?._url ?? null;
    this._delta = 0;
    this._sendImpl = wallet._sendImpl ?? null;
  }
  reset() {
    this._delta = 0;
  }
  increment() {
    this._delta += 1;
  }
  async getAddress() {
    return this.signer.getAddress();
  }
  async getNonce() {
    return 0 + this._delta;
  }
  async populateTransaction(tx) {
    return { ...tx, gasLimit: tx.gasLimit ?? 100_000n };
  }
  async populateCall(tx) {
    return { ...tx };
  }
  async estimateGas() {
    return 100_000n;
  }
  async call(tx) {
    return tx.data ?? "0x";
  }
  async resolveName() {
    return null;
  }
  async signTransaction() {
    return "0xsigned";
  }
  async signMessage() {
    return "0xsig";
  }
  async signTypedData() {
    return "0xtyped";
  }
  async sendTransaction(tx) {
    if (typeof this._sendImpl === "function") {
      return this._sendImpl(tx, this);
    }
    return { hash: "0xhash", nonce: this._delta, ...tx };
  }
}

/*- Factory: ethers lib stub that build NonceManagers as StubNonceManager. */
function mockEthersLib(sendImpl) {
  return {
    NonceManager: class extends StubNonceManager {
      constructor(wallet) {
        super(wallet);
        if (sendImpl) this._sendImpl = sendImpl;
      }
    },
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.getFeeData = async () => ({ gasPrice: 1n });
      }
      send() {
        return Promise.resolve("0x1");
      }
    },
    FeeData: class {
      constructor(gp) {
        this.gasPrice = gp;
      }
    },
  };
}

/*- Stand-in Wallet: `connect(provider)` returns a clone with the new
    provider, plus carries the `_sendImpl` so the StubNonceManager built
    from this wallet inherits it. */
function makeWallet(sendImpl) {
  return {
    _sendImpl: sendImpl,
    provider: null,
    getAddress: async () => "0x000000000000000000000000000000000000abcd",
    connect(provider) {
      return { ...this, provider, connect: this.connect };
    },
  };
}

function muteConsole() {
  const orig = { warn: console.warn, error: console.error, log: console.log };
  console.warn = () => {};
  console.error = () => {};
  console.log = () => {};
  return () => Object.assign(console, orig);
}

function initSendTx(lib, urls) {
  sendTx.init(
    urls || {
      primary: "http://primary.test",
      fallback: "http://fallback.test",
    },
    lib,
  );
}

describe("nonce-manager-wrapper: factory and basic shape", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("createFailoverSigner returns a FailoverNonceManager", () => {
    initSendTx(mockEthersLib());
    const signer = createFailoverSigner(makeWallet(), {
      ethersLib: mockEthersLib(),
    });
    assert.ok(signer instanceof FailoverNonceManager);
  });

  it("getAddress reads the base wallet directly without touching the RPC", async () => {
    initSendTx(mockEthersLib());
    const signer = new FailoverNonceManager(makeWallet(), {
      ethersLib: mockEthersLib(),
    });
    const addr = await signer.getAddress();
    assert.equal(addr, "0x000000000000000000000000000000000000abcd");
  });

  it("connect() returns the same wrapper (provider is sourced from getCurrentRPC)", () => {
    initSendTx(mockEthersLib());
    const signer = new FailoverNonceManager(makeWallet(), {
      ethersLib: mockEthersLib(),
    });
    assert.equal(signer.connect({ some: "provider" }), signer);
  });
});

describe("nonce-manager-wrapper: lazy _sync and provider tracking", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("rebinds the inner NonceManager when the active RPC changes", () => {
    const lib = mockEthersLib();
    initSendTx(lib);
    const signer = new FailoverNonceManager(makeWallet(), { ethersLib: lib });

    /*- Before failover: inner NM bound to primary. */
    assert.equal(signer.provider._url, "http://primary.test");
    const innerBefore = signer._inner;

    /*- Engage failover; inner NM must rebind on next access. */
    const restore = muteConsole();
    try {
      sendTx.failoverToNextRPC();
    } finally {
      restore();
    }
    assert.equal(signer.provider._url, "http://fallback.test");
    assert.notEqual(signer._inner, innerBefore);
  });

  it(".signer getter returns the inner wallet for unwrap-style usage", () => {
    const lib = mockEthersLib();
    initSendTx(lib);
    const wallet = makeWallet();
    const signer = new FailoverNonceManager(wallet, { ethersLib: lib });
    /*- StubNonceManager stores the wallet under .signer, mirroring
        ethers.NonceManager.signer semantics. */
    assert.equal(typeof signer.signer.getAddress, "function");
  });
});

describe("nonce-manager-wrapper: sendTransaction with failover", () => {
  beforeEach(() => sendTx._resetForTests());
  afterEach(() => sendTx._resetForTests());

  it("succeeds without engaging failover when the primary works", async () => {
    let calls = 0;
    const lib = mockEthersLib(async (tx) => {
      calls += 1;
      return { hash: "0xok", nonce: 1, ...tx };
    });
    initSendTx(lib);
    const signer = new FailoverNonceManager(
      makeWallet(async (tx) => ({
        hash: "0xok",
        nonce: 1,
        ...tx,
      })),
      { ethersLib: lib },
    );
    const r = await signer.sendTransaction({ to: "0xdef", value: 0n });
    assert.equal(r.hash, "0xok");
    assert.equal(calls, 1);
    /*- No failover engaged. */
    assert.equal(sendTx.getCurrentRPC()._url, "http://primary.test");
  });

  it("retries on fallback once when the primary throws a transient error", async () => {
    /*- The transient classifier matches "server error" / -32603 etc.
        We craft an error that the existing classifier sees as transient. */
    let attempts = 0;
    const sendImpl = async (tx, nm) => {
      attempts += 1;
      if (nm._url === "http://primary.test") {
        const e = new Error("primary RPC server error");
        e.code = "SERVER_ERROR";
        throw e;
      }
      return { hash: "0xfallback", nonce: 1, ...tx };
    };
    const lib = mockEthersLib(sendImpl);
    initSendTx(lib);
    const wallet = makeWallet(sendImpl);
    const signer = new FailoverNonceManager(wallet, { ethersLib: lib });

    const restore = muteConsole();
    try {
      const r = await signer.sendTransaction({ to: "0xdef", value: 0n });
      assert.equal(r.hash, "0xfallback");
    } finally {
      restore();
    }
    assert.equal(attempts, 2);
    /*- Active RPC must now be the fallback (sticky window engaged). */
    assert.equal(sendTx.getCurrentRPC()._url, "http://fallback.test");
  });

  it("does not retry on terminal-nonce-consumed errors", async () => {
    let attempts = 0;
    const sendImpl = async () => {
      attempts += 1;
      const e = new Error("nonce too low");
      e.code = "NONCE_EXPIRED";
      throw e;
    };
    const lib = mockEthersLib(sendImpl);
    initSendTx(lib);
    const signer = new FailoverNonceManager(makeWallet(sendImpl), {
      ethersLib: lib,
    });

    const restore = muteConsole();
    try {
      await assert.rejects(
        () => signer.sendTransaction({ to: "0xdef" }),
        /nonce too low/,
      );
    } finally {
      restore();
    }
    assert.equal(attempts, 1);
    /*- Failover must NOT have been engaged for a terminal error. */
    assert.equal(sendTx.getCurrentRPC()._url, "http://primary.test");
  });

  it("does not retry when primary === fallback (no alternate to try)", async () => {
    let attempts = 0;
    const sendImpl = async () => {
      attempts += 1;
      const e = new Error("server error");
      e.code = "SERVER_ERROR";
      throw e;
    };
    const lib = mockEthersLib(sendImpl);
    initSendTx(lib, {
      primary: "http://only.test",
      fallback: "http://only.test",
    });
    const signer = new FailoverNonceManager(makeWallet(sendImpl), {
      ethersLib: lib,
    });

    const restore = muteConsole();
    try {
      await assert.rejects(
        () => signer.sendTransaction({ to: "0xdef" }),
        /server error/,
      );
    } finally {
      restore();
    }
    /*- Exactly one attempt — no retry, since failover would be a no-op. */
    assert.equal(attempts, 1);
  });

  it("does not retry when already on the fallback (would loop on the same RPC)", async () => {
    let primaryAttempts = 0;
    let fallbackAttempts = 0;
    const sendImpl = async (_tx, nm) => {
      if (nm._url === "http://primary.test") {
        primaryAttempts += 1;
      } else {
        fallbackAttempts += 1;
      }
      const e = new Error("server error");
      e.code = "SERVER_ERROR";
      throw e;
    };
    const lib = mockEthersLib(sendImpl);
    initSendTx(lib);
    const signer = new FailoverNonceManager(makeWallet(sendImpl), {
      ethersLib: lib,
    });

    /*- Engage failover up-front so getCurrentRPC returns fallback. */
    const restore = muteConsole();
    try {
      sendTx.failoverToNextRPC();
      assert.equal(sendTx.getCurrentRPC()._url, "http://fallback.test");
      await assert.rejects(
        () => signer.sendTransaction({ to: "0xdef" }),
        /server error/,
      );
    } finally {
      restore();
    }
    /*- Fallback was tried once; primary was NOT consulted. */
    assert.equal(fallbackAttempts, 1);
    assert.equal(primaryAttempts, 0);
  });
});
