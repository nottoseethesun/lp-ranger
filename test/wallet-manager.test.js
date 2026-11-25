"use strict";

/**
 * @file test/wallet-manager.test.js
 * @description Tests for the server-side wallet manager
 * (src/lib/wallet-manager.js): the import, the reveal and the clear, the
 * all-or-nothing save through wallet.json.tmp, and the wallet recovered
 * from that temp file when wallet.json is missing, empty or damaged.
 *
 * The wallet file is in a temp folder of this process's own, named
 * before the manager is required, so no test touches the operator's
 * wallet.json.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");

const WALLET_FILE = path.join(makeTestTempFolder("wallet"), "wallet.json");
const TMP_FILE = `${WALLET_FILE}.tmp`;
process.env.WALLET_FILE_PATH = WALLET_FILE;

const {
  importWallet,
  revealWallet,
  getStatus,
  clearWallet,
  getAddress,
  hasWallet,
  _reloadFromDiskForTests,
} = require("../src/lib/wallet-manager");

const SAMPLE = {
  address: "0xAbCdEf0000000000000000000000000000000001",
  privateKey: "0x" + "ab".repeat(32),
  mnemonic:
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  source: "seed",
  password: "test-password-123",
};

describe("wallet-manager", () => {
  beforeEach(() => clearWallet());
  afterEach(() => {
    for (const file of [WALLET_FILE, TMP_FILE])
      fs.rmSync(file, { recursive: true, force: true });
  });

  it("starts with no wallet loaded", () => {
    assert.strictEqual(hasWallet(), false);
    assert.strictEqual(getAddress(), null);
    const st = getStatus();
    assert.strictEqual(st.loaded, false);
    assert.strictEqual(st.address, null);
    assert.strictEqual(st.source, null);
    assert.strictEqual(st.hasMnemonic, false);
    assert.strictEqual(typeof st.fileExists, "boolean");
  });

  it("importWallet stores address and status", async () => {
    await importWallet(SAMPLE);
    assert.strictEqual(hasWallet(), true);
    assert.strictEqual(getAddress(), SAMPLE.address);
    const s = getStatus();
    assert.strictEqual(s.loaded, true);
    assert.strictEqual(s.source, "seed");
    assert.strictEqual(s.hasMnemonic, true);
  });

  it("revealWallet returns secrets with correct password", async () => {
    await importWallet(SAMPLE);
    const secrets = await revealWallet(SAMPLE.password);
    assert.strictEqual(secrets.privateKey, SAMPLE.privateKey);
    assert.strictEqual(secrets.mnemonic, SAMPLE.mnemonic);
  });

  it("revealWallet throws with wrong password", async () => {
    await importWallet(SAMPLE);
    await assert.rejects(() => revealWallet("wrong-password"), {
      message: "Wrong password",
    });
  });

  it("revealWallet throws when no wallet loaded", async () => {
    await assert.rejects(() => revealWallet("any"), {
      message: "No wallet loaded",
    });
  });

  it("clearWallet removes all state", async () => {
    await importWallet(SAMPLE);
    clearWallet();
    assert.strictEqual(hasWallet(), false);
    assert.strictEqual(getAddress(), null);
  });

  it("importWallet without mnemonic sets hasMnemonic=false", async () => {
    await importWallet({ ...SAMPLE, mnemonic: null });
    const s = getStatus();
    assert.strictEqual(s.hasMnemonic, false);
    const secrets = await revealWallet(SAMPLE.password);
    assert.strictEqual(secrets.mnemonic, null);
  });

  it("importWallet rejects missing password", async () => {
    await assert.rejects(() => importWallet({ ...SAMPLE, password: "" }), {
      message: /Password is required/,
    });
  });

  it("importWallet rejects missing privateKey", async () => {
    await assert.rejects(() => importWallet({ ...SAMPLE, privateKey: "" }), {
      message: /Private key is required/,
    });
  });

  it("importWallet rejects missing address", async () => {
    await assert.rejects(() => importWallet({ ...SAMPLE, address: "" }), {
      message: /Address is required/,
    });
  });

  it("re-import replaces previous wallet", async () => {
    await importWallet(SAMPLE);
    const newAddr = "0x1111111111111111111111111111111111111111";
    await importWallet({
      ...SAMPLE,
      address: newAddr,
      password: "new-pw",
    });
    assert.strictEqual(getAddress(), newAddr);
    const secrets = await revealWallet("new-pw");
    assert.strictEqual(secrets.privateKey, SAMPLE.privateKey);
  });

  // ── Persistence tests ──────────────────────────────────────────────────

  it("importWallet writes wallet.json to disk", async () => {
    await importWallet(SAMPLE);
    assert.ok(
      fs.existsSync(WALLET_FILE),
      "wallet.json should exist after import",
    );
    const raw = JSON.parse(fs.readFileSync(WALLET_FILE, "utf8"));
    assert.strictEqual(raw.address, SAMPLE.address);
    assert.ok(raw.encrypted, "encrypted blob should be present");
    assert.ok(raw.encrypted.ciphertextHex, "ciphertext should be present");
    // Plaintext private key must NOT appear in the file
    const fileContents = fs.readFileSync(WALLET_FILE, "utf8");
    assert.ok(
      !fileContents.includes(SAMPLE.privateKey.slice(2)),
      "plaintext private key must not appear in wallet.json",
    );
  });

  it("clearWallet removes wallet.json from disk", async () => {
    await importWallet(SAMPLE);
    assert.ok(fs.existsSync(WALLET_FILE));
    clearWallet();
    assert.ok(
      !fs.existsSync(WALLET_FILE),
      "wallet.json should be deleted after clear",
    );
  });

  it("clearWallet does not throw if wallet.json does not exist", () => {
    assert.doesNotThrow(() => clearWallet());
  });

  it("an import whose save fails leaves the wallet file and the loaded wallet as they were", async () => {
    /*-
     *  The bot keeps signing with the loaded wallet's key when an import
     *  fails, so the loaded wallet must stay the one that key belongs to,
     *  and so must the file the next start reads. A folder where the temp
     *  file goes makes the save's first write fail, as a full disk would.
     */
    await importWallet(SAMPLE);
    const before = fs.readFileSync(WALLET_FILE, "utf8");
    fs.mkdirSync(TMP_FILE);
    await assert.rejects(
      importWallet({
        ...SAMPLE,
        address: "0x1111111111111111111111111111111111111111",
        privateKey: "0x" + "cd".repeat(32),
        password: "new-pw",
      }),
      /EISDIR/,
    );
    assert.strictEqual(fs.readFileSync(WALLET_FILE, "utf8"), before);
    assert.strictEqual(getAddress(), SAMPLE.address);
    const secrets = await revealWallet(SAMPLE.password);
    assert.strictEqual(secrets.privateKey, SAMPLE.privateKey);
  });

  it("a save goes through the temp file, which does not stay", async () => {
    await importWallet(SAMPLE);
    assert.strictEqual(fs.existsSync(TMP_FILE), false);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(WALLET_FILE, "utf8")).address,
      SAMPLE.address,
    );
  });

  it("clearWallet removes the temp file too", async () => {
    await importWallet(SAMPLE);
    fs.copyFileSync(WALLET_FILE, TMP_FILE);
    clearWallet();
    assert.strictEqual(fs.existsSync(WALLET_FILE), false);
    assert.strictEqual(fs.existsSync(TMP_FILE), false);
  });
});

describe("wallet-manager, a fresh start", () => {
  /*-
   *  What the next start reads, after a crash or a faulty file system
   *  left the files as each case sets them: the manager forgets its
   *  wallet and reads the folder again, as it does when it loads.
   */
  beforeEach(() => clearWallet());
  afterEach(() => {
    for (const file of [WALLET_FILE, TMP_FILE])
      fs.rmSync(file, { recursive: true, force: true });
  });

  /** Import SAMPLE, and copy its saved file to where a save writes first. */
  async function savedWithCopy() {
    await importWallet(SAMPLE);
    fs.copyFileSync(WALLET_FILE, TMP_FILE);
  }

  /** The loaded wallet is SAMPLE, back in wallet.json, and no temp file stays. */
  async function assertSampleLoaded() {
    assert.strictEqual(getAddress(), SAMPLE.address);
    const secrets = await revealWallet(SAMPLE.password);
    assert.strictEqual(secrets.privateKey, SAMPLE.privateKey);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(WALLET_FILE, "utf8")).address,
      SAMPLE.address,
    );
    assert.strictEqual(fs.existsSync(TMP_FILE), false);
  }

  it("recovers the wallet from the temp file when wallet.json is empty", async () => {
    await savedWithCopy();
    fs.writeFileSync(WALLET_FILE, "");
    _reloadFromDiskForTests();
    await assertSampleLoaded();
  });

  it("recovers the wallet from the temp file when wallet.json is missing", async () => {
    await savedWithCopy();
    fs.unlinkSync(WALLET_FILE);
    _reloadFromDiskForTests();
    await assertSampleLoaded();
  });

  it("recovers the wallet from the temp file when wallet.json is damaged", async () => {
    await savedWithCopy();
    fs.writeFileSync(WALLET_FILE, '{ "address": "0xAbC');
    _reloadFromDiskForTests();
    await assertSampleLoaded();
  });

  it("keeps a good wallet.json, and removes a temp file a save cut short left", async () => {
    await importWallet(SAMPLE);
    fs.writeFileSync(
      TMP_FILE,
      JSON.stringify({
        address: "0x1111111111111111111111111111111111111111",
        encrypted: { saltHex: "00" },
      }),
    );
    _reloadFromDiskForTests();
    await assertSampleLoaded();
  });

  it("starts with no wallet when neither file holds one", async () => {
    fs.writeFileSync(WALLET_FILE, "");
    fs.writeFileSync(TMP_FILE, "{ not a wallet");
    _reloadFromDiskForTests();
    assert.strictEqual(hasWallet(), false);
    assert.strictEqual(fs.existsSync(TMP_FILE), false);
  });
});
