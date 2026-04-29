/**
 * @file eslint.config.js
 * @description ESLint v10 flat configuration for the 9mm v3 position manager.
 *
 * Key custom rules beyond ESLint's recommended defaults:
 *   - complexity ≤ 17  (cyclomatic complexity per function)
 *   - max-lines ≤ 500  (non-comment, non-blank lines of code per file)
 *   - no-restricted-syntax: disallow window property assignments
 *
 * All other rules come from ESLint's built-in "recommended" preset, which
 * flags the most common bugs (unused vars, no-undef, etc.) without enforcing
 * opinionated style choices.
 *
 * @see {@link https://eslint.org/docs/latest/use/configure/configuration-files}
 */

"use strict";

const js = require("@eslint/js");
const globals = require("globals");
const prettierConfig = require("eslint-config-prettier");
const securityPlugin = require("eslint-plugin-security");
const nPlugin = require("eslint-plugin-n");

/** Shared quality rules applied to all linted files. */
const SHARED_RULES = {
  ...js.configs.recommended.rules,

  complexity: ["error", { max: 17 }],
  "max-len": [
    "error",
    {
      code: 80,
      ignoreUrls: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreRegExpLiterals: true,
      ignoreComments: true,
    },
  ],
  "max-lines": [
    "error",
    { max: 500, skipBlankLines: true, skipComments: true },
  ],
  "no-var": "error",
  "prefer-const": ["error", { destructuring: "all" }],
  eqeqeq: ["error", "always"],
  strict: ["error", "global"],
  "no-extend-native": "error",

  "no-unused-vars": [
    "error",
    {
      vars: "all",
      args: "after-used",
      argsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
    },
  ],

  "no-warning-comments": [
    "error",
    {
      terms: ["prettier-ignore"],
      location: "anywhere",
    },
  ],

  "no-restricted-syntax": [
    "error",
    {
      selector:
        'AssignmentExpression > MemberExpression.left[object.name="window"]',
      message:
        "Do not assign to window — use module.exports or top-level declarations.",
    },
    {
      selector:
        'CallExpression[callee.object.name="Math"][callee.property.name="random"]',
      message:
        "Use crypto.randomBytes() instead of Math.random() — not cryptographically secure.",
    },
  ],
};

module.exports = [
  // ── 1. Files to lint ────────────────────────────────────────────────────────
  {
    files: [
      "src/**/*.js",
      "test/**/*.js",
      "scripts/**/*.js",
      "util/**/*.js",
      "server.js",
      "bot.js",
      "public/dashboard-*.js",
      "public/ethers-adapter.js",
      "eslint-rules/**/*.js",
    ],
  },

  // ── 2. Files to ignore entirely ─────────────────────────────────────────────
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "public/index.html",
      "public/dist/**",
      "*.min.js",
    ],
  },

  // ── 3. Source files — Node.js environment ───────────────────────────────────
  {
    files: [
      "src/**/*.js",
      "scripts/**/*.js",
      "util/**/*.js",
      "server.js",
      "bot.js",
      "eslint-rules/**/*.js",
    ],
    ignores: ["util/**/test/**/*.js"],
    plugins: {
      "9mm": {
        rules: {
          "no-separate-contract-calls": require("./eslint-rules/no-separate-contract-calls"),
          "no-secret-logging": require("./eslint-rules/no-secret-logging"),
          "no-number-from-bigint": require("./eslint-rules/no-number-from-bigint"),
          "no-interpolated-innerhtml": require("./eslint-rules/no-interpolated-innerhtml"),
        },
      },
      security: securityPlugin,
      n: nPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.browser, // ui-state.js uses document with typeof guards
        module: "writable",
        require: "readonly",
        process: "readonly",
      },
    },
    linterOptions: {
      // Security rules are off in main lint but on in security lint.
      // Per-line eslint-disable directives suppress them in security lint;
      // here they appear "unused" so we suppress that warning.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      ...SHARED_RULES,
      "no-console": ["warn", { allow: ["log", "warn", "error", "info"] }],
      "9mm/no-separate-contract-calls": [
        "error",
        {
          pairs: [["decreaseLiquidity", "collect"]],
        },
      ],
      "9mm/no-interpolated-innerhtml": "error",
      // Forbid lazy `require()` inside functions / blocks. Top-of-file
      // `require()` only — see project_esm_migration memory for rationale.
      "n/global-require": "error",
      // Security rules registered off — enforced by security lint only.
      // Registered here so per-line disable directives are recognized.
      "9mm/no-secret-logging": "off",
      "9mm/no-number-from-bigint": "off",
      "security/detect-unsafe-regex": "off",
      "security/detect-possible-timing-attacks": "off",
    },
  },

  // ── 4. Dashboard files — browser ES modules ───────────────────────────────
  {
    files: ["public/dashboard-*.js", "public/ethers-adapter.js"],
    plugins: {
      "9mm": {
        rules: {
          "no-fetch-without-csrf": require("./eslint-rules/no-fetch-without-csrf"),
          "no-interpolated-innerhtml": require("./eslint-rules/no-interpolated-innerhtml"),
        },
      },
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      ...SHARED_RULES,
      strict: "off",
      "no-console": [
        "warn",
        { allow: ["log", "warn", "error", "info", "debug"] },
      ],
      "9mm/no-fetch-without-csrf": "error",
      "9mm/no-interpolated-innerhtml": "error",
    },
  },

  // ── 5. Test files — relax a few rules that don't apply in tests ──────────
  {
    files: ["test/**/*.js", "util/**/test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ethers: "readonly",
        module: "writable",
        require: "readonly",
        process: "readonly",
      },
    },
    rules: {
      ...SHARED_RULES,
      "no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-console": "off",
      // Tests use Math.random() for fuzz testing — not security-sensitive.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'AssignmentExpression > MemberExpression.left[object.name="window"]',
          message:
            "Do not assign to window — use module.exports or top-level declarations.",
        },
      ],
    },
  },

  // ── 6. Prettier — disable conflicting formatting rules ──────────────────
  prettierConfig,
];
