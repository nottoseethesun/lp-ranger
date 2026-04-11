/**
 * @file scripts/check-report-md.js
 * @description
 * Render the aggregated check results as GitHub-flavored markdown.
 * The output is written to `test/report-artifacts/text-reports/summary.md`
 * alongside the plain-text `summary.txt`, and CI appends it verbatim to
 * `$GITHUB_STEP_SUMMARY` so reviewers see the check rollup inline on every
 * workflow run page.
 */

"use strict";

/**
 * Convert a results object (from check-report.js `loadResults()`) into a
 * GitHub-flavored markdown string. Pure function — no filesystem access.
 * @param {object} data
 * @returns {string}
 */
function renderMarkdown(data) {
  // Filter out undefined/empty section returns (optional sections return "")
  // before joining, then add the fixed blank-line separators ourselves.
  const sections = [
    _header(data),
    _overview(data),
    _slowEslintRules(data),
    _slowTests(data),
    _failures(data),
    _security(data),
    _footer(),
  ].filter((s) => s && s.length > 0);
  return sections.join("\n\n") + "\n";
}

function _header(data) {
  const badge = data.ok ? "✅ **PASS**" : "❌ **FAIL**";
  return [
    "# npm run check — report",
    "",
    `${badge}`,
    "",
    [
      `**Branch:** \`${data.gitBranch}\``,
      `**Commit:** \`${data.gitSha}\``,
      `**Node:** \`${data.nodeVersion}\``,
      `**Platform:** \`${data.platform}\``,
      `**Generated:** \`${data.generatedAt}\``,
    ].join(" · "),
  ].join("\n");
}

function _overview(data) {
  const lines = [
    "## Overview",
    "",
    "| Check | Result | Detail |",
    "|---|---|---|",
  ];
  for (const row of data.overviewRows) {
    const icon = row.ok ? "✅ pass" : "❌ fail";
    // Escape pipe characters in detail so they don't break the table.
    const detail = String(row.detail).replace(/\|/g, "\\|");
    lines.push(`| ${row.name} | ${icon} | ${detail} |`);
  }
  return lines.join("\n");
}

function _slowEslintRules(data) {
  if (!data.eslintTiming || !data.eslintTiming.length) return "";
  const lines = [
    "## Slowest ESLint rules",
    "",
    "| Rule | Duration | % |",
    "|---|---:|---:|",
  ];
  for (const t of data.eslintTiming) {
    lines.push(
      `| \`${t.rule}\` | ${t.ms.toFixed(1)} ms | ${t.pct.toFixed(1)}% |`,
    );
  }
  return lines.join("\n");
}

function _slowTests(data) {
  if (!data.tests.slowest || !data.tests.slowest.length) return "";
  const lines = ["## Slowest tests", "", "| Duration | Test |", "|---:|---|"];
  for (const t of data.tests.slowest) {
    // Markdown tables don't wrap — keep names reasonable.
    const name = t.name.length > 80 ? t.name.slice(0, 77) + "..." : t.name;
    lines.push(`| ${t.duration.toFixed(1)} ms | ${name} |`);
  }
  return lines.join("\n");
}

function _failures(data) {
  if (!data.tests.failures || !data.tests.failures.length) return "";
  const lines = ["## ❌ Test failures", ""];
  for (const f of data.tests.failures) {
    lines.push(`- \`${f.name}\``);
  }
  return lines.join("\n");
}

function _security(data) {
  const sev = data.npmAudit.bySeverity || {};
  const audit =
    data.npmAudit.total === 0
      ? "0 advisories"
      : `${data.npmAudit.total} advisories (` +
        `critical ${sev.critical || 0}, high ${sev.high || 0}, ` +
        `moderate ${sev.moderate || 0}, low ${sev.low || 0})`;
  return [
    "## Security",
    "",
    `- **npm audit:** ${audit}`,
    `- **security-lint:** ${data.securityLint.errors} errors, ` +
      `${data.securityLint.warnings} warnings, ${data.securityLint.files} files`,
    `- **secretlint:** ${data.secretlint.findings} findings, ` +
      `${data.secretlint.files} files`,
  ].join("\n");
}

function _footer() {
  return [
    "---",
    "",
    "<sub>Download the full report artifact (PDF + raw JSON + TAP + text reports) " +
      "from the **Artifacts** section of this run.</sub>",
  ].join("\n");
}

module.exports = { renderMarkdown };
