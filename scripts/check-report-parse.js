/**
 * @file scripts/check-report-parse.js
 * @description
 * Pure parsers for raw tool outputs written by scripts/check.sh into
 * test/report-artifacts/raw-data/. Every parser is a small function that
 * takes the already-loaded JSON or text and returns a plain object of the
 * shape used by the aggregator in check-report.js. Kept separate from the
 * orchestrator so the parsers stay trivial to test in isolation.
 */

"use strict";

/**
 * Parse ESLint `--format json-with-metadata` output.
 * Works with the v10 shape `{ results, metadata: { rulesMeta } }` and the
 * legacy plain-array shape.
 * @param {object|Array|null} json
 * @returns {{ files:number, errors:number, warnings:number, rules:number, fixable:number }}
 */
function parseEslint(json) {
  if (!json) return { files: 0, errors: 0, warnings: 0, rules: 0, fixable: 0 };
  const results = Array.isArray(json) ? json : json.results || [];
  const meta = (!Array.isArray(json) && json.metadata) || {};
  const rules = meta.rulesMeta ? Object.keys(meta.rulesMeta).length : 0;
  let errors = 0;
  let warnings = 0;
  let fixable = 0;
  for (const r of results) {
    errors += r.errorCount || 0;
    warnings += r.warningCount || 0;
    fixable += (r.fixableErrorCount || 0) + (r.fixableWarningCount || 0);
  }
  return { files: results.length, errors, warnings, rules, fixable };
}

/**
 * Parse the ESLint `TIMING=1` slowest-rules table emitted on stderr.
 * Returns up to the top 5 slowest rules (already pre-sorted by ESLint).
 * @param {string} txt  Raw TIMING capture.
 * @returns {Array<{rule:string, ms:number, pct:number}>}
 */
function parseEslintTiming(txt) {
  if (!txt) return [];
  const out = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/^([\w/@.-]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)%/);
    if (m) {
      out.push({
        rule: m[1],
        ms: parseFloat(m[2]),
        pct: parseFloat(m[3]),
      });
    }
  }
  return out.slice(0, 5);
}

/**
 * Parse stylelint `--formatter json` output (array of file results).
 * @param {Array|null} json
 * @returns {{ files:number, errors:number, warnings:number }}
 */
function parseStylelint(json) {
  if (!Array.isArray(json)) return { files: 0, errors: 0, warnings: 0 };
  let errors = 0;
  let warnings = 0;
  for (const r of json) {
    for (const w of r.warnings || []) {
      if (w.severity === "error") errors++;
      else warnings++;
    }
  }
  return { files: json.length, errors, warnings };
}

/**
 * Parse html-validate `-f json` output.
 * @param {object|Array|null} json
 * @returns {{ files:number, errors:number, warnings:number }}
 */
function parseHtmlValidate(json) {
  if (!json) return { files: 0, errors: 0, warnings: 0 };
  const results = Array.isArray(json) ? json : json.results || [];
  let errors = 0;
  let warnings = 0;
  for (const r of results) {
    errors += r.errorCount || 0;
    warnings += r.warningCount || 0;
  }
  return { files: results.length, errors, warnings };
}

/**
 * Parse markdownlint-cli2 text output. It has no native JSON reporter, so
 * we count lines matching the standard violation format.
 * @param {string} txt
 * @returns {{ errors:number, firstLines:string[] }}
 */
function parseMarkdownlintText(txt) {
  if (!txt) return { errors: 0, firstLines: [] };
  const lines = txt.split("\n").filter(Boolean);
  const violations = lines.filter((l) => /MD\d{3}\//.test(l));
  return {
    errors: violations.length,
    firstLines: violations.slice(0, 5),
  };
}

/**
 * Count the active rules in a resolved-config dump from either
 * `eslint --print-config` or `stylelint --print-config`. Both tools emit
 * a JSON object whose `rules` key is a map of rule-name → settings; a
 * simple Object.keys() over that map is the accurate rule count after
 * all plugins and extends have been merged.
 *
 * `eslint.json` and `stylelint.json` (the regular lint output) cannot be
 * used for this — their `metadata.rulesMeta` only includes rules that
 * actually fired during the run, so a clean lint pass shows 0 rules.
 * @param {object|null} json  Parsed `*-config.json` dump.
 * @returns {number|null}  Rule count, or null if unavailable.
 */
function parseConfigRuleCount(json) {
  if (!json || typeof json !== "object" || !json.rules) return null;
  return Object.keys(json.rules).length;
}

/**
 * Parse npm audit `--json` output. Pulls the severity breakdown and total
 * vulnerability count from metadata.
 * @param {object|null} json
 * @returns {{ total:number, bySeverity:object }}
 */
function parseNpmAudit(json) {
  if (!json) return { total: 0, bySeverity: {} };
  const meta = (json.metadata && json.metadata.vulnerabilities) || {};
  const total = ["info", "low", "moderate", "high", "critical"].reduce(
    (a, k) => a + (meta[k] || 0),
    0,
  );
  return { total, bySeverity: meta };
}

/**
 * Parse secretlint `--format json` output (array of file results each with
 * a messages[] array of findings).
 * @param {Array|null} json
 * @returns {{ files:number, findings:number }}
 */
function parseSecretlint(json) {
  if (!Array.isArray(json)) return { files: 0, findings: 0 };
  let findings = 0;
  for (const r of json) findings += (r.messages || []).length;
  return { files: json.length, findings };
}

/**
 * Parse node:test TAP v14 output.
 * Extracts top-level totals, per-test durations, failure messages, and the
 * coverage block printed as `# ----` comments at the end of the file.
 *
 * Each `ok N - name` line is followed by a YAML block that includes both
 * `duration_ms:` and `type: 'test'` or `type: 'suite'`. We include only
 * `type: 'test'` entries in the slowest list so the list is actual leaf
 * tests, not parent suites whose duration is the sum of their children.
 * @param {string} txt
 * @returns {object}
 */
function parseTapTests(txt) {
  if (!txt) return _emptyTap();
  const lines = txt.split("\n");
  const totals = {};
  const tests = [];
  const failures = [];
  let current = null;
  for (const line of lines) {
    const tot = line.match(
      /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)/,
    );
    if (tot) {
      totals[tot[1]] = parseFloat(tot[2]);
      continue;
    }
    // eslint-disable-next-line security/detect-unsafe-regex -- Safe: input is deterministic TAP v14 from node --test
    const tm = line.match(/^(\s*)(ok|not ok) \d+ - (.+?)(?:\s*#.*)?$/);
    if (tm) {
      current = {
        name: tm[3],
        pass: tm[2] === "ok",
        duration: 0,
        type: null,
        indent: tm[1].length,
      };
      tests.push(current);
      if (!current.pass) failures.push(current);
      continue;
    }
    if (current) {
      const dm = line.match(/^\s*duration_ms:\s*([\d.]+)/);
      if (dm && current.duration === 0) {
        current.duration = parseFloat(dm[1]);
      }
      const typeMatch = line.match(/^\s*type:\s*'?(\w+)'?/);
      if (typeMatch && !current.type) current.type = typeMatch[1];
    }
  }
  const leafTests = tests.filter((t) => t.type === "test");
  const slowest = [...leafTests]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);
  const leafFailures = failures.filter(
    (f) => f.type === "test" || f.type === null,
  );
  return {
    tests: totals.tests || 0,
    pass: totals.pass || 0,
    fail: totals.fail || 0,
    suites: totals.suites || 0,
    duration: totals.duration_ms || 0,
    coverage: _parseCoverageLine(lines),
    slowest,
    failures: leafFailures.slice(0, 10),
  };
}

function _emptyTap() {
  return {
    tests: 0,
    pass: 0,
    fail: 0,
    suites: 0,
    duration: 0,
    coverage: null,
    slowest: [],
    failures: [],
  };
}

function _parseCoverageLine(lines) {
  // Look for the actual coverage summary row, not an arbitrary line that
  // happens to mention "all files" (e.g. a test name in Subtest output).
  // The row looks like: `# all files         |  85.42 |    70.10 |   90.00 |`
  for (const line of lines) {
    const m = line.match(/^#\s*all files\s*\|\s*([\d.]+)/);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

module.exports = {
  parseEslint,
  parseEslintTiming,
  parseStylelint,
  parseHtmlValidate,
  parseMarkdownlintText,
  parseNpmAudit,
  parseSecretlint,
  parseTapTests,
  parseConfigRuleCount,
};
