---
name: No re-exports
description: "Import from the owning module, never through a re-export; an export nothing imports is composability, never a finding"
metadata:
  type: feedback
---

# Exports

Merged from: feedback_unused_exports_are_fine — those slugs no longer exist
separately; search this one.

## no re-exports

Never add a re-export to make a symbol available through a different module than its owner. Consumers must import directly from the file that defines the symbol.

**Why:** Re-exports create a fake-public-API layer that drifts: the barrel claims to own a symbol it doesn't, refactors have to update the barrel too, and `grep` for the definition becomes ambiguous. The user has flagged this as a hard rule.

**How to apply:** When extracting a function to a new module, do not leave a re-export in the original module "for backward compat" or "to keep tests working." Update every importer (including tests) to point at the new module. If `grep -rn "ext_name" src test` still shows imports from the old path after extraction, those are bugs to fix.

## unused exports are fine

Exporting a function nothing currently imports is a **feature**. It
makes the module composable: the seam exists, so a test, a future tool
or a REPL can reach the piece without the file being rewritten first.

**Why:** on 2026-09-28 I added exports to `util/diagnostic/check-rpc-health.js`
to match that directory's convention, then reported them back as a
shortfall — *"the seam is there, nothing sits in it"* — and separately
surfaced knip's unused-file listing. The user: *"unused exports are
fine: They are good since it makes the module composable."* The repo
already said as much twice over. `docs/engineering.md` states the
convention outright — each diagnostic tool "exports its internals
(renderers, scan loops) so those are testable rather than dark" — and
[[feedback_no_finding_without_a_failure]] rules the report out on its
own terms, because an unused export breaks nothing and "inert" is a
delete signal for the finding.

**How to apply:**

- Do not list an unused export as a gap, a TODO, or a caveat. It is
  finished work.
- Do not delete one to quiet knip or any other dead-code pass. knip
  cannot see CLI entry points or test-only seams; its unused-file and
  unused-export rows for `util/`, `scripts/` and `src/client/web/js/dashboard-*.js`
  are known false positives, and knip gates nothing — it is in neither
  `npm run lint` nor `npm run check`.
- Export the internals when writing a new tool, before any test exists.
  That is the point at which the seam is cheap.
- This is not licence for barrel files: [[feedback_no_reexports]] still
  stands. Export from the module that owns the code; do not add a file
  whose only job is re-exporting someone else's.

A missing **test** is still a real gap ([[feedback_tests_with_implementation]]).
An unexercised **export** is not. Do not conflate the two — the export
is what makes the test writable.
