# Code Style and Formatting Rules

Companion to [CLAUDE.md](../CLAUDE.md). Collects the formatting and lint
rules that are most commonly violated, so they are impossible to miss.

---

## Prettier

- **Prettier is enforced** via pre-commit hook (husky + lint-staged). Every
  file committed to `main` is auto-formatted.
- **NEVER add `// prettier-ignore`** directives. They create technical debt
  that must be cleaned up later.
- When Prettier expands code past the 500-line limit, the correct fix is to
  **split the file** into smaller modules — not to suppress Prettier.

## File Size

- Every `src/` and `public/dashboard-*.js` file ≤ **500 non-comment lines**
  (`max-lines` with `skipBlankLines skipComments`).
- When a file grows past 500 lines, **split it** following the existing
  pattern (e.g. `dashboard-data.js` → `dashboard-data-kpi.js`,
  `dashboard-data-status.js`, etc.).
- Split one file at a time. Verify `npm run check` after each split.

## Complexity

- No function with cyclomatic complexity > **17**.
- When a function exceeds 17, extract helpers — do not restructure the
  entire module.

## ESLint / stylelint

- `--max-warnings 0` — warnings are treated as errors.
- **No `eslint-disable` directives** for main lint rules.
- Security lint rules (`9mm/no-number-from-bigint`, `9mm/no-secret-logging`)
  may use per-line `eslint-disable-next-line` with a documented
  `-- Safe: <reason>` comment.
- No `stylelint-disable` directives.
- Never exclude entire files from any lint pass.

## CSS

- All custom CSS classes prefixed with `9mm-pos-mgr-`.
- No inline `style="..."` in HTML (except dynamic JS-set `width` values).
- All styles in external `.css` files — zero inline `<style>` blocks.

## Naming

- EVM addresses use EIP-55 checksummed capitalisation.
- All dollar amounts denominated in USD.
- Log hashes with a space after `=` — write `hash= %s` so the hash is a
  separate word that can be double-click-copied.
