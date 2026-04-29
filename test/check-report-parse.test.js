"use strict";

/**
 * @file test/check-report-parse.test.js
 * @description Unit tests for the pure parsers in scripts/check-report-parse.js.
 * Feeds representative fixture strings/objects into each parser and asserts
 * the shape of the returned summary. No filesystem access, no subprocess.
 */

const { describe, it } = require("node:test");
const assert = require("assert");
const P = require("../scripts/check-report-parse");

describe("check-report-parse: parseEslint", () => {
  it("sums errors, warnings, files across results", () => {
    const json = {
      results: [
        {
          errorCount: 2,
          warningCount: 1,
          fixableErrorCount: 1,
          fixableWarningCount: 0,
        },
        {
          errorCount: 0,
          warningCount: 3,
          fixableErrorCount: 0,
          fixableWarningCount: 2,
        },
      ],
      metadata: { rulesMeta: { "a/b": {}, "c/d": {}, "e/f": {} } },
    };
    const r = P.parseEslint(json);
    assert.equal(r.errors, 2);
    assert.equal(r.warnings, 4);
    assert.equal(r.files, 2);
    assert.equal(r.rules, 3);
    assert.equal(r.fixable, 3);
  });

  it("handles null input", () => {
    const r = P.parseEslint(null);
    assert.equal(r.errors, 0);
    assert.equal(r.warnings, 0);
    assert.equal(r.files, 0);
  });

  it("handles legacy plain-array shape (no metadata)", () => {
    const json = [
      { errorCount: 5, warningCount: 0 },
      { errorCount: 0, warningCount: 2 },
    ];
    const r = P.parseEslint(json);
    assert.equal(r.errors, 5);
    assert.equal(r.warnings, 2);
    assert.equal(r.files, 2);
    assert.equal(r.rules, 0);
  });
});

describe("check-report-parse: parseEslintTiming", () => {
  it("extracts rule name, ms, and percentage", () => {
    const txt = `
Rule                        | Time (ms) | Relative
:---------------------------|----------:|--------:
complexity                  |   125.432 |    30.2%
no-unused-vars              |    80.100 |    19.3%
9mm/no-secret-logging       |    42.000 |    10.1%
`;
    const out = P.parseEslintTiming(txt);
    assert.equal(out.length, 3);
    assert.equal(out[0].rule, "complexity");
    assert.ok(out[0].ms > 125 && out[0].ms < 126);
    assert.equal(out[0].pct, 30.2);
    assert.equal(out[2].rule, "9mm/no-secret-logging");
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(P.parseEslintTiming(""), []);
  });

  it("caps at 5 entries", () => {
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`rule${i}            |   ${i}.000 |    1.0%`);
    }
    const out = P.parseEslintTiming(lines.join("\n"));
    assert.equal(out.length, 5);
  });
});

describe("check-report-parse: parseStylelint", () => {
  it("counts errors and warnings across files", () => {
    const json = [
      {
        source: "a.css",
        warnings: [{ severity: "error" }, { severity: "warning" }],
      },
      { source: "b.css", warnings: [{ severity: "error" }] },
    ];
    const r = P.parseStylelint(json);
    assert.equal(r.errors, 2);
    assert.equal(r.warnings, 1);
    assert.equal(r.files, 2);
  });

  it("handles empty array", () => {
    assert.deepEqual(P.parseStylelint([]), {
      files: 0,
      errors: 0,
      warnings: 0,
    });
  });

  it("handles null", () => {
    assert.deepEqual(P.parseStylelint(null), {
      files: 0,
      errors: 0,
      warnings: 0,
    });
  });
});

describe("check-report-parse: parseHtmlValidate", () => {
  it("handles result-wrapped format", () => {
    const json = {
      results: [
        { errorCount: 1, warningCount: 2 },
        { errorCount: 0, warningCount: 0 },
      ],
    };
    const r = P.parseHtmlValidate(json);
    assert.equal(r.errors, 1);
    assert.equal(r.warnings, 2);
    assert.equal(r.files, 2);
  });

  it("handles plain-array format", () => {
    const json = [{ errorCount: 3, warningCount: 1 }];
    const r = P.parseHtmlValidate(json);
    assert.equal(r.errors, 3);
    assert.equal(r.warnings, 1);
    assert.equal(r.files, 1);
  });
});

describe("check-report-parse: parseMarkdownlintText", () => {
  it("counts MD-rule violations", () => {
    const txt = `
README.md:10:1 MD013/line-length Line length
README.md:20:1 MD022/blanks-around-headings Headings should be surrounded by blank lines
docs/foo.md:5:1 MD034/no-bare-urls Bare URL used
not a violation line
`;
    const r = P.parseMarkdownlintText(txt);
    assert.equal(r.errors, 3);
    assert.equal(r.firstLines.length, 3);
  });

  it("handles empty input", () => {
    assert.deepEqual(P.parseMarkdownlintText(""), {
      errors: 0,
      firstLines: [],
    });
  });
});

describe("check-report-parse: parsePrettierJsonText", () => {
  it("counts per-file [warn] lines and ignores the summary line", () => {
    const txt = [
      "Checking formatting...",
      "[warn] .mcp.json",
      "[warn] docs/openapi.json",
      "[warn] Code style issues found in 2 files. Run Prettier with --write to fix.",
    ].join("\n");
    const r = P.parsePrettierJsonText(txt);
    assert.equal(r.dirty, 2);
    assert.equal(r.firstLines.length, 2);
    assert.ok(r.firstLines[0].includes(".mcp.json"));
  });

  it("returns 0 dirty for clean output", () => {
    const txt = [
      "Checking formatting...",
      "All matched files use Prettier code style!",
    ].join("\n");
    const r = P.parsePrettierJsonText(txt);
    assert.equal(r.dirty, 0);
    assert.deepEqual(r.firstLines, []);
  });

  it("handles empty input", () => {
    assert.deepEqual(P.parsePrettierJsonText(""), {
      dirty: 0,
      firstLines: [],
    });
  });

  it("caps firstLines at 5", () => {
    const lines = ["Checking formatting..."];
    for (let i = 0; i < 8; i++) lines.push(`[warn] file${i}.json`);
    lines.push("[warn] Code style issues found in 8 files.");
    const r = P.parsePrettierJsonText(lines.join("\n"));
    assert.equal(r.dirty, 8);
    assert.equal(r.firstLines.length, 5);
  });
});

describe("check-report-parse: parseNpmAudit", () => {
  it("sums severity counts", () => {
    const json = {
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 2,
          moderate: 1,
          high: 0,
          critical: 0,
        },
      },
    };
    const r = P.parseNpmAudit(json);
    assert.equal(r.total, 3);
    assert.equal(r.bySeverity.moderate, 1);
    assert.equal(r.bySeverity.low, 2);
  });

  it("handles missing metadata", () => {
    assert.equal(P.parseNpmAudit({}).total, 0);
    assert.equal(P.parseNpmAudit(null).total, 0);
  });
});

describe("check-report-parse: parseSecretlint", () => {
  it("counts findings across files", () => {
    const json = [
      { filePath: "a.js", messages: [{ ruleId: "x" }] },
      { filePath: "b.js", messages: [] },
      { filePath: "c.js", messages: [{ ruleId: "y" }, { ruleId: "z" }] },
    ];
    const r = P.parseSecretlint(json);
    assert.equal(r.files, 3);
    assert.equal(r.findings, 3);
  });

  it("handles empty", () => {
    assert.deepEqual(P.parseSecretlint([]), { files: 0, findings: 0 });
    assert.deepEqual(P.parseSecretlint(null), { files: 0, findings: 0 });
  });
});

describe("check-report-parse: parseTapTests", () => {
  it("extracts totals, per-test durations, and failures", () => {
    const tap = `TAP version 13
ok 1 - test alpha
  ---
  duration_ms: 12.34
  type: 'test'
  ...
ok 2 - test beta
  ---
  duration_ms: 500.5
  type: 'test'
  ...
not ok 3 - test gamma
  ---
  duration_ms: 3.0
  type: 'test'
  ...
1..3
# tests 3
# suites 1
# pass 2
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1234.5
`;
    const r = P.parseTapTests(tap);
    assert.equal(r.tests, 3);
    assert.equal(r.pass, 2);
    assert.equal(r.fail, 1);
    assert.equal(r.suites, 1);
    assert.equal(r.duration, 1234.5);
    assert.equal(r.slowest[0].name, "test beta");
    assert.ok(r.slowest[0].duration > 500);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].name, "test gamma");
  });

  it("returns empty object for empty input", () => {
    const r = P.parseTapTests("");
    assert.equal(r.tests, 0);
    assert.equal(r.pass, 0);
    assert.equal(r.fail, 0);
    assert.deepEqual(r.slowest, []);
    assert.deepEqual(r.failures, []);
  });

  it("parses coverage 'all files' comment line", () => {
    const tap = `ok 1 - stub
  ---
  duration_ms: 1
  type: 'test'
  ...
1..1
# tests 1
# pass 1
# fail 0
# duration_ms 5
# all files                    |  85.42 |    70.10 |   90.00
`;
    const r = P.parseTapTests(tap);
    assert.equal(r.coverage, 85.42);
  });

  it("skips 'suite' entries from slowest tests list", () => {
    const tap = `ok 1 - leaf alpha
  ---
  duration_ms: 10
  type: 'test'
  ...
ok 2 - parent suite
  ---
  duration_ms: 99999
  type: 'suite'
  ...
ok 3 - leaf beta
  ---
  duration_ms: 20
  type: 'test'
  ...
# tests 3
# pass 3
# fail 0
# duration_ms 99999
`;
    const r = P.parseTapTests(tap);
    assert.equal(r.slowest.length, 2);
    assert.equal(r.slowest[0].name, "leaf beta");
    assert.equal(r.slowest[1].name, "leaf alpha");
  });

  it("ignores 'all files' appearing inside a subtest name", () => {
    // Regression: the initial parser matched any line containing "all files",
    // picking up subtest names like this one and producing bogus coverage
    // values from unrelated numbers in the line.
    const tap = `    # Subtest: parses coverage 'all files' comment line
    ok 3 - parses coverage 'all files' comment line
# tests 1
# pass 1
# fail 0
# duration_ms 5
`;
    const r = P.parseTapTests(tap);
    assert.equal(r.coverage, null);
  });
});
