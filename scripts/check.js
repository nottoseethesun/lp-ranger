/**
 * @file scripts/check.js
 * @description Run lint + tests + coverage + security audits and emit a
 * full report of the results.
 *
 * Outputs (all under test/report-artifacts/, gitignored):
 *   raw-data/*.json            Machine-readable tool outputs (eslint,
 *                              stylelint, html-validate, npm audit,
 *                              security-lint, secretlint, plus
 *                              exit-codes.json with every tool's exit
 *                              code)
 *   text-reports/summary.txt          Human-readable overview (cli-table3)
 *   text-reports/tests-summary.txt    Parsed test rollup
 *   text-reports/eslint-timing.txt    ESLint TIMING=1 slowest-rule capture
 *   text-reports/markdownlint.txt     markdownlint-cli2 text output
 *   tests.tap                  Raw TAP v14 from `node --test`
 *   report.pdf                 Unified PDF of all results (pdfmake)
 *
 * After capturing raw outputs this script delegates to
 * scripts/check-report.js to parse, print the terminal summary, and
 * write summary.txt + tests-summary.txt + report.pdf. The aggregator's
 * exit code (0 = all checks green, 1 = at least one failed) becomes
 * this script's exit code — so GitHub CI still fails on any red result.
 *
 * See docs/engineering.md § Check Report Artifacts for the full layout
 * and regeneration workflow.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const REPORT_DIR = "test/report-artifacts";
const RAW_DIR = path.join(REPORT_DIR, "raw-data");
const TXT_DIR = path.join(REPORT_DIR, "text-reports");

/** Resolve a binary in node_modules/.bin. */
function bin(name) {
  return path.join(ROOT, "node_modules", ".bin", name);
}

/** Run a command synchronously, return { status, stdout, stderr }. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    ...opts,
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
  });
  return {
    status: res.status === null ? 1 : res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
  };
}

/** Ensure a file exists; if empty or absent, write `fallback`. */
function ensureOrWrite(filePath, fallback) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    fs.writeFileSync(filePath, fallback);
  }
}

// ── Clean prior outputs so stale artifacts don't leak into a new run ──────
fs.rmSync(REPORT_DIR, { recursive: true, force: true });
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(TXT_DIR, { recursive: true });

// ── Lint (JS) ──────────────────────────────────────────────────────────────
// TIMING=1 writes the slowest-rules table to stdout AFTER the JSON blob
// (which is itself a single line). Split: line 1 is the JSON, lines 2+
// are the TIMING table.
const eslintRun = run(
  bin("eslint"),
  [
    "src/",
    "test/",
    "scripts/",
    "server.js",
    "bot.js",
    ...listDashboardFiles(),
    "eslint-rules/",
    "--max-warnings",
    "0",
    "--format",
    "json-with-metadata",
  ],
  { env: { ...process.env, TIMING: "1" } },
);
const eslintLines = eslintRun.stdout.split("\n");
fs.writeFileSync(
  path.join(RAW_DIR, "eslint.json"),
  (eslintLines[0] || "") + "\n",
);
fs.writeFileSync(
  path.join(TXT_DIR, "eslint-timing.txt"),
  eslintLines.slice(1).join("\n"),
);

// Resolved-config dump — true "rules loaded" count for the report, since
// eslint.json's rulesMeta is empty when nothing fires.
fs.writeFileSync(
  path.join(RAW_DIR, "eslint-config.json"),
  run(bin("eslint"), ["--print-config", "server.js"]).stdout,
);

// ── Lint (CSS) ─────────────────────────────────────────────────────────────
const stylelintRun = run(bin("stylelint"), [
  "public/*.css",
  "--formatter",
  "json",
  "-o",
  path.join(RAW_DIR, "stylelint.json"),
]);
ensureOrWrite(path.join(RAW_DIR, "stylelint.json"), "[]");

fs.writeFileSync(
  path.join(RAW_DIR, "stylelint-config.json"),
  run(bin("stylelint"), ["--print-config", "public/style.css"]).stdout,
);

// ── Lint (HTML) ────────────────────────────────────────────────────────────
const htmlValidateRun = run(bin("html-validate"), [
  "-f",
  "json",
  ...listPublicHtmlFiles(),
]);
fs.writeFileSync(
  path.join(RAW_DIR, "html-validate.json"),
  htmlValidateRun.stdout,
);
// html-validate's JSON reporter omits clean files entirely; count them here.
const htmlFileCount = listPublicHtmlFiles().length;

// ── Lint (Markdown) ───────────────────────────────────────────────────────
// markdownlint-cli2 has no native JSON reporter — capture stylish text
// into a single combined stream file (matches old bash `>file 2>&1`).
const markdownlintRun = run(bin("markdownlint-cli2"), [
  "README.md",
  "CLAUDE.md",
  "docs/claude/CLAUDE-SECURITY.md",
]);
fs.writeFileSync(
  path.join(TXT_DIR, "markdownlint.txt"),
  markdownlintRun.stdout + markdownlintRun.stderr,
);

// ── Security: npm audit ───────────────────────────────────────────────────
// Keep --audit-level=high so moderate pre-existing advisories don't fail
// the check, but store the full report for review.
const npmAuditRun = run("npm", ["audit", "--audit-level=high", "--json"]);
fs.writeFileSync(path.join(RAW_DIR, "npm-audit.json"), npmAuditRun.stdout);

// ── Security: eslint-security rules ───────────────────────────────────────
const securityLintRun = run(bin("eslint"), [
  "-c",
  "eslint-security.config.js",
  "src/",
  "scripts/",
  "server.js",
  "bot.js",
  "--max-warnings",
  "0",
  "--format",
  "json",
]);
fs.writeFileSync(
  path.join(RAW_DIR, "security-lint.json"),
  securityLintRun.stdout,
);

fs.writeFileSync(
  path.join(RAW_DIR, "security-lint-config.json"),
  run(bin("eslint"), [
    "-c",
    "eslint-security.config.js",
    "--print-config",
    "server.js",
  ]).stdout,
);

// ── Security: secretlint ──────────────────────────────────────────────────
const secretlintRun = run(bin("secretlint"), [
  "src/**/*.js",
  "scripts/**/*.js",
  "server.js",
  "bot.js",
  ".env*",
  "*.json",
  "--format",
  "json",
  "--output",
  path.join(RAW_DIR, "secretlint.json"),
]);
ensureOrWrite(path.join(RAW_DIR, "secretlint.json"), "[]");

// ── Backup production files before tests ──────────────────────────────────
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-backup-"));
backupProdFiles(backupDir);
wipeRuntimeFiles();

// ── Tests + Coverage ──────────────────────────────────────────────────────
// Force --test-reporter=tap so the output is deterministic TAP v14
// regardless of Node version or TTY state.
let testsExit;
try {
  const testsRun = run(
    "node",
    [
      "--test",
      "--experimental-test-coverage",
      "--test-reporter=tap",
      ...listTestFiles(),
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  testsExit = testsRun.status;
  fs.writeFileSync(
    path.join(REPORT_DIR, "tests.tap"),
    testsRun.stdout + testsRun.stderr,
  );
} catch (err) {
  testsExit = 1;
  console.error("[check] Test runner failed:", err.message);
} finally {
  restoreProdFiles(backupDir);
  fs.rmSync(backupDir, { recursive: true, force: true });
}

// ── Write exit codes + file counts for the aggregator ─────────────────────
const exitCodes = {
  eslint: eslintRun.status,
  stylelint: stylelintRun.status,
  htmlValidate: htmlValidateRun.status,
  markdownlint: markdownlintRun.status,
  auditDeps: npmAuditRun.status,
  securityLint: securityLintRun.status,
  secretlint: secretlintRun.status,
  tests: testsExit,
  htmlFileCount,
};
fs.writeFileSync(
  path.join(RAW_DIR, "exit-codes.json"),
  JSON.stringify(exitCodes, null, 2) + "\n",
);

// ── Aggregate + print summary + write PDF ─────────────────────────────────
const aggregator = run("node", ["scripts/check-report.js"], {
  stdio: "inherit",
});
process.exit(aggregator.status);

// ── Helpers ───────────────────────────────────────────────────────────────

/** List dashboard-*.js source paths (manual glob since spawn doesn't glob). */
function listDashboardFiles() {
  return fs
    .readdirSync("public")
    .filter((f) => f.startsWith("dashboard-") && f.endsWith(".js"))
    .map((f) => path.join("public", f));
}

/** List public/*.html paths for html-validate. */
function listPublicHtmlFiles() {
  return fs
    .readdirSync("public")
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join("public", f));
}

/** List test/*.test.js paths for node --test. */
function listTestFiles() {
  return fs
    .readdirSync("test")
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join("test", f));
}

/** Copy top-level runtime files in app-config/ and tmp/*.json to `backup`. */
function backupProdFiles(backup) {
  fs.mkdirSync(path.join(backup, "app-config"), { recursive: true });
  if (fs.existsSync("app-config")) {
    for (const entry of fs.readdirSync("app-config", { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name === "api-keys.example.json") continue;
      fs.copyFileSync(
        path.join("app-config", entry.name),
        path.join(backup, "app-config", entry.name),
      );
    }
  }
  fs.mkdirSync(path.join(backup, "tmp"), { recursive: true });
  if (fs.existsSync("tmp")) {
    for (const entry of fs.readdirSync("tmp", { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      fs.copyFileSync(
        path.join("tmp", entry.name),
        path.join(backup, "tmp", entry.name),
      );
    }
  }
}

/** Delete runtime app-config files and tmp/*.json so tests see vanilla state. */
function wipeRuntimeFiles() {
  if (fs.existsSync("app-config")) {
    for (const entry of fs.readdirSync("app-config", { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name === "api-keys.example.json") continue;
      fs.unlinkSync(path.join("app-config", entry.name));
    }
  }
  if (fs.existsSync("tmp")) {
    for (const entry of fs.readdirSync("tmp", { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      fs.unlinkSync(path.join("tmp", entry.name));
    }
  }
}

/** Restore app-config and tmp/*.json from `backup`. */
function restoreProdFiles(backup) {
  // Wipe any test-created runtime files, then copy originals back.
  if (fs.existsSync("app-config")) {
    for (const entry of fs.readdirSync("app-config", { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name === "api-keys.example.json") continue;
      fs.unlinkSync(path.join("app-config", entry.name));
    }
  }
  const backupAppConfig = path.join(backup, "app-config");
  if (fs.existsSync(backupAppConfig)) {
    for (const entry of fs.readdirSync(backupAppConfig, {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      fs.copyFileSync(
        path.join(backupAppConfig, entry.name),
        path.join("app-config", entry.name),
      );
    }
  }
  if (fs.existsSync("tmp")) {
    for (const entry of fs.readdirSync("tmp", { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      fs.unlinkSync(path.join("tmp", entry.name));
    }
  }
  const backupTmp = path.join(backup, "tmp");
  if (fs.existsSync(backupTmp)) {
    for (const entry of fs.readdirSync(backupTmp, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      fs.mkdirSync("tmp", { recursive: true });
      fs.copyFileSync(
        path.join(backupTmp, entry.name),
        path.join("tmp", entry.name),
      );
    }
  }
}
