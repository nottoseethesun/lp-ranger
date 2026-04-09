#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# check.sh — Run lint + tests + coverage and print a concise summary.
# Exit code is 0 only when all pass (GitHub CI compatible).
#
# Coverage threshold: 80% line coverage required.
# ─────────────────────────────────────────────────────────────────────────────
set -o pipefail

GREEN='\033[1;32m'
RED='\033[1;31m'
DIM='\033[2m'
RESET='\033[0m'

MIN_COVERAGE=80
lint_ok=0
test_ok=0
cov_ok=0

# ── Lint (JS) ────────────────────────────────────────────────────────────────
lint_output=$(./node_modules/.bin/eslint src/ test/ server.js bot.js public/dashboard-*.js --max-warnings 0 2>&1)
if [ $? -eq 0 ]; then
  lint_ok=1
else
  lint_detail="$lint_output"
fi

# ── Lint (CSS) ───────────────────────────────────────────────────────────────
css_lint_ok=0
css_lint_output=$(./node_modules/.bin/stylelint public/*.css 2>&1)
if [ $? -eq 0 ]; then
  css_lint_ok=1
else
  lint_ok=0
  lint_detail="${lint_detail}${css_lint_output}"
fi

# ── Lint (HTML) ──────────────────────────────────────────────────────────────
html_lint_ok=0
html_lint_output=$(./node_modules/.bin/html-validate public/*.html 2>&1)
if [ $? -eq 0 ]; then
  html_lint_ok=1
else
  lint_ok=0
  lint_detail="${lint_detail}${html_lint_output}"
fi

# ── Lint (Markdown) ──────────────────────────────────────────────────────────
md_lint_ok=0
md_lint_output=$(./node_modules/.bin/markdownlint-cli2 README.md CLAUDE.md docs/CLAUDE-SECURITY.md 2>&1)
if [ $? -eq 0 ]; then
  md_lint_ok=1
else
  lint_ok=0
  lint_detail="${lint_detail}${md_lint_output}"
fi

# ── Security Audit ───────────────────────────────────────────────────────────
sec_deps_ok=0
sec_deps_output=$(npm run audit:deps 2>&1)
if [ $? -eq 0 ]; then sec_deps_ok=1; fi

sec_lint_ok=0
sec_lint_output=$(npm run audit:security 2>&1)
if [ $? -eq 0 ]; then sec_lint_ok=1; fi

sec_secrets_ok=0
sec_secrets_output=$(npm run audit:secrets 2>&1)
if [ $? -eq 0 ]; then sec_secrets_ok=1; fi

# ── Backup production files before tests ─────────────────────────────────────
_BACKUP_DIR=$(mktemp -d)
# All production cache and config files that tests might overwrite.
# Uses glob for tmp/ to catch per-pool event caches (event-cache-*.json).
_PROD_FILES=".bot-config.json .wallet.json rebalance_log.json"
_PROD_TMP_GLOB="tmp/*.json"
# Backup root-level files
for _f in $_PROD_FILES; do
  [ -f "$_f" ] && cp "$_f" "$_BACKUP_DIR/$(basename "$_f")"
done
# Backup all tmp/*.json files (preserves per-pool event caches, symbol cache, etc.)
mkdir -p "$_BACKUP_DIR/tmp"
for _f in $_PROD_TMP_GLOB; do
  [ -f "$_f" ] && cp "$_f" "$_BACKUP_DIR/tmp/$(basename "$_f")"
done

# Replace with vanilla state — delete all production files so the code
# creates fresh defaults from its own built-in defaults (loadConfig
# returns {global:{},positions:{}} when no file exists).
rm -f $_PROD_FILES
rm -f tmp/*.json

_restore_prod_files() {
  # Restore root-level files
  for _f in $_PROD_FILES; do
    _bk="$_BACKUP_DIR/$(basename "$_f")"
    if [ -f "$_bk" ]; then
      cp "$_bk" "$_f"
    elif [ -f "$_f" ]; then
      rm "$_f"
    fi
  done
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
test_output=$(node --test --experimental-test-coverage test/*.test.js 2>&1)
test_exit=$?

# Restore happens automatically via EXIT trap (_restore_prod_files)
if [ $test_exit -eq 0 ]; then
  test_ok=1
fi

# Parse counts from Node test runner output
tests_total=$(echo "$test_output" | sed -n 's/^ℹ tests \([0-9]*\)/\1/p')
suites_total=$(echo "$test_output" | sed -n 's/^ℹ suites \([0-9]*\)/\1/p')
tests_pass=$(echo "$test_output" | sed -n 's/^ℹ pass \([0-9]*\)/\1/p')
tests_fail=$(echo "$test_output" | sed -n 's/^ℹ fail \([0-9]*\)/\1/p')
duration=$(echo "$test_output" | sed -n 's/^ℹ duration_ms \([0-9.]*\)/\1/p')
coverage=$(echo "$test_output" | grep 'all files' | sed 's/[^0-9.]/ /g' | awk '{print $1}')

: "${tests_total:=?}" "${suites_total:=?}" "${tests_pass:=?}" "${tests_fail:=0}" "${duration:=?}" "${coverage:=?}"

# Check coverage threshold
if [ "$coverage" != "?" ]; then
  cov_int=${coverage%.*}
  if [ "$cov_int" -ge "$MIN_COVERAGE" ] 2>/dev/null; then
    cov_ok=1
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
sec_ok=0
if [ $sec_deps_ok -eq 1 ] && [ $sec_lint_ok -eq 1 ] && [ $sec_secrets_ok -eq 1 ]; then sec_ok=1; fi

all_ok=0
if [ $lint_ok -eq 1 ] && [ $test_ok -eq 1 ] && [ $cov_ok -eq 1 ] && [ $sec_ok -eq 1 ]; then
  all_ok=1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $all_ok -eq 1 ]; then
  echo -e "  ${GREEN}✔ PASS${RESET}"
else
  echo -e "  ${RED}✘ FAIL${RESET}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Lint
if [ $lint_ok -eq 1 ]; then
  echo -e "  ${GREEN}✔${RESET} Lint       0 errors, 0 warnings"
else
  errors=$(echo "$lint_output" | grep -oE '[0-9]+ error' | head -1)
  echo -e "  ${RED}✘${RESET} Lint       ${errors:-errors found}"
fi

# Tests
if [ $test_ok -eq 1 ]; then
  echo -e "  ${GREEN}✔${RESET} Tests      ${tests_pass} passed, ${suites_total} suites  ${DIM}(${duration}ms)${RESET}"
else
  echo -e "  ${RED}✘${RESET} Tests      ${tests_fail} failed, ${tests_pass}/${tests_total} passed"
fi

# Coverage
if [ $cov_ok -eq 1 ]; then
  echo -e "  ${GREEN}✔${RESET} Coverage   ${coverage}% lines  ${DIM}(min ${MIN_COVERAGE}%)${RESET}"
elif [ "$coverage" != "?" ]; then
  echo -e "  ${RED}✘${RESET} Coverage   ${coverage}% lines  ${DIM}(min ${MIN_COVERAGE}%)${RESET}"
else
  echo -e "  ${DIM}─${RESET} Coverage   unavailable"
fi

# Security
if [ $sec_ok -eq 1 ]; then
  echo -e "  ${GREEN}✔${RESET} Security   deps + lint clean"
else
  echo -e "  ${RED}✘${RESET} Security   audit failed"
fi

echo ""

# On failure, show details (capped)
if [ $lint_ok -eq 0 ]; then
  echo -e "${DIM}── Lint errors ──${RESET}"
  echo "$lint_detail" | grep -E '^\s+[0-9]+:[0-9]+' | head -15
  echo ""
fi

if [ $test_ok -eq 0 ]; then
  echo -e "${DIM}── Failed tests ──${RESET}"
  echo "$test_output" | grep -E '✗|not ok|FAIL' | head -15
  echo ""
fi

if [ $cov_ok -eq 0 ] && [ "$coverage" != "?" ]; then
  echo -e "${DIM}── Low coverage files ──${RESET}"
  echo "$test_output" | grep -E '^\u2139\s' | grep -v 'all files' | grep -v '^\u2139 file' | grep -v '^\u2139 ---' | awk -F'|' '{gsub(/^ℹ /,"",$1); pct=$2+0; if(pct < 80 && pct > 0) printf "  %-28s %s\n", $1, $2"%"}' | head -10
  echo ""
fi

exit $( [ $all_ok -eq 1 ] && echo 0 || echo 1 )
