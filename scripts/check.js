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

const { log } = require("../src/log");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

/** Per-install operator-state directories.  Files in each are
 *  gitignored, but each directory ships with a tracked README.md
 *  (which the backup pass explicitly preserves so it doesn't vanish
 *  across the wipe).  Declared at module top so the backup/wipe/
 *  restore functions called from the top-level script body (lines
 *  below) can reference them without hitting the temporal-dead-zone. */
const _USER_CFG_DIR = path.join("app-config", "user-configurable");
const _APP_DATA_DIR = "app-data";
const _OPERATOR_STATE_DIRS = [_USER_CFG_DIR, _APP_DATA_DIR];

/*- File-name predicates used by the backup/wipe/restore helpers.
 *  Hoisted up here so the top-level script body (restoreProdFiles is
 *  called from the EXIT trap, which fires anywhere below) can
 *  reference them without hitting the temporal-dead-zone. */
const _IS_README = (n) => n === "README.md";
const _IS_JSON = (n) => n.endsWith(".json");
process.chdir(ROOT);

const REPORT_DIR = "test/report-artifacts";
const RAW_DIR = path.join(REPORT_DIR, "raw-data");
const TXT_DIR = path.join(REPORT_DIR, "text-reports");

/** Resolve a binary in node_modules/.bin. */
function bin(name) {
  return path.join(ROOT, "node_modules", ".bin", name);
}

/** Run a command synchronously, return { status, stdout, stderr }.
 *  maxBuffer defaults to 128 MiB — the Node 22 default is 1 MiB and the
 *  test suite's TAP + coverage output has grown past that (~1.05 MiB
 *  on 2026-07-17), which manifested as a spurious SIGTERM + ENOBUFS on
 *  Node 22 CI while Node 24 (with its larger default) still fit.  Node
 *  the default is not "bleeding-edge" — it's just that Node 24 raised
 *  the default and Node 22 didn't.  Callers can still override. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
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
  "docs/claude/CLAUDE-BEST-PRACTICES.md",
  "docs/claude/CLAUDE-TESTING.md",
  "docs/claude/CLAUDE-DISCLOSURES.md",
  "docs/architecture.md",
  "docs/engineering.md",
  "docs/roadmap/**/*.md",
]);
fs.writeFileSync(
  path.join(TXT_DIR, "markdownlint.txt"),
  markdownlintRun.stdout + markdownlintRun.stderr,
);

// ── Lint (JSON) — Prettier --check ────────────────────────────────────────
// Prettier has no JSON reporter, so capture stdout/stderr to a text file
// and surface the exit code through the aggregator. .prettierignore at the
// repo root excludes package-lock.json plus runtime/generated state.
const prettierJsonRun = run(bin("prettier"), [
  "--check",
  "--log-level=warn",
  "**/*.json",
]);
fs.writeFileSync(
  path.join(TXT_DIR, "prettier-json.txt"),
  prettierJsonRun.stdout + prettierJsonRun.stderr,
);

// ── Lint (YAML) — Prettier --check ────────────────────────────────────────
// Same approach as the JSON glob: enforce parse + canonical formatting on
// every tracked .yml / .yaml file. .prettierignore exclusions apply.
const prettierYamlRun = run(bin("prettier"), [
  "--check",
  "--log-level=warn",
  "**/*.{yml,yaml}",
]);
fs.writeFileSync(
  path.join(TXT_DIR, "prettier-yaml.txt"),
  prettierYamlRun.stdout + prettierYamlRun.stderr,
);

// ── Lint (GitHub Actions) — actionlint ────────────────────────────────────
// Catches workflow-specific bugs Prettier never will: bad `uses:` versions,
// invalid runs-on, expression syntax errors, deprecated actions, shell
// quoting issues in `run:` blocks. Binary downloaded by github-actionlint
// at install time. Clean output = silent; errors print to stdout.
const actionlintRun = run(bin("github-actionlint"), [...listWorkflowFiles()]);
fs.writeFileSync(
  path.join(TXT_DIR, "actionlint.txt"),
  actionlintRun.stdout + actionlintRun.stderr,
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
  log.error("[check] Test runner failed:", err.message);
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
  prettierJson: prettierJsonRun.status,
  prettierYaml: prettierYamlRun.status,
  actionlint: actionlintRun.status,
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

/** List .github/workflows/*.yml paths for actionlint. */
function listWorkflowFiles() {
  const dir = path.join(".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(dir, f));
}

/** List test/*.test.js paths for node --test. */
function listTestFiles() {
  return fs
    .readdirSync("test")
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join("test", f));
}

/** Copy every operator-state file in app-config/user-configurable/
 *  and app-data/ (except each dir's tracked README.md) plus tmp/*.json
 *  to `backup`.  Operator-state contents are protected on the same
 *  footing as `.env`: tests must not silently destroy them. */
function backupProdFiles(backup) {
  for (const dir of _OPERATOR_STATE_DIRS) {
    fs.mkdirSync(path.join(backup, dir), { recursive: true });
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (_IS_README(entry.name)) continue;
      fs.copyFileSync(
        path.join(dir, entry.name),
        path.join(backup, dir, entry.name),
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

/** Delete operator-state files (app-config/user-configurable/ +
 *  app-data/ contents, except each dir's README.md) and tmp/*.json so
 *  tests see vanilla state. */
function wipeRuntimeFiles() {
  for (const dir of _OPERATOR_STATE_DIRS) {
    _wipeDir(dir, _IS_README);
  }
  if (fs.existsSync("tmp")) {
    for (const entry of fs.readdirSync("tmp", { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      fs.unlinkSync(path.join("tmp", entry.name));
    }
  }
}

/*- Delete files in `dir` matching `keep` predicate (entries where
 *  `keep(name)` returns true are skipped).  No-op if dir missing. */
function _wipeDir(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (keep && keep(entry.name)) continue;
    fs.unlinkSync(path.join(dir, entry.name));
  }
}

/*- Copy every file from `srcDir` to `dstDir` (creating dstDir).  Skip
 *  non-files; skip entries failing `accept(name)` when supplied. */
function _restoreDir(srcDir, dstDir, accept) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (accept && !accept(entry.name)) continue;
    fs.copyFileSync(
      path.join(srcDir, entry.name),
      path.join(dstDir, entry.name),
    );
  }
}

/** Restore operator-state directories (app-config/user-configurable/
 *  and app-data/) plus tmp/*.json from `backup`. */
function restoreProdFiles(backup) {
  // Wipe any test-created runtime files, then copy originals back.
  for (const dir of _OPERATOR_STATE_DIRS) {
    _wipeDir(dir, _IS_README);
    _restoreDir(path.join(backup, dir), dir);
  }
  _wipeDir("tmp", (n) => !_IS_JSON(n));
  _restoreDir(path.join(backup, "tmp"), "tmp");
}
