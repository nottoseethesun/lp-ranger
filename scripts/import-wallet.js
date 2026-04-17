/**
 * @file scripts/import-wallet.js
 * @description Import a wallet from the command line — no browser needed.
 *
 * Creates `app-config/.wallet.json` (the same encrypted file the
 * dashboard import flow produces) so headless deployments can use the
 * `WALLET_PASSWORD` env-var pathway without ever opening the dashboard.
 *
 * Usage:
 *   node scripts/import-wallet.js
 *     → interactive prompts for private key and password
 *
 *   echo "0xABC..." | node scripts/import-wallet.js --password mypass
 *     → reads private key from stdin, password from flag (scripted use)
 *
 * The result is identical to importing via the dashboard UI: an
 * AES-256-GCM encrypted `.wallet.json` that `WALLET_PASSWORD` can
 * unlock at startup.
 */

"use strict";

const readline = require("readline");
const { Wallet } = require("ethers");
const { migrateAppConfig } = require("../src/migrate-app-config");

// Ensure app-config/ exists before walletManager tries to write.
migrateAppConfig();

const walletManager = require("../src/wallet-manager");

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

const passwordFromFlag = flag("--password");

// ── Interactive prompts ──────────────────────────────────────────────────────

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY !== false,
  });
}

/** Prompt for a visible-text answer. */
function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

/** Read all of stdin as a single string (for piped input). */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8").trim()),
    );
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async function main() {
  if (walletManager.hasWallet()) {
    const status = walletManager.getStatus();
    console.error(
      "A wallet is already imported (address: %s).",
      status.address,
    );
    console.error(
      "Run `npm run reset-wallet` first if you want to replace it.",
    );
    process.exit(1);
  }

  let privateKey;
  let password;

  if (process.stdin.isTTY) {
    // Interactive — prompt for everything.
    const rl = createRl();
    console.error("Import a wallet into LP Ranger (encrypted at rest).\n");
    privateKey = await ask(rl, "Private key (0x-prefixed hex): ");
    password = await ask(rl, "Encryption password: ");
    const confirm = await ask(rl, "Confirm password: ");
    rl.close();
    // eslint-disable-next-line security/detect-possible-timing-attacks -- Safe: comparing two user-entered strings for confirmation, not verifying a secret
    if (password !== confirm) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
  } else {
    // Piped — read key from stdin, password from --password flag.
    privateKey = await readStdin();
    password = passwordFromFlag;
    if (!password) {
      console.error(
        "When piping the private key via stdin, " +
          "provide --password <password> on the command line.",
      );
      process.exit(1);
    }
  }

  if (!privateKey) {
    console.error("No private key provided.");
    process.exit(1);
  }

  // Normalize — add 0x prefix if missing.
  if (/^[0-9a-f]{64}$/i.test(privateKey)) {
    privateKey = "0x" + privateKey;
  }

  // Validate — must be a valid 32-byte hex key.
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) {
    console.error(
      "Invalid private key format. Expected 64 hex characters (with or without 0x prefix).",
    );
    process.exit(1);
  }

  // Derive the address via ethers.
  let address;
  try {
    const wallet = new Wallet(privateKey);
    address = wallet.address;
  } catch (err) {
    console.error("Failed to derive address from private key: %s", err.message);
    process.exit(1);
  }

  // Import — creates app-config/.wallet.json encrypted with AES-256-GCM.
  await walletManager.importWallet({
    address,
    privateKey,
    mnemonic: null,
    source: "key",
    password,
  });

  console.log("✔ Wallet imported: %s", address);
  console.log("  Encrypted at: app-config/.wallet.json");
  console.log("");
  console.log("To use with unattended startup, add to .env:");
  console.log('  WALLET_PASSWORD="%s"', password.replace(/"/g, '\\"'));
  console.log("");
  console.log("Or leave WALLET_PASSWORD unset and enter the password in the");
  console.log("dashboard unlock dialog on each restart (recommended).");
})();
