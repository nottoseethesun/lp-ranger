/**
 * @file eslint-security.config.js
 * @description Security-focused ESLint config (separate from main lint).
 * Run via: npm run audit:security
 *
 * Uses eslint-plugin-security for vulnerability patterns and
 * eslint-plugin-no-secrets for entropy-based secret detection.
 */

"use strict";

const security = require("eslint-plugin-security");
const noSecrets = require("eslint-plugin-no-secrets");
const noSecretLogging = require("./eslint-rules/no-secret-logging");
const noNumberFromBigint = require("./eslint-rules/no-number-from-bigint");

module.exports = [
  {
    files: ["src/**/*.js", "scripts/**/*.js", "server.js", "bot.js"],
    plugins: {
      security,
      "no-secrets": noSecrets,
      "9mm": {
        rules: {
          "no-secret-logging": noSecretLogging,
          "no-number-from-bigint": noNumberFromBigint,
        },
      },
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
    },
    rules: {
      // ── eslint-plugin-security ──────────────────
      "security/detect-unsafe-regex": "warn",
      "security/detect-non-literal-regexp": "warn",
      // Every fs call in this app uses computed paths (path.join(__dirname,
      // CONSTANT), os.tmpdir(), config-scoped filenames). The rule flags ALL
      // of them (~90 warnings) because it can't distinguish path.join(cwd,
      // CONSTANT) from path.join(cwd, userInput). No user input ever reaches
      // any filesystem path — all paths come from __dirname-relative constants
      // or server-owned config. Suppressing 90 lines with eslint-disable
      // would be noisier than the rule itself.
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-eval-with-expression": "warn",
      "security/detect-no-csrf-before-method-override": "warn",
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-child-process": "warn",
      "security/detect-new-buffer": "warn",
      "security/detect-disable-mustache-escape": "warn",
      "security/detect-non-literal-require": "warn",
      "security/detect-object-injection": "off",

      // ── eslint-plugin-no-secrets ────────────────
      // Entropy-based detection of high-entropy strings
      // that look like secrets (API keys, private keys).
      "no-secrets/no-secrets": [
        "warn",
        {
          tolerance: 4.5,
          additionalDelimiters: ["0x"],
        },
      ],

      // ── Custom EVM safety rules ─────────────────
      "9mm/no-secret-logging": "warn",
      "9mm/no-number-from-bigint": "warn",
    },
  },
];
