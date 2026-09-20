---
name: explicit-type-checks
description: "For type checks, never rely on built-in type conversions. Always write explicit `x !== undefined && x !== null` etc.; never `!= null`, never `!== undefined` alone, never `|| default`, never truthy-if."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ef6c5215-1055-44cf-b98a-f7aa871665e8
  modified: 2026-09-20T22:45:15.929Z
---

For **type checks**, never rely on JavaScript's built-in type conversions.
Always write the check explicitly.

**Never** use these "sloppy" idioms as a stand-in for a real type check:

- `if (x)` — treats `0`, `""`, `false`, `null`, `undefined`, `NaN`, `0n`
  all as absent.  Fine for "is this string non-empty?"; wrong for "is this
  value present?"
- `if (x != null)` — blocked by the project's `eqeqeq: ["error", "always"]`
  lint rule.
- `if (x !== undefined)` alone — silently lets `null` through.  Then
  `String(null) === "null"` (the string) corrupts downstream comparisons
  like `isPositionClosed`.
- `x || defaultValue` — treats every falsy value as absent, hiding
  legitimate `0` / `0n` / `""` / `false`.  Only use `||` when you actually
  want falsy-fallback semantics; for "null/undefined only", use `??`.
- `Number(x)` / `String(x)` on a value of ambiguous type without first
  checking what `x` is.  `String(null)` is `"null"`, `Number("")` is `0` —
  neither is what a caller usually means.

**Do** use explicit checks:

```js
// "value present" (neither undefined nor null):
if (x !== undefined && x !== null) { ... }

// "value is a string":
if (typeof x === "string") { ... }

// "value is a canonical zero" (matches `isPositionClosed` semantics):
if (x !== undefined && x !== null && String(x) === "0") { ... }

// "coalesce ONLY null/undefined to a default" (ES2020 nullish coalescing,
// which IS an explicit null/undefined check — different from `||`):
const v = x ?? defaultValue;
```

**Why:** A type audit on 2026-07-10 flagged two pre-existing bare
`!== undefined` guards (`public/dashboard-active-sync.js` `_applyLiqAndTicks`
and `public/dashboard-positions.js` `_backgroundRefresh`) plus a
`String(x || 0)` normalisation in `src/bot-cycle.js` `_liquidityChanged`.
All three worked by accident (the server never sent the type they'd
mishandle) but the class of bug was real.  Ten-plus explicit
`!== undefined && !== null` guards already exist across the codebase
(`dashboard-history.js:203`, `position-detector.js:272-273`, `dashboard-data.js:193`,
etc.) — this rule codifies that as the standard.

**How to apply:** Every type check (payload validation, cache-hit guards,
optional-field mutation, presence tests before `String()`/`Number()`
coercion) is written explicitly.  Same in test mirrors so the tests catch
the same class of bug as production.  Codified in
[docs/claude/CLAUDE-BEST-PRACTICES.md](../CLAUDE-BEST-PRACTICES.md)
under "Type Checks".
