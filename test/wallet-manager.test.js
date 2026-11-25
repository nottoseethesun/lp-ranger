"use strict";

/**
 * @file test/wallet-manager.test.js
 * @description Tests for the server-side wallet manager
 * (src/lib/wallet-manager.js): the import, the reveal and the clear, the
 * all-or-nothing save through wallet.json.tmp, and the wallet recovered
 * from that temp file when wallet.json is missing, empty or damaged.
 *
 * The wallet file is in a temp folder of this process's own, named in
 * `WALLET_FILE_PATH`, so no test touches the operator's wallet.json; and
 * where the manager saves the wallet with none named, under `node --test`
 * and outside it, asked in child processes.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const { spawnSync } = require("child_process");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { _setSinkForTests } = require("../src/lib/log");

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
  settleWalletFile,
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

  it("leaves no temp file behind after a save", async () => {
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
   *  What the next start finds, after a crash or a faulty file system
   *  left the files as each case sets them. Loading reads only: the
   *  manager forgets its wallet and reads the folder again, as it does
   *  when it loads, and the files stay as they are. The start step of a
   *  program that owns the wallet (`settleWalletFile`) then puts them
   *  right.
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

  /** Both files as they stand: each one's text, or null when it is absent. */
  const filesNow = () =>
    [WALLET_FILE, TMP_FILE].map((f) =>
      fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null,
    );

  /** Load as this module does, and assert the files are as they were. */
  function loadReadingOnly() {
    const before = filesNow();
    _reloadFromDiskForTests();
    assert.deepStrictEqual(filesNow(), before, "loading wrote nothing");
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

  it("reads the wallet from the copy when wallet.json is empty, and the start puts it back", async () => {
    await savedWithCopy();
    fs.writeFileSync(WALLET_FILE, "");
    loadReadingOnly();
    assert.strictEqual(getAddress(), SAMPLE.address);
    settleWalletFile();
    await assertSampleLoaded();
  });

  it("reads the wallet from the copy when wallet.json is missing, and the start puts it back", async () => {
    await savedWithCopy();
    fs.unlinkSync(WALLET_FILE);
    loadReadingOnly();
    assert.strictEqual(getAddress(), SAMPLE.address);
    settleWalletFile();
    await assertSampleLoaded();
  });

  it("reads the wallet from the copy when wallet.json is damaged, and the start puts it back", async () => {
    await savedWithCopy();
    fs.writeFileSync(WALLET_FILE, '{ "address": "0xAbC');
    loadReadingOnly();
    assert.strictEqual(getAddress(), SAMPLE.address);
    settleWalletFile();
    await assertSampleLoaded();
  });

  it("keeps a good wallet.json, and the start removes a copy a save cut short left", async () => {
    await importWallet(SAMPLE);
    fs.writeFileSync(
      TMP_FILE,
      JSON.stringify({
        address: "0x1111111111111111111111111111111111111111",
        encrypted: { saltHex: "00" },
      }),
    );
    loadReadingOnly();
    settleWalletFile();
    await assertSampleLoaded();
  });

  it("starts with no wallet when neither file holds one, and the start removes the copy", () => {
    fs.writeFileSync(WALLET_FILE, "");
    fs.writeFileSync(TMP_FILE, "{ not a wallet");
    loadReadingOnly();
    assert.strictEqual(hasWallet(), false);
    settleWalletFile();
    assert.strictEqual(fs.existsSync(TMP_FILE), false);
  });

  it("leaves the files alone at a start with no copy", async () => {
    await importWallet(SAMPLE);
    const before = filesNow();
    settleWalletFile();
    assert.deepStrictEqual(filesNow(), before);
  });

  it("warns at the start when it cannot remove a leftover copy, never claiming it did", async () => {
    await importWallet(SAMPLE);
    fs.mkdirSync(TMP_FILE);
    const said = [];
    // The log module's seam for its output, put back in the `finally`.
    const restoreLog = _setSinkForTests({
      log: (...args) => said.push(util.format(...args)),
      warn: (...args) => said.push(util.format(...args)),
    });
    try {
      settleWalletFile();
    } finally {
      restoreLog();
    }
    assert.ok(said.some((s) => s.includes("Could not remove wallet.json.tmp")));
    assert.ok(!said.some((s) => s.includes("Removed wallet.json.tmp")));
  });
});

describe("wallet-manager, the file mode", () => {
  /*-
   *  A save replaces wallet.json with its copy, which a rename makes the
   *  file; the copy is given wallet.json's mode first, so a mode the
   *  operator set (`chmod 600`, say) stays.
   */
  beforeEach(() => clearWallet());
  afterEach(() => {
    for (const file of [WALLET_FILE, TMP_FILE])
      fs.rmSync(file, { recursive: true, force: true });
  });

  const modeOf = (file) => fs.statSync(file).mode & 0o777;

  it("keeps the mode the operator gave wallet.json across a save", async () => {
    await importWallet(SAMPLE);
    fs.chmodSync(WALLET_FILE, 0o600);
    await importWallet({ ...SAMPLE, password: "another-password" });
    assert.strictEqual(modeOf(WALLET_FILE).toString(8), "600");
  });

  it("keeps the broken wallet.json's mode when the start puts the copy back", async () => {
    await importWallet(SAMPLE);
    fs.copyFileSync(WALLET_FILE, TMP_FILE);
    fs.chmodSync(TMP_FILE, 0o644);
    fs.writeFileSync(WALLET_FILE, "");
    fs.chmodSync(WALLET_FILE, 0o600);
    _reloadFromDiskForTests();
    settleWalletFile();
    assert.strictEqual(modeOf(WALLET_FILE).toString(8), "600");
    assert.strictEqual(getAddress(), SAMPLE.address);
  });
});

describe("a program that only loads the wallet module", () => {
  /*-
   *  As a util tool that loads src/lib/config.js does. It reads the
   *  wallet, from the copy when wallet.json is broken, and touches
   *  neither file: only a program that owns the wallet puts the files
   *  right, as it starts. Run in a child process, from a folder of its
   *  own, over files in a temp folder.
   */

  /**
   * Load src/lib/config.js in a child process over a wallet file and its
   * copy holding `wallet` and `copy` (text, or null for no file); answer
   * whether it found a wallet, and both files' text afterwards.
   * @param {string|null} wallet
   * @param {string|null} copy
   * @returns {{found: boolean, after: (string|null)[]}}
   */
  function loadInChild(wallet, copy) {
    const dir = makeTestTempFolder("wallet-load");
    const file = path.join(dir, "wallet.json");
    if (wallet !== null) fs.writeFileSync(file, wallet);
    if (copy !== null) fs.writeFileSync(`${file}.tmp`, copy);
    const lib = (name) =>
      JSON.stringify(path.join(__dirname, "..", "src", "lib", name));
    const res = spawnSync(
      process.execPath,
      [
        "-e",
        `require(${lib("config")});
         const found = require(${lib("wallet-manager")}).hasWallet();
         process.stdout.write("\\nFOUND=" + found);`,
      ],
      {
        cwd: makeTestTempFolder("wallet-load-cwd"),
        env: { ...process.env, WALLET_FILE_PATH: file },
        encoding: "utf8",
      },
    );
    assert.strictEqual(res.status, 0, res.stderr);
    const after = [file, `${file}.tmp`].map((f) =>
      fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null,
    );
    return { found: /\nFOUND=true$/.test(res.stdout), after };
  }

  /** A saved wallet file's text, made here so the cases need no import. */
  const SAVED = JSON.stringify({
    address: SAMPLE.address,
    source: "key",
    hasMnemonic: false,
    encrypted: { saltHex: "00", ivHex: "00", authTagHex: "00" },
  });

  it("reads the wallet from the copy without putting it back", () => {
    const { found, after } = loadInChild("", SAVED);
    assert.strictEqual(found, true);
    assert.deepStrictEqual(after, ["", SAVED]);
  });

  it("leaves a copy beside a good wallet.json where it is", () => {
    const { found, after } = loadInChild(SAVED, SAVED);
    assert.strictEqual(found, true);
    assert.deepStrictEqual(after, [SAVED, SAVED]);
  });
});

/**
 * Where the wallet manager saves the wallet, asked in a child process run
 * from an empty folder of its own, so the install's wallet is never read:
 * with the test runner's marker unless `asInstall`, and `WALLET_FILE_PATH`
 * set to `named`, or unset.
 * @param {{asInstall?: boolean, named?: string}} [opts]
 * @returns {{file: string, cwd: string, pid: string}}
 */
function walletFileInChild({ asInstall = false, named } = {}) {
  const src = JSON.stringify(
    path.join(__dirname, "..", "src", "lib", "wallet-manager"),
  );
  const cwd = makeTestTempFolder("wallet-cwd");
  const env = { ...process.env };
  delete env.WALLET_FILE_PATH;
  if (asInstall) delete env.NODE_TEST_CONTEXT;
  if (named !== undefined) env.WALLET_FILE_PATH = named;
  const res = spawnSync(
    process.execPath,
    [
      "-e",
      `process.stdout.write("\\nFILE=" + require(${src}).walletFilePath() + "\\nPID=" + process.pid)`,
    ],
    { cwd, env, encoding: "utf8" },
  );
  assert.strictEqual(res.status, 0, res.stderr);
  const [, file, pid] = res.stdout.match(/\nFILE=(.*)\nPID=(\d+)$/);
  return { file, cwd, pid };
}

describe("where the wallet is saved", () => {
  it("is a temp folder of the test process's own under node --test", () => {
    const { file, pid } = walletFileInChild();
    const dir = path.dirname(file);
    assert.strictEqual(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith(`lp-ranger-test-wallet-${pid}-`));
    assert.strictEqual(path.basename(file), "wallet.json");
  });

  it("is app-config/user-configurable/wallet.json outside tests", () => {
    const { file, cwd } = walletFileInChild({ asInstall: true });
    assert.strictEqual(
      file,
      path.join(cwd, "app-config", "user-configurable", "wallet.json"),
    );
  });

  it("is the file WALLET_FILE_PATH names, when it names one", () => {
    const named = path.join(os.tmpdir(), "somewhere-else", "wallet.json");
    assert.strictEqual(walletFileInChild({ named }).file, named);
  });

  it("takes a blank WALLET_FILE_PATH as naming none, as readEnv does", () => {
    const { file, pid } = walletFileInChild({ named: "   " });
    assert.ok(file.includes(`lp-ranger-test-wallet-${pid}-`), file);
  });
});
