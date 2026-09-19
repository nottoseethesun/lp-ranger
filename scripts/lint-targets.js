/**
 * @file scripts/lint-targets.js
 * @description
 * Single source of truth for which JavaScript files the lint and format
 * gates apply to.
 *
 * Why this file exists:
 *   Four consumers need the same list — the `format` and `format:check`
 *   npm scripts, `scripts/check.js`, and the `lint-staged` config the
 *   pre-commit hook runs.  Spelled out separately they drift, and the
 *   drift is invisible: a hook that formats a wider set than the gate
 *   checks writes formatting on commit that no command verifies, and
 *   the gate stays green either way.
 *
 *   Everything that needs the list now imports it from here, and the
 *   pre-commit hook runs `npm run lint` rather than defining its own
 *   parallel set of checks.
 *
 * Keep in lockstep with the ESLint invocation in the `lint` npm script:
 * a file that ESLint checks but Prettier does not (or vice versa) is
 * the drift this file exists to prevent.  `test/eslint-rules/` and
 * `util/diagnostic/test/` are covered by the `test/**` and `util/**`
 * globs respectively.
 */

"use strict";

/**
 * Prettier-style globs for every JS file under lint/format gates.
 * Order matches the ESLint target list in the `lint` npm script.
 * @type {string[]}
 */
const JS_TARGETS = [
  "src/**/*.js",
  "test/**/*.js",
  "scripts/**/*.js",
  "util/**/*.js",
  "server.js",
  "bot.js",
  "public/dashboard-*.js",
  "eslint-rules/**/*.js",
  "stylelint-rules/**/*.js",
];

/**
 * Targets for the security ESLint pass (`eslint-security.config.js`).
 *
 * Deliberately narrower than JS_TARGETS: it covers shipped runtime and
 * operator tooling, not test fixtures or browser code.  Directory form,
 * because that is what the security config's own `files` globs expect.
 *
 * `util/` belongs here — these tools read operator config and hit RPC
 * endpoints, so they are exactly the code the security rules exist for.
 * Omitting it costs roughly 23 files of coverage, and the pass still
 * reports success on the ones it did read.
 * @type {string[]}
 */
const SECURITY_TARGETS = ["src/", "scripts/", "util/", "server.js", "bot.js"];

/**
 * Targets for the secret scanner.  Same scope as SECURITY_TARGETS plus
 * the config surfaces where a credential is most likely to be
 * committed by accident.  Glob form, because secretlint does its own
 * expansion.
 * @type {string[]}
 */
const SECRET_TARGETS = [
  "src/**/*.js",
  "scripts/**/*.js",
  "util/**/*.js",
  "server.js",
  "bot.js",
  ".env*",
  "*.json",
];

/**
 * Markdown files under the markdownlint gate.
 *
 * Centralised for the same reason as the lists above, and after the
 * same failure: the list was written out by hand in three places
 * (`npm run lint`, `npm run lint:fix`, `scripts/check.js`) and drifted.
 * `lint:fix` was missing `docs/architecture.md`, `docs/configuration.md`
 * and `docs/engineering.md` — the three largest documents in the repo —
 * so the check pass reported violations in files the fix pass would
 * never touch.
 * @type {string[]}
 */
const MARKDOWN_TARGETS = [
  "README.md",
  "CLAUDE.md",
  "docs/claude/CLAUDE-SECURITY.md",
  "docs/claude/CLAUDE-BEST-PRACTICES.md",
  "docs/claude/CLAUDE-TESTING.md",
  "docs/claude/CLAUDE-DISCLOSURES.md",
  "docs/architecture.md",
  "docs/configuration.md",
  "docs/engineering.md",
  "docs/npm-project-commands.md",
  "docs/security.md",
  "docs/roadmap/**/*.md",
];

module.exports = {
  JS_TARGETS,
  SECURITY_TARGETS,
  SECRET_TARGETS,
  MARKDOWN_TARGETS,
};
