---
name: project_tests_write_operator_error_log
description: "FIXED 2026-10-16 by the user's design: npm run check deletes logs/error.log and logs/error-npm-run-check.log before it runs, then renames what the tests wrote to logs/error-npm-run-check.log. The test that writes the fake 'simulated scan abort' entry is unchanged"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-18T08:46:43.081Z
---

# Tests write the operator's error log

**FIXED 2026-10-16, by the user's design** (committed in 8d1f562 on
branch `migrate-to-new-9mm-data-api`, not merged). `scripts/check.js`
now:

1. deletes `logs/error.log` and the previous run's
   `logs/error-npm-run-check.log` before anything runs, and
2. once the tests are done (in the `finally` beside the restore of the
   other operator files), renames whatever they wrote to
   `logs/error-npm-run-check.log`.

The path comes from `getErrorLogPath()` in `src/error-log.js`. Verified
on a real gate run: `logs/error.log` gone, the fake entry in
`logs/error-npm-run-check.log`. Documented in CLAUDE-TESTING.md § "`logs/`"
and in docs/npm-project-commands.md.

**What it was.** Every `npm run check` appended one fake catastrophic
failure to the operator's own `logs/error.log`:

```text
[bot-recorder-lifetime] Lifetime pool scan failed: PLSX/WPLS NFT #161973
Error: simulated scan abort
```

`test/bot-recorder-lifetime-catastrophic.test.js` drives
`_recordScanFailure`, which calls `writeErrorLog` with no `filePath`, so
the entry went to the default path under the repo root. The file held 17
of them when found. The test still writes there; the check now moves it.

**Why the user's fix, not the one proposed:** the proposal was to run
that one test from a `mkdtempSync` cwd. The user chose to handle the file
in the check instead, which also covers any future test that writes it.
Deleting the operator's file costs nothing a server start would keep:
`resetErrorLog` deletes it at startup too.

**How to apply:** a raw `node --test` outside the check still writes
`logs/error.log`; only `npm run check` moves it.
