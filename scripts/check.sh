#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check.sh — Run lint + tests + coverage + security audits and emit a full
# report of the results.
#
# Outputs (all under test/report-artifacts/, gitignored):
#   raw-data/*.json            Machine-readable tool outputs (eslint,
#                              stylelint, html-validate, npm audit,
#                              security-lint, secretlint, plus
#                              exit-codes.json with every tool's exit code)
#   text-reports/summary.txt          Human-readable overview (cli-table3)
#   text-reports/tests-summary.txt    Parsed test rollup (slowest, failures)
#   text-reports/eslint-timing.txt    ESLint TIMING=1 slowest-rule capture
#   text-reports/markdownlint.txt     markdownlint-cli2 text output
#   tests.tap                  Raw TAP v14 from `node --test`
#   report.pdf                 Unified PDF of all results (pdfmake)
#
# After capturing raw outputs this script defers to
# scripts/check-report.js to parse, print the terminal summary, and write
# summary.txt + tests-summary.txt + report.pdf. The aggregator's exit code
# (0 = all checks green, 1 = at least one failed) becomes this script's
# exit code — so GitHub CI still fails on any red result.
#
# See the "Check report artifacts" section of server.js for the full layout
# and regeneration workflow.
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail

REPORT_DIR="test/report-artifacts"
RAW_DIR="$REPORT_DIR/raw-data"
TXT_DIR="$REPORT_DIR/text-reports"

# Clean prior outputs so stale artifacts don't leak into a new run.
rm -rf "$REPORT_DIR"
mkdir -p "$RAW_DIR" "$TXT_DIR"

# ── Lint (JS) ────────────────────────────────────────────────────────────────
# TIMING=1 writes the slowest-rules table to stdout *after* the JSON blob
# (which is itself a single line). Capture the combined stream, then split:
# line 1 is the JSON, lines 2+ are the TIMING table.
_eslint_tmp=$(mktemp)
TIMING=1 ./node_modules/.bin/eslint \
  src/ test/ server.js bot.js public/dashboard-*.js eslint-rules/ \
  --max-warnings 0 --format json-with-metadata \
  > "$_eslint_tmp" 2>/dev/null
eslint_exit=$?
head -n 1 "$_eslint_tmp" > "$RAW_DIR/eslint.json"
tail -n +2 "$_eslint_tmp" > "$TXT_DIR/eslint-timing.txt"
rm -f "$_eslint_tmp"

# ── Lint (CSS) ───────────────────────────────────────────────────────────────
# stylelint's json formatter writes to stderr when stdout is redirected —
# use --output-file to pipe directly to the raw-data file.
./node_modules/.bin/stylelint public/*.css --formatter json \
  -o "$RAW_DIR/stylelint.json" >/dev/null 2>&1
stylelint_exit=$?
[ -s "$RAW_DIR/stylelint.json" ] || echo "[]" > "$RAW_DIR/stylelint.json"

# ── Lint (HTML) ──────────────────────────────────────────────────────────────
./node_modules/.bin/html-validate -f json public/*.html \
  > "$RAW_DIR/html-validate.json" 2>/dev/null
htmlvalidate_exit=$?
# Count the scanned HTML files ourselves — html-validate's JSON reporter
# omits clean files entirely, so we can't derive a file count from it.
html_file_count=$(ls public/*.html 2>/dev/null | wc -l)

# ── Lint (Markdown) ──────────────────────────────────────────────────────────
# markdownlint-cli2 has no native JSON reporter — capture stylish text.
./node_modules/.bin/markdownlint-cli2 \
  README.md CLAUDE.md docs/CLAUDE-SECURITY.md \
  > "$TXT_DIR/markdownlint.txt" 2>&1
markdownlint_exit=$?

# ── Security: npm audit ─────────────────────────────────────────────────────
# Keep --audit-level=high so moderate pre-existing advisories don't fail the
# check, but store the full report for review.
npm audit --audit-level=high --json \
  > "$RAW_DIR/npm-audit.json" 2>/dev/null
audit_deps_exit=$?

# ── Security: eslint-security rules ──────────────────────────────────────────
./node_modules/.bin/eslint -c eslint-security.config.js src/ server.js bot.js \
  --max-warnings 0 --format json \
  > "$RAW_DIR/security-lint.json" 2>/dev/null
security_lint_exit=$?

# ── Security: secretlint ─────────────────────────────────────────────────────
./node_modules/.bin/secretlint \
  'src/**/*.js' 'server.js' 'bot.js' '.env*' '*.json' \
  --format json --output "$RAW_DIR/secretlint.json" 2>/dev/null
secretlint_exit=$?
# secretlint --output produces the file but may return non-zero on findings;
# an empty file with exit 0 means clean. Normalise: ensure the file exists.
[ -f "$RAW_DIR/secretlint.json" ] || echo "[]" > "$RAW_DIR/secretlint.json"

# ── Backup production files before tests ─────────────────────────────────────
# Everything the app manages as runtime state lives in app-config/ (top level).
# static-tunables/ and api-keys.example.json are tracked repo files — leave
# them alone. tmp/ is all pure performance caches. See the `app-config/` section
# of server.js for the full layout.
_BACKUP_DIR=$(mktemp -d)
mkdir -p "$_BACKUP_DIR/app-config"
if [ -d app-config ]; then
  find app-config -maxdepth 1 -type f ! -name api-keys.example.json \
    -exec cp {} "$_BACKUP_DIR/app-config/" \;
fi
# Backup all tmp/*.json files (preserves per-pool event caches, symbol cache, etc.)
mkdir -p "$_BACKUP_DIR/tmp"
for _f in tmp/*.json; do
  [ -f "$_f" ] && cp "$_f" "$_BACKUP_DIR/tmp/$(basename "$_f")"
done

# Replace with vanilla state — delete runtime app-config files and tmp files
# so the code creates fresh defaults. Leave static-tunables/ and the
# api-keys.example.json template alone.
if [ -d app-config ]; then
  find app-config -maxdepth 1 -type f ! -name api-keys.example.json -delete
fi
rm -f tmp/*.json

_restore_prod_files() {
  # Wipe any test-created runtime files at the top of app-config/, then copy
  # backed-up originals back. static-tunables/ is untouched throughout.
  if [ -d app-config ]; then
    find app-config -maxdepth 1 -type f ! -name api-keys.example.json -delete
  fi
  if [ -d "$_BACKUP_DIR/app-config" ]; then
    find "$_BACKUP_DIR/app-config" -maxdepth 1 -type f \
      -exec cp {} app-config/ \;
  fi
  # Restore tmp/*.json — remove any test-created files, restore originals
  for _f in tmp/*.json; do
    [ -f "$_f" ] && rm "$_f"
  done
  for _bk in "$_BACKUP_DIR"/tmp/*.json; do
    [ -f "$_bk" ] && cp "$_bk" "tmp/$(basename "$_bk")"
  done
  rm -rf "$_BACKUP_DIR"
}
trap _restore_prod_files EXIT

# ── Tests + Coverage ─────────────────────────────────────────────────────────
# Force --test-reporter=tap so the output is deterministic TAP v14 regardless
# of Node version or TTY state. The aggregator parses tests.tap for totals,
# per-test timings, failures, and the coverage block at the end.
node --test --experimental-test-coverage --test-reporter=tap test/*.test.js \
  > "$REPORT_DIR/tests.tap" 2>&1
tests_exit=$?

# Restore happens automatically via EXIT trap (_restore_prod_files).

# ── Write exit codes + file counts for the aggregator ───────────────────────
cat > "$RAW_DIR/exit-codes.json" <<EOF
{
  "eslint": $eslint_exit,
  "stylelint": $stylelint_exit,
  "htmlValidate": $htmlvalidate_exit,
  "markdownlint": $markdownlint_exit,
  "auditDeps": $audit_deps_exit,
  "securityLint": $security_lint_exit,
  "secretlint": $secretlint_exit,
  "tests": $tests_exit,
  "htmlFileCount": $html_file_count
}
EOF

# ── Aggregate + print summary + write PDF ────────────────────────────────────
# The aggregator prints the terminal overview, writes summary.txt +
# tests-summary.txt + report.pdf, and exits 0 only if every check is green.
node scripts/check-report.js
exit $?
