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
 *   raw-data/lcov.info         lcov coverage report of the test run
 *   text-reports/summary.txt          Human-readable overview (cli-table3)
 *   text-reports/tests-summary.txt    Parsed test rollup
 *   text-reports/eslint-timing.txt    ESLint TIMING=1 slowest-rule capture
 *   text-reports/markdownlint.txt     markdownlint-cli2 text output
 *   config-values.tap          Raw TAP v14 from the shipped-config tests,
 *                              which run before the rest of the suite
 *   tests.tap                  Raw TAP v14 from `node --test`
 *   report.pdf                 Unified PDF of all results (pdfmake)
 *
 * And one outside it: logs/error-npm-run-check.log, whatever the tests
 * wrote to logs/error.log. The run deletes logs/error.log and the
 * previous run's copy before it starts, and renames the file once the
 * tests are done, so the operator's error log never holds a test's
 * entries.
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

const { log } = require("../src/lib/log");
const { getErrorLogPath } = require("../src/lib/error-log");
const {
  removeLeftoverTestTempFolders,
} = require("../src/lib/test-temp-folders");
const { checkErrorLogPath } = require("./_check-error-log");
const { runAsync } = require("./_run-async");
const {
  JS_TARGETS,
  SECURITY_TARGETS,
  SECRET_TARGETS,
  MARKDOWN_TARGETS,
} = require("./lint-targets");
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
// The scan caches (src/lib/scan-cache-dir.js), a folder inside app-data/.
const _SCAN_CACHE_DIR = path.join("app-data", "scan-cache");
const _OPERATOR_STATE_DIRS = [_USER_CFG_DIR, _APP_DATA_DIR, _SCAN_CACHE_DIR];

/*- The file-name predicate used by the backup/wipe/restore helpers.
 *  Hoisted up here so the top-level script body (restoreProdFiles is
 *  called from the EXIT trap, which fires anywhere below) can
 *  reference it without hitting the temporal-dead-zone. */
const _IS_README = (n) => n === "README.md";
process.chdir(ROOT);

const REPORT_DIR = "test/report-artifacts";
const RAW_DIR = path.join(REPORT_DIR, "raw-data");
const TXT_DIR = path.join(REPORT_DIR, "text-reports");

/*-
 *  The catastrophic-failure log, at the path src/lib/error-log.js owns, and
 *  the name a test run's entries are kept under beside it. Resolved
 *  after the chdir above, since the log's path is relative to the
 *  working directory.
 */
const ERROR_LOG = getErrorLogPath();
const CHECK_ERROR_LOG = checkErrorLogPath(ERROR_LOG);

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
/*-
 *  Some tests drive code that records a failure in logs/error.log, and
 *  that is the operator's own file. So the run starts with neither it
 *  nor the previous run's copy, and once the tests are done whatever
 *  they wrote is renamed (`keepTestErrorLog`). Nothing older is lost
 *  that a server start would keep: startup deletes logs/error.log.
 */
fs.rmSync(ERROR_LOG, { force: true });
fs.rmSync(CHECK_ERROR_LOG, { force: true });

// ── Lint (JS) ──────────────────────────────────────────────────────────────
// TIMING=1 writes the slowest-rules table to stdout AFTER the JSON blob
// (which is itself a single line). Split: line 1 is the JSON, lines 2+
// are the TIMING table.
const eslintRun = run(
  bin("eslint"),
  [
    /*- Same targets as the `lint` npm script, from the shared list.
     *  Previously this call spelled out its own directory list and
     *  omitted `util/` entirely — so 23 files were linted by
     *  `npm run lint` but never by `npm run check`, which is the gate
     *  CI runs.  Driving both from JS_TARGETS makes that class of
     *  divergence impossible. */
    ...JS_TARGETS,
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
  run(bin("eslint"), ["--print-config", "src/server.js"]).stdout,
);

// ── Lint (CSS) ─────────────────────────────────────────────────────────────
const stylelintRun = run(bin("stylelint"), [
  "src/client/web/*.css",
  "--formatter",
  "json",
  "-o",
  path.join(RAW_DIR, "stylelint.json"),
]);
ensureOrWrite(path.join(RAW_DIR, "stylelint.json"), "[]");

fs.writeFileSync(
  path.join(RAW_DIR, "stylelint-config.json"),
  run(bin("stylelint"), ["--print-config", "src/client/web/style.css"]).stdout,
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
const markdownlintRun = run(bin("markdownlint-cli2"), [...MARKDOWN_TARGETS]);
fs.writeFileSync(
  path.join(TXT_DIR, "markdownlint.txt"),
  markdownlintRun.stdout + markdownlintRun.stderr,
);

// ── Lint (JS) — Prettier --check ──────────────────────────────────────────
// JS formatting is verified here, not only by the pre-commit hook: a
// file that never went through the hook, or whose formatting drifted
// outside it, would otherwise pass both `npm run lint` and this gate.
// The glob list is the one `npm run format:check` uses and mirrors the
// ESLint targets, so src/ and util/ are covered to the same depth by
// both passes.
const prettierJsRun = run(bin("prettier"), [
  "--check",
  "--log-level=warn",
  ...JS_TARGETS,
]);
fs.writeFileSync(
  path.join(TXT_DIR, "prettier-js.txt"),
  prettierJsRun.stdout + prettierJsRun.stderr,
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

// ── Lint (SVG) — strict XML + no-id policy ───────────────────────────────
// Ran only in `npm run lint` until now, so the pre-commit hook was the
// sole enforcement and CI — which runs `npm run check` and nothing else
// — never saw it.  See docs/engineering.md § "SVG Assets".
const lintSvgRun = run("node", [
  path.join(ROOT, "scripts", "lint-svg.js"),
  "--json",
]);
fs.writeFileSync(
  path.join(RAW_DIR, "lint-svg.json"),
  lintSvgRun.stdout + lintSvgRun.stderr,
);
/*- A crashed linter leaves an empty file; give the aggregator a shape
 *  it can render rather than a parse error. */
ensureOrWrite(
  path.join(RAW_DIR, "lint-svg.json"),
  '{"ok":false,"files":0,"errors":0,"problems":["linter did not run"]}',
);

// ── Dead code (knip) — unused FILES only ──────────────────────────────────
// Only the `files` issue type is a gate.  knip's unused-exports pass is
// noise here by design: `src/client/web/dashboard-*.js` is reached through HTML
// script tags it cannot trace, and both `src/lib/` and `util/` export their
// internals deliberately so tests and other tools can compose them — an
// export nothing imports yet is a seam, not a defect.  An unused FILE is
// different: nothing reaches it at all, so it is dead weight that still
// ships, and knip.json declares every real entry point, which is what
// makes the answer trustworthy.
const knipRun = run("npm", [
  "run",
  "--silent",
  "knip:files",
  "--",
  "--reporter",
  "json",
]);
fs.writeFileSync(
  path.join(RAW_DIR, "knip.json"),
  knipRun.stdout + knipRun.stderr,
);
/*- A crashed run leaves an empty file; hand the aggregator a shape it
 *  can render rather than a parse error. */
ensureOrWrite(path.join(RAW_DIR, "knip.json"), '{"files":[],"issues":[]}');

// ── Docs (OpenAPI) — spec-vs-code sync ────────────────────────────────────
// Its own row rather than a line buried in the test rollup: "is the API
// reference still true?" is a question a reviewer should be able to
// answer at a glance.
const openapiSyncRun = run("node", [
  path.join(ROOT, "scripts", "check-openapi-sync.js"),
  "--json",
]);
fs.writeFileSync(
  path.join(RAW_DIR, "openapi-sync.json"),
  openapiSyncRun.stdout + openapiSyncRun.stderr,
);
/*- A crashed checker leaves an empty file; give the aggregator a shape
 *  it can render rather than a parse error. */
ensureOrWrite(
  path.join(RAW_DIR, "openapi-sync.json"),
  '{"ok":false,"problems":["checker did not run"],"routeCount":0,"configKeyCount":0,"uiSettingCount":0}',
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
// Two runs, because what gates and what is worth reading differ.
//
// The gate gets --omit=dev: it asks whether the tree that SHIPS carries a
// high advisory, which is the tree that runs beside an unlocked wallet. A
// dev-only advisory in the lint tooling is a different risk — it is
// reached through glob patterns this repo writes, not through anything an
// attacker supplies — and it can be unfixable through no fault of ours.
// `braces` is exactly that today: the newest published version is the
// vulnerable one, and the newest `micromatch` pins it, so every tool that
// globs carries it. Gating on it would mean a permanently red gate with no
// action available, which trains people to ignore the gate.
// --audit-level=high keeps moderate advisories from failing either run,
// as it always has.
//
// The report keeps everything, dev included, so the advisories that are
// not gated are still read rather than forgotten. See
// docs/claude/CLAUDE-SECURITY.md § "Advisories with no fix available".
const npmAuditRun = run("npm", [
  "audit",
  "--audit-level=high",
  "--omit=dev",
  "--json",
]);
const npmAuditFullRun = run("npm", ["audit", "--json"]);
fs.writeFileSync(path.join(RAW_DIR, "npm-audit.json"), npmAuditFullRun.stdout);

// ── Security: eslint-security rules ───────────────────────────────────────
const securityLintRun = run(bin("eslint"), [
  "-c",
  "eslint-security.config.js",
  /*- Shared list, so the gate CI runs and `npm run audit:security`
   *  cover the same files. */
  ...SECURITY_TARGETS,
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
    "src/server.js",
  ]).stdout,
);

// ── Security: secretlint ──────────────────────────────────────────────────
const secretlintRun = run(bin("secretlint"), [
  /*- Shared list, for the same reason. */
  ...SECRET_TARGETS,
  "--format",
  "json",
  "--output",
  path.join(RAW_DIR, "secretlint.json"),
]);
ensureOrWrite(path.join(RAW_DIR, "secretlint.json"), "[]");

// ── Backup production files before tests ──────────────────────────────────
/*-
 *  From the backup to the restore, an interrupt must not end this
 *  process. With no listener, Node exits on SIGINT at once, so the
 *  `finally` below would never run and the operator's files would be
 *  left only in the backup directory. With one, this process survives
 *  the signal, the test run it is waiting on (which receives the same
 *  signal) ends, and the `finally` restores the files before this
 *  process exits.
 *
 *  The test runs are awaited (`runAsync`) rather than run with
 *  `spawnSync`, which blocks the event loop: the listener could not run
 *  until the whole script was done, so a Ctrl+C during the first run
 *  went unnoticed and the second started with the operator's files
 *  still moved out. Awaited, the listener runs at once, and the run
 *  stops after the stage it interrupted.
 */
let interrupted = null;
const onInterrupt = (signal) => {
  interrupted = signal;
};
const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of INTERRUPTS) process.on(signal, onInterrupt);
/*-
 *  Each test process removes its temp folders as it exits, but one
 *  stopped outright (Ctrl+C, kill -9) cannot. Those folders go here,
 *  before the operator's files are moved out for the tests: a folder
 *  that cannot be removed then stops the run with those files still in
 *  place, rather than after they have been moved.
 */
const leftoverFolders = removeLeftoverTestTempFolders();
if (leftoverFolders > 0)
  log.info(
    "[check] Removed %d test folder(s) a stopped run left in %s",
    leftoverFolders,
    os.tmpdir(),
  );
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-backup-"));
log.info("[check] Operator files backed up to %s for the tests", backupDir);
backupProdFiles(backupDir);
wipeRuntimeFiles();

// ── Tests + Coverage ──────────────────────────────────────────────────────
/**
 * Run the config-value tests, then the rest of the suite, and put the
 * operator's files back whatever happens, an interrupt included.
 * Forces --test-reporter=tap so the output is deterministic TAP v14
 * regardless of Node version or TTY state.
 * @returns {Promise<{configValuesExit: number|undefined,
 *   testsExit: number}>}
 */
async function runTestStages() {
  let configValuesExit;
  let testsExit;
  try {
    /*-
     *  The shipped config files are checked before any other test. A
     *  value of the wrong type, or outside its range, breaks whatever
     *  reads it, and the rest of the suite would report each of those
     *  breakages as a failure of its own. Run first, these tests name the
     *  cause first, in a report row of their own. The rest of the suite
     *  runs either way, as every other check here does.
     */
    const configRun = await runAsync("node", [
      "--test",
      "--test-reporter=tap",
      "--test-reporter-destination=stdout",
      ...configValueTests(),
    ]);
    configValuesExit = configRun.status;
    fs.writeFileSync(
      path.join(REPORT_DIR, "config-values.tap"),
      configRun.stdout + configRun.stderr,
    );
    if (interrupted !== null) throw new Error(`interrupted by ${interrupted}`);
    const testsRun = await runAsync("node", [
      "--test",
      "--experimental-test-coverage",
      /*-
       *  Browser-side files (src/client/web/dashboard-*.js) are covered by their
       *  own test suites that jsdom-drive them.  They are excluded from
       *  the aggregate coverage figure to preserve the existing 80% floor
       *  for src/ (Node-side) code.  Adding them without a dashboard-
       *  focused coverage floor would dilute the src/ signal — a bad
       *  regression on src/ would go unnoticed if the aggregate stayed
       *  above 80% thanks to well-covered dashboard files.  When
       *  dashboard coverage is measured separately (see project
       *  nice-to-haves), we can drop this exclude.
       */
      "--test-coverage-exclude=src/client/web/**",
      /*-
       *  Two reporters for the one run. TAP goes to stdout, captured below
       *  as tests.tap. The lcov report names each branch no test took,
       *  which tests.tap does not, and that is what the files held to 95%
       *  branch coverage are measured with (docs/claude/CLAUDE-TESTING.md
       *  § 95% Coverage Regions). Writing it here keeps it under this
       *  script's backup of the operator's files.
       */
      "--test-reporter=tap",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${path.join(RAW_DIR, "lcov.info")}`,
      // Every other test: the config values ran above.
      ...listTestFiles().filter((f) => !configValueTests().includes(f)),
    ]);
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
    keepTestErrorLog();
    for (const signal of INTERRUPTS) process.off(signal, onInterrupt);
  }
  return { configValuesExit, testsExit };
}

/**
 * Report the run: every stage's exit code to the aggregator, which
 * prints the summary and writes the PDF, and exit with its verdict. An
 * interrupted run reports nothing and exits 1.
 * @param {{configValuesExit: number|undefined, testsExit: number}} tests
 */
function reportRun({ configValuesExit, testsExit }) {
  if (interrupted !== null) {
    log.error(
      "[check] Stopped by %s; the operator's files are restored.",
      interrupted,
    );
    process.exit(1);
  }

  // ── Write exit codes + file counts for the aggregator ───────────────────
  const exitCodes = {
    eslint: eslintRun.status,
    stylelint: stylelintRun.status,
    htmlValidate: htmlValidateRun.status,
    markdownlint: markdownlintRun.status,
    prettierJs: prettierJsRun.status,
    prettierJson: prettierJsonRun.status,
    prettierYaml: prettierYamlRun.status,
    actionlint: actionlintRun.status,
    lintSvg: lintSvgRun.status,
    knip: knipRun.status,
    openapiSync: openapiSyncRun.status,
    auditDeps: npmAuditRun.status,
    securityLint: securityLintRun.status,
    secretlint: secretlintRun.status,
    configValues: configValuesExit,
    tests: testsExit,
    htmlFileCount,
  };
  fs.writeFileSync(
    path.join(RAW_DIR, "exit-codes.json"),
    JSON.stringify(exitCodes, null, 2) + "\n",
  );

  // ── Aggregate + print summary + write PDF ───────────────────────────────
  const aggregator = run("node", ["scripts/check-report.js"], {
    stdio: "inherit",
  });
  process.exit(aggregator.status);
}

runTestStages().then(reportRun);

// ── Helpers ───────────────────────────────────────────────────────────────

/** List src/client/web/*.html paths for html-validate. */
function listPublicHtmlFiles() {
  const web = path.join("src", "client", "web");
  return fs
    .readdirSync(web)
    .filter((f) => f.endsWith(".html"))
    .map((f) => path.join(web, f));
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

/**
 * The tests that check the shipped config files themselves, `.env.example`
 * among them, which run before every other test.
 *
 * A function rather than a module-level `const` for the same reason as
 * `listTestFiles` below: the tests block calls it from far above here.
 * The paths are as `listTestFiles` spells them, so the main run can
 * leave them out by comparing strings.
 *
 * @returns {string[]}
 */
function configValueTests() {
  return [
    path.join("test", "setting-bounds.test.js"),
    path.join("test", "shipped-config-values.test.js"),
    path.join("test", "shipped-env-example-values.test.js"),
  ];
}

/**
 * List every *.test.js path for node --test, across all suite dirs.
 *
 * The directory list is local, not a module-level `const`: this
 * function is called from the top-level tests block far ABOVE this
 * declaration, so a `const` here would sit in the temporal dead zone
 * and throw `ReferenceError` at call time — which surfaced as a silent
 * "0/0 tests passed" because the caller catches and logs.
 *
 * Kept in lockstep with the `test` script in package.json: `npm run
 * check` must execute the same set, or a suite can pass one gate while
 * never running in the other.  `util/test/` is included so
 * util/ is covered — and counted toward the coverage floor — on the
 * same footing as src/lib/.
 */
function listTestFiles() {
  const dirs = [
    "test",
    "test/eslint-rules",
    "test/stylelint-rules",
    "util/test",
  ];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".test.js")) out.push(path.join(dir, f));
    }
  }
  return out;
}

/** Copy every operator-state file in app-config/user-configurable/,
 *  app-data/ and app-data/scan-cache/ (except each dir's tracked
 *  README.md) to `backup`.  Operator-state contents are protected on
 *  the same footing as `.env`: tests must not silently destroy them. */
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
}

/** Delete operator-state files (app-config/user-configurable/,
 *  app-data/ and app-data/scan-cache/ contents, except each dir's
 *  README.md) so tests see vanilla state. */
function wipeRuntimeFiles() {
  for (const dir of _OPERATOR_STATE_DIRS) {
    _wipeDir(dir, _IS_README);
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

/**
 * Rename what the tests wrote to the error log (logs/error.log as
 * shipped) to error-npm-run-check.log beside it. No file means no test
 * wrote one.
 */
function keepTestErrorLog() {
  if (fs.existsSync(ERROR_LOG)) fs.renameSync(ERROR_LOG, CHECK_ERROR_LOG);
}

/** Restore operator-state directories (app-config/user-configurable/,
 *  app-data/ and app-data/scan-cache/) from `backup`. */
function restoreProdFiles(backup) {
  // Wipe any test-created runtime files, then copy originals back.
  for (const dir of _OPERATOR_STATE_DIRS) {
    _wipeDir(dir, _IS_README);
    _restoreDir(path.join(backup, dir), dir);
  }
}
