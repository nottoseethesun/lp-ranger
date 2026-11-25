/**
 * @file scripts/reset-wallet.js
 * @description Reset the dashboard-imported wallet.
 *
 * Two actions, both idempotent:
 *   1. Delete app-config/user-configurable/wallet.json (encrypted wallet
 *      state), and wallet.json.tmp beside it, the copy a save writes
 *      first, from which the app would recover the wallet.
 *   2. Scrub any WALLET_PASSWORD=... line from .env so the next restart
 *      re-prompts via the dashboard unlock dialog rather than auto-
 *      unlocking from a stale plaintext password.
 *
 * Safe to run when either target is already absent.
 *
 * See docs/engineering.md > Security > Authentication & Key Management
 * > Encryption at Rest for why the WALLET_PASSWORD env-var fallback
 * exists and the trade-off it represents.
 */

"use strict";

const { log } = require("../src/lib/log");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WALLET_FILE = path.join(
  ROOT,
  "app-config",
  "user-configurable",
  "wallet.json",
);
const ENV_FILE = path.join(ROOT, ".env");

// ── 1. Delete the encrypted wallet file ───────────────────────────────────
if (fs.existsSync(WALLET_FILE)) {
  fs.unlinkSync(WALLET_FILE);
  log.info("✔ Deleted app-config/user-configurable/wallet.json");
} else {
  log.info("• app-config/user-configurable/wallet.json already absent");
}
/*-
 *  And the copy a save writes first, which the app would otherwise
 *  recover the wallet from at its next start (src/lib/wallet-manager.js).
 */
fs.rmSync(`${WALLET_FILE}.tmp`, { force: true });

// ── 2. Scrub WALLET_PASSWORD from .env ────────────────────────────────────
if (fs.existsSync(ENV_FILE)) {
  const original = fs.readFileSync(ENV_FILE, "utf8");
  const lines = original.split("\n");
  const kept = lines.filter((line) => !/^WALLET_PASSWORD=/.test(line));
  const hadMatch = kept.length !== lines.length;

  if (hadMatch) {
    const tmpFile = ENV_FILE + ".tmp";
    fs.writeFileSync(tmpFile, kept.join("\n"));
    // Preserve file mode from the original.
    try {
      const stat = fs.statSync(ENV_FILE);
      fs.chmodSync(tmpFile, stat.mode);
    } catch {
      /* best-effort; rename proceeds regardless */
    }
    fs.renameSync(tmpFile, ENV_FILE);
    log.info("✔ Removed WALLET_PASSWORD from .env");
  } else {
    log.info("• WALLET_PASSWORD not present in .env");
  }
} else {
  log.info("• .env not present");
}

log.info("");
log.info(
  "Re-import your wallet via the dashboard unlock dialog on next start.",
);
