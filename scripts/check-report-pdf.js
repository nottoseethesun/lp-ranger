/**
 * @file scripts/check-report-pdf.js
 * @description
 * Render the unified check report as a PDF using pdfmake. Consumes the
 * already-parsed results object produced by check-report.js and writes
 * test/report-artifacts/report.pdf. Roboto TTFs ship with pdfmake under
 * node_modules/pdfmake/build/fonts/Roboto/.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const pdfmake = require("pdfmake");

const _FONT_DIR = path.join(
  __dirname,
  "..",
  "node_modules",
  "pdfmake",
  "build",
  "fonts",
  "Roboto",
);

/**
 * Register Roboto with the pdfmake singleton. pdfmake 0.3.x reads the font
 * files via its virtual-fs layer — we copy them in by name so the declaration
 * `Roboto: { normal: 'Roboto-Regular.ttf', ... }` works.
 */
function _setupFonts() {
  const files = {
    "Roboto-Regular.ttf": "Roboto-Regular.ttf",
    "Roboto-Medium.ttf": "Roboto-Medium.ttf",
    "Roboto-Italic.ttf": "Roboto-Italic.ttf",
    "Roboto-MediumItalic.ttf": "Roboto-MediumItalic.ttf",
  };
  for (const [key, file] of Object.entries(files)) {
    pdfmake.virtualfs.writeFileSync(
      key,
      fs.readFileSync(path.join(_FONT_DIR, file)),
    );
  }
  pdfmake.setFonts({
    Roboto: {
      normal: "Roboto-Regular.ttf",
      bold: "Roboto-Medium.ttf",
      italics: "Roboto-Italic.ttf",
      bolditalics: "Roboto-MediumItalic.ttf",
    },
  });
  // Silence the "no URL access policy" warning — we never embed URLs.
  pdfmake.setUrlAccessPolicy(() => false);
}

const _PASS_COLOR = "#1fae4a";
const _FAIL_COLOR = "#c62828";
const _DIM_COLOR = "#6b7280";
const _HEADER_COLOR = "#0f172a";

let _fontsReady = false;

/**
 * Write a unified PDF report to the given path.
 * @param {object} data  Aggregated results from check-report.js
 * @param {string} outputPath  Absolute path to write the PDF to
 * @returns {Promise<void>}
 */
async function renderPdf(data, outputPath) {
  if (!_fontsReady) {
    _setupFonts();
    _fontsReady = true;
  }
  const docDefinition = _buildDoc(data);
  const doc = pdfmake.createPdf(docDefinition);
  await doc.write(outputPath);
}

function _buildDoc(data) {
  return {
    info: {
      title: "npm run check — report",
      author: "9mm v3 Position Manager",
    },
    defaultStyle: { font: "Roboto", fontSize: 9 },
    styles: {
      h1: {
        fontSize: 18,
        bold: true,
        color: _HEADER_COLOR,
        margin: [0, 0, 0, 6],
      },
      h2: {
        fontSize: 13,
        bold: true,
        color: _HEADER_COLOR,
        margin: [0, 14, 0, 4],
      },
      h3: { fontSize: 10, bold: true, margin: [0, 6, 0, 2] },
      meta: { fontSize: 9, color: _DIM_COLOR },
      pass: { color: _PASS_COLOR, bold: true },
      fail: { color: _FAIL_COLOR, bold: true },
      dim: { color: _DIM_COLOR },
      mono: { font: "Roboto", fontSize: 8 },
    },
    content: [
      ..._cover(data),
      ..._overviewSection(data),
      ..._lintSection(data),
      ..._testsSection(data),
      ..._securitySection(data),
    ],
    footer: (currentPage, pageCount) => ({
      text: `Page ${currentPage} of ${pageCount}`,
      alignment: "center",
      fontSize: 8,
      color: _DIM_COLOR,
      margin: [0, 10, 0, 0],
    }),
    pageMargins: [40, 40, 40, 40],
  };
}

function _cover(data) {
  const statusText = data.ok ? "PASS" : "FAIL";
  const statusStyle = data.ok ? "pass" : "fail";
  return [
    { text: "npm run check — report", style: "h1" },
    {
      columns: [
        { text: `Generated: ${data.generatedAt}`, style: "meta" },
        {
          text: `Branch: ${data.gitBranch}  ·  ${data.gitSha}`,
          style: "meta",
          alignment: "right",
        },
      ],
    },
    {
      text: `Node ${data.nodeVersion}  ·  ${data.platform}`,
      style: "meta",
      margin: [0, 0, 0, 8],
    },
    {
      text: statusText,
      style: statusStyle,
      fontSize: 28,
      alignment: "center",
      margin: [0, 6, 0, 12],
    },
  ];
}

function _overviewSection(data) {
  const body = [
    [
      { text: "Check", style: "h3" },
      { text: "Result", style: "h3" },
      { text: "Detail", style: "h3" },
    ],
  ];
  for (const row of data.overviewRows) {
    body.push([
      row.name,
      {
        text: row.ok ? "pass" : "fail",
        style: row.ok ? "pass" : "fail",
      },
      { text: row.detail, style: "dim" },
    ]);
  }
  return [
    { text: "Overview", style: "h2" },
    {
      table: { headerRows: 1, widths: [120, 50, "*"], body },
      layout: "lightHorizontalLines",
    },
  ];
}

function _lintSection(data) {
  const content = [{ text: "Lint", style: "h2" }];
  const lintRows = [
    [
      { text: "Tool", style: "h3" },
      { text: "Files", style: "h3" },
      { text: "Rules", style: "h3" },
      { text: "Errors", style: "h3" },
      { text: "Warnings", style: "h3" },
    ],
    _lintRow("ESLint (JS)", data.eslint),
    _lintRow("stylelint (CSS)", data.stylelint),
    _lintRow("html-validate", data.htmlValidate),
    _lintRow("markdownlint", {
      files: 3,
      errors: data.markdownlint.errors,
      warnings: 0,
      rules: null,
    }),
    _lintRow("Prettier (JSON)", {
      files: null,
      errors: data.prettierJson ? data.prettierJson.dirty : 0,
      warnings: 0,
      rules: null,
    }),
  ];
  content.push({
    table: { headerRows: 1, widths: [120, 50, 50, 50, 60], body: lintRows },
    layout: "lightHorizontalLines",
  });
  if (data.eslintTiming && data.eslintTiming.length) {
    content.push({ text: "Slowest ESLint rules", style: "h3" });
    const rows = [
      [
        { text: "Rule", style: "dim" },
        { text: "ms", style: "dim" },
        { text: "%", style: "dim" },
      ],
      ...data.eslintTiming.map((t) => [
        { text: t.rule, style: "mono" },
        t.ms.toFixed(1),
        `${t.pct.toFixed(1)}%`,
      ]),
    ];
    content.push({
      table: { headerRows: 1, widths: ["*", 50, 50], body: rows },
      layout: "noBorders",
    });
  }
  return content;
}

function _lintRow(name, d) {
  // `rules` is null for tools without a --print-config dump (html-validate,
  // markdownlint). `files` is null for tools that don't expose a per-glob
  // file count (Prettier --check). Render those as an em dash so the
  // column stays aligned instead of leaking "undefined" or "null".
  const rulesText =
    d.rules === null || d.rules === undefined ? "—" : String(d.rules);
  const filesText =
    d.files === null || d.files === undefined ? "—" : String(d.files);
  return [name, filesText, rulesText, String(d.errors), String(d.warnings)];
}

function _testsSection(data) {
  const t = data.tests;
  const content = [
    { text: "Tests", style: "h2" },
    {
      text: [
        { text: `${t.pass} passed`, style: t.fail === 0 ? "pass" : "dim" },
        { text: " / " },
        { text: `${t.fail} failed`, style: t.fail === 0 ? "dim" : "fail" },
        {
          text: `  ·  ${t.suites} suites  ·  ${(t.duration / 1000).toFixed(1)}s`,
        },
        {
          text: `  ·  coverage ${t.coverage !== null ? t.coverage.toFixed(1) + "%" : "—"}`,
          style: "dim",
        },
      ],
      margin: [0, 0, 0, 6],
    },
  ];
  if (t.slowest && t.slowest.length) {
    content.push({ text: "Slowest tests", style: "h3" });
    const rows = [
      [
        { text: "Test", style: "dim" },
        { text: "Duration", style: "dim" },
      ],
      ...t.slowest.map((s) => [
        { text: s.name, style: "mono" },
        `${s.duration.toFixed(1)} ms`,
      ]),
    ];
    content.push({
      table: { headerRows: 1, widths: ["*", 80], body: rows },
      layout: "noBorders",
    });
  }
  if (t.failures && t.failures.length) {
    content.push({ text: "Failures", style: "h3" });
    for (const f of t.failures) {
      content.push({ text: `✘ ${f.name}`, style: "fail", fontSize: 9 });
    }
  }
  return content;
}

function _securitySection(data) {
  const content = [{ text: "Security", style: "h2" }];
  const sev = data.npmAudit.bySeverity || {};
  const auditLine =
    data.npmAudit.total === 0
      ? "npm audit: 0 advisories"
      : `npm audit: ${data.npmAudit.total} advisories  ` +
        `(critical ${sev.critical || 0}, high ${sev.high || 0}, ` +
        `moderate ${sev.moderate || 0}, low ${sev.low || 0})`;
  content.push({ text: auditLine });
  content.push({
    text:
      `security-lint: ${data.securityLint.rules} rules loaded, ` +
      `${data.securityLint.errors} errors, ${data.securityLint.warnings} warnings`,
  });
  content.push({
    text:
      `secretlint: ${data.secretlint.files} files scanned, ` +
      `${data.secretlint.findings} findings`,
  });
  return content;
}

module.exports = { renderPdf };
