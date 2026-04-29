#!/usr/bin/env node
/**
 * @file scripts/check-report.js
 * @description
 * Aggregator invoked at the end of scripts/check.sh. Reads all raw tool
 * outputs from test/report-artifacts/raw-data/ plus the text captures in
 * test/report-artifacts/text-reports/, parses them via
 * check-report-parse.js, prints a colored terminal summary (cli-table3),
 * writes summary.txt + tests-summary.txt + summary.md into text-reports/,
 * and renders the unified PDF via check-report-pdf.js.
 *
 * `summary.md` is GitHub-flavored markdown for `$GITHUB_STEP_SUMMARY` —
 * CI appends it so the rollup renders inline on every workflow run page.
 *
 * Exit code is 0 only when every check is green — scripts/check.sh
 * propagates this for GitHub CI. Safe to rerun without re-running any
 * tools: reads only the previously-captured files.
 *
 * See the "Check report artifacts" section of server.js for the full
 * layout and regeneration workflow.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Table = require("cli-table3");
const P = require("./check-report-parse");
const { renderPdf } = require("./check-report-pdf");
const { renderMarkdown } = require("./check-report-md");

const REPORT_DIR = path.join("test", "report-artifacts");
const RAW_DIR = path.join(REPORT_DIR, "raw-data");
const TXT_DIR = path.join(REPORT_DIR, "text-reports");

const _GREEN = "\x1b[1;32m";
const _RED = "\x1b[1;31m";
const _DIM = "\x1b[2m";
const _CYAN = "\x1b[36m";
const _RESET = "\x1b[0m";

/**
 * Safely read a JSON file from raw-data/. Returns null on any failure so
 * parsers can handle missing inputs gracefully.
 * @param {string} name  File name inside raw-data/
 */
function _readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(RAW_DIR, name), "utf8"));
  } catch {
    return null;
  }
}

function _readText(relPath) {
  try {
    return fs.readFileSync(path.join(REPORT_DIR, relPath), "utf8");
  } catch {
    return "";
  }
}

function _readTextReport(name) {
  try {
    return fs.readFileSync(path.join(TXT_DIR, name), "utf8");
  } catch {
    return "";
  }
}

function _gitInfo() {
  const safe = (cmd) => {
    try {
      return execSync(cmd, { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  };
  return {
    branch: safe("git rev-parse --abbrev-ref HEAD"),
    sha: safe("git rev-parse --short HEAD"),
  };
}

/**
 * Load and parse all captured raw outputs into a single results object.
 * @returns {object}
 */
function loadResults() {
  const exitCodes = _readJson("exit-codes.json") || {};
  const eslint = P.parseEslint(_readJson("eslint.json"));
  const eslintTiming = P.parseEslintTiming(
    _readTextReport("eslint-timing.txt"),
  );
  const stylelint = P.parseStylelint(_readJson("stylelint.json"));
  const htmlValidate = P.parseHtmlValidate(_readJson("html-validate.json"));
  // html-validate's JSON reporter omits clean files, so use the count
  // captured by check.sh from the glob instead of the parsed results[].length.
  if (exitCodes.htmlFileCount !== undefined) {
    htmlValidate.files = exitCodes.htmlFileCount;
  }
  const markdownlint = P.parseMarkdownlintText(
    _readTextReport("markdownlint.txt"),
  );
  const prettierJson = P.parsePrettierJsonText(
    _readTextReport("prettier-json.txt"),
  );
  const npmAudit = P.parseNpmAudit(_readJson("npm-audit.json"));
  const securityLintRaw = _readJson("security-lint.json");
  const securityLint = P.parseEslint(securityLintRaw);
  const secretlint = P.parseSecretlint(_readJson("secretlint.json"));
  const tests = P.parseTapTests(_readText("tests.tap"));

  // Rule counts from --print-config dumps. eslint.json, stylelint.json,
  // and security-lint.json only know about rules that fired; for the true
  // "rules loaded" count we read the resolved-config dumps that check.sh
  // captures alongside the regular lint output. html-validate and
  // markdownlint don't have an equivalent, so their rule counts stay null
  // → rendered as "—".
  const eslintRules = P.parseConfigRuleCount(_readJson("eslint-config.json"));
  const stylelintRules = P.parseConfigRuleCount(
    _readJson("stylelint-config.json"),
  );
  const securityLintRules = P.parseConfigRuleCount(
    _readJson("security-lint-config.json"),
  );
  if (eslintRules !== null) eslint.rules = eslintRules;
  stylelint.rules = stylelintRules;
  if (securityLintRules !== null) securityLint.rules = securityLintRules;
  htmlValidate.rules = null;
  markdownlint.rules = null;

  const minCoverage = 80;
  const coverageOk = tests.coverage !== null && tests.coverage >= minCoverage;

  // Format a rule count as "N rules" or "— rules" so every detail string
  // reads identically whether the count is known or not.
  const _rulesFrag = (n) =>
    n === null || n === undefined ? "— rules" : `${n} rules`;

  const checks = {
    eslint: {
      ok: exitCodes.eslint === 0,
      detail: `${eslint.errors} err, ${eslint.warnings} warn, ${eslint.files} files, ${_rulesFrag(eslint.rules)}`,
    },
    stylelint: {
      ok: exitCodes.stylelint === 0,
      detail: `${stylelint.errors} err, ${stylelint.warnings} warn, ${stylelint.files} files, ${_rulesFrag(stylelint.rules)}`,
    },
    htmlValidate: {
      ok: exitCodes.htmlValidate === 0,
      detail: `${htmlValidate.errors} err, ${htmlValidate.warnings} warn, ${htmlValidate.files} files, ${_rulesFrag(htmlValidate.rules)}`,
    },
    markdownlint: {
      ok: exitCodes.markdownlint === 0,
      detail: `${markdownlint.errors} violations, ${_rulesFrag(markdownlint.rules)}`,
    },
    prettierJson: {
      ok: exitCodes.prettierJson === 0,
      detail:
        prettierJson.dirty === 0
          ? `0 violations, formatting clean`
          : `${prettierJson.dirty} files need formatting — run \`npm run lint:fix\``,
    },
    tests: {
      ok: exitCodes.tests === 0,
      detail:
        `${tests.pass}/${tests.tests} passed, ${tests.suites} suites, ` +
        `${(tests.duration / 1000).toFixed(1)}s`,
    },
    coverage: {
      ok: coverageOk,
      detail:
        tests.coverage !== null
          ? `${tests.coverage.toFixed(1)}% lines (min ${minCoverage}%)`
          : "unavailable",
    },
    npmAudit: {
      ok: exitCodes.auditDeps === 0,
      detail: `${npmAudit.total} advisories`,
    },
    securityLint: {
      ok: exitCodes.securityLint === 0,
      detail: `${securityLint.errors} err, ${_rulesFrag(securityLint.rules)}, ${securityLint.files} files`,
    },
    secretlint: {
      ok: exitCodes.secretlint === 0,
      detail: `${secretlint.findings} findings, ${secretlint.files} files`,
    },
  };

  const ok = Object.values(checks).every((c) => c.ok);
  const overviewRows = [
    { name: "ESLint (JS)", ...checks.eslint },
    { name: "stylelint (CSS)", ...checks.stylelint },
    { name: "html-validate", ...checks.htmlValidate },
    { name: "markdownlint", ...checks.markdownlint },
    { name: "Prettier (JSON)", ...checks.prettierJson },
    { name: "Tests", ...checks.tests },
    { name: "Coverage", ...checks.coverage },
    { name: "npm audit", ...checks.npmAudit },
    { name: "security-lint", ...checks.securityLint },
    { name: "secretlint", ...checks.secretlint },
  ];

  const git = _gitInfo();
  return {
    ok,
    generatedAt:
      new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
    gitBranch: git.branch,
    gitSha: git.sha,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    eslint,
    eslintTiming,
    stylelint,
    htmlValidate,
    markdownlint,
    prettierJson,
    npmAudit,
    securityLint,
    secretlint,
    tests,
    overviewRows,
  };
}

function renderTerminal(data) {
  const status = data.ok
    ? `${_GREEN}✔ PASS${_RESET}`
    : `${_RED}✘ FAIL${_RESET}`;
  const rule = "━".repeat(60);
  console.log();
  console.log(rule);
  console.log(`  ${status}`);
  console.log(rule);
  console.log();

  const table = new Table({
    head: ["Check", "Result", "Detail"],
    style: { head: ["cyan"], border: ["grey"] },
    colWidths: [20, 10, 60],
    wordWrap: true,
  });
  for (const row of data.overviewRows) {
    const sym = row.ok ? `${_GREEN}✔ pass${_RESET}` : `${_RED}✘ fail${_RESET}`;
    table.push([row.name, sym, `${_DIM}${row.detail}${_RESET}`]);
  }
  console.log(table.toString());

  if (data.eslintTiming.length) {
    console.log();
    console.log(`${_CYAN}Slowest ESLint rules:${_RESET}`);
    for (const t of data.eslintTiming) {
      console.log(
        `  ${t.rule.padEnd(40)} ${t.ms.toFixed(1).padStart(7)} ms   ${t.pct.toFixed(1)}%`,
      );
    }
  }

  if (data.tests.slowest.length) {
    console.log();
    console.log(`${_CYAN}Slowest tests:${_RESET}`);
    for (const t of data.tests.slowest) {
      const name = t.name.length > 50 ? t.name.slice(0, 47) + "..." : t.name;
      console.log(
        `  ${name.padEnd(50)} ${t.duration.toFixed(1).padStart(8)} ms`,
      );
    }
  }

  if (data.tests.failures.length) {
    console.log();
    console.log(`${_RED}Failures:${_RESET}`);
    for (const f of data.tests.failures) {
      console.log(`  ${_RED}✘${_RESET} ${f.name}`);
    }
  }

  console.log();
  console.log(`${_DIM}Reports: ${REPORT_DIR}/${_RESET}`);
  console.log(
    `${_DIM}  text-reports/  raw-data/  report.pdf  tests.tap${_RESET}`,
  );
  console.log(`${_DIM}  View PDF:  npm run view-report${_RESET}`);
  console.log();
}

function writeSummaryTxt(data) {
  // Plain-text version (no ANSI colors) suitable for piping into grep/less.
  // cli-table3 colors its borders and headers by default — pass empty style
  // arrays to strip every color code out of the output.
  const table = new Table({
    head: ["Check", "Result", "Detail"],
    colWidths: [20, 8, 60],
    wordWrap: true,
    style: { head: [], border: [] },
  });
  for (const row of data.overviewRows) {
    table.push([row.name, row.ok ? "pass" : "fail", row.detail]);
  }
  const lines = [
    "npm run check — summary",
    `Generated: ${data.generatedAt}`,
    `Branch:    ${data.gitBranch}  ${data.gitSha}`,
    `Node:      ${data.nodeVersion}  ${data.platform}`,
    `Overall:   ${data.ok ? "PASS" : "FAIL"}`,
    "",
    table.toString(),
    "",
  ];
  if (data.eslintTiming.length) {
    lines.push("Slowest ESLint rules:");
    for (const t of data.eslintTiming) {
      lines.push(
        `  ${t.rule.padEnd(40)} ${t.ms.toFixed(1).padStart(7)} ms  ${t.pct.toFixed(1)}%`,
      );
    }
    lines.push("");
  }
  fs.mkdirSync(TXT_DIR, { recursive: true });
  fs.writeFileSync(path.join(TXT_DIR, "summary.txt"), lines.join("\n"));
}

function writeTestsSummaryTxt(data) {
  const t = data.tests;
  const lines = [
    "Tests summary",
    "",
    `Tests:    ${t.pass}/${t.tests} passed (${t.fail} failed)`,
    `Suites:   ${t.suites}`,
    `Duration: ${(t.duration / 1000).toFixed(2)}s`,
    `Coverage: ${t.coverage !== null ? t.coverage.toFixed(2) + "%" : "unavailable"}`,
    "",
  ];
  if (t.slowest.length) {
    lines.push("Slowest tests:");
    for (const s of t.slowest) {
      lines.push(`  ${s.duration.toFixed(1).padStart(8)} ms  ${s.name}`);
    }
    lines.push("");
  }
  if (t.failures.length) {
    lines.push("Failures:");
    for (const f of t.failures) lines.push(`  ✘ ${f.name}`);
    lines.push("");
  }
  fs.mkdirSync(TXT_DIR, { recursive: true });
  fs.writeFileSync(path.join(TXT_DIR, "tests-summary.txt"), lines.join("\n"));
}

/**
 * Write GitHub-flavored markdown rollup to text-reports/summary.md.
 * CI appends this file to $GITHUB_STEP_SUMMARY so the check rollup is
 * rendered inline on every workflow run page.
 */
function writeSummaryMd(data) {
  fs.mkdirSync(TXT_DIR, { recursive: true });
  fs.writeFileSync(path.join(TXT_DIR, "summary.md"), renderMarkdown(data));
}

async function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error(
      `[check-report] ${RAW_DIR} not found — run \`npm run check\` first.`,
    );
    process.exit(1);
  }
  const data = loadResults();
  renderTerminal(data);
  writeSummaryTxt(data);
  writeTestsSummaryTxt(data);
  writeSummaryMd(data);
  try {
    await renderPdf(data, path.join(REPORT_DIR, "report.pdf"));
  } catch (err) {
    console.error(`[check-report] PDF render failed: ${err.message}`);
    // Don't fail the whole run just because the PDF couldn't be written —
    // the txt summaries and terminal output are already on disk.
  }
  process.exit(data.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadResults,
  renderTerminal,
  writeSummaryTxt,
  writeTestsSummaryTxt,
  writeSummaryMd,
};
