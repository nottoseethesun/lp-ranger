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

'use strict';

const js      = require('@eslint/js');
const globals = require('globals');

/** Shared quality rules applied to all linted files. */
const SHARED_RULES = {
  ...js.configs.recommended.rules,

  'complexity': ['error', { max: 17 }],
  'max-lines':  ['error', { max: 500, skipBlankLines: true, skipComments: true }],
  'no-var':     'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'eqeqeq':    ['error', 'always'],
  'strict':    ['error', 'global'],

  'no-unused-vars': ['error', {
    vars:               'all',
    args:               'after-used',
    argsIgnorePattern:  '^_',
    caughtErrors:       'all',
    caughtErrorsIgnorePattern: '^_',
  }],

  /** Disallow assigning to window properties (use module.exports or top-level declarations). */
  'no-restricted-syntax': ['error', {
    selector: 'AssignmentExpression > MemberExpression.left[object.name="window"]',
    message:  'Do not assign to window — use module.exports or top-level declarations.',
  }],
};

module.exports = [
  // ── 1. Files to lint ────────────────────────────────────────────────────────
  {
    files: ['src/**/*.js', 'test/**/*.js', 'server.js', 'bot.js', 'public/dashboard-*.js'],
  },

  // ── 2. Files to ignore entirely ─────────────────────────────────────────────
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'public/index.html',
      '*.min.js',
    ],
  },

  // ── 3. Source files — Node.js environment ───────────────────────────────────
  {
    files: ['src/**/*.js', 'server.js', 'bot.js'],
    languageOptions: {
      ecmaVersion:   2022,
      sourceType:    'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,  // ui-state.js uses document with typeof guards
        module:  'writable',
        require: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      ...SHARED_RULES,
      'no-console': ['warn', { allow: ['log', 'warn', 'error', 'info'] }],
    },
  },

  // ── 4. Dashboard files — browser environment ──────────────────────────────
  //
  // Cross-file dependencies are declared via /* global */ comments in each
  // file rather than in languageOptions.globals, to avoid no-redeclare
  // conflicts with the file that defines them.
  {
    files: ['public/dashboard-*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'script',
      globals: {
        ...globals.browser,
        ethers: 'readonly',
      },
    },
    rules: {
      ...SHARED_RULES,
      'no-console': ['warn', { allow: ['log', 'warn', 'error', 'info'] }],

      // Top-level functions are exported via global scope (called from HTML
      // onclick handlers or other dashboard scripts). Only flag unused vars
      // inside functions, not at the top level.
      'no-unused-vars': ['error', {
        vars:               'local',
        args:               'after-used',
        argsIgnorePattern:  '^_',
        caughtErrors:       'all',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  // ── 5. Test files — relax a few rules that don't apply in tests ──────────
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'commonjs',
      globals: {
        ...globals.node,
        ethers:  'readonly',
        module:  'writable',
        require: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      ...SHARED_RULES,
      'no-unused-vars': ['error', {
        vars:               'all',
        args:               'after-used',
        argsIgnorePattern:  '^_',
        varsIgnorePattern:  '^_',
        caughtErrors:       'none',
      }],
      'no-console': 'off',
    },
  },
];
