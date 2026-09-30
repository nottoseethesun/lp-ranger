---
name: feedback_check_both_node_versions
description: "`npm run check` runs on whichever Node is on PATH; CI runs a 22/24 matrix. Green locally never means green in CI. Node 22 lives at ~/.nvm/versions/node/v22.23.1/bin/node — run the suite under it too before pushing."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-30T23:30:57.839Z
---

`npm run check` exercises **one** Node version: whichever is on `PATH`,
which on this machine is v24. `.github/workflows/ci.yml` runs
`node-version: ["22", "24"]`. So a local pass says nothing about half
of CI.

The second one is already installed:

```bash
~/.nvm/versions/node/v22.23.1/bin/node --test --test-concurrency=24 test/*.test.js
```

**Why:** on 2026-09-30 a branch went up green locally and CI failed
every case in one new test file on Node 22 while Node 24 passed. The
cause was version-specific and not subtle once seen — Node 22's test
runner fails a test whose promise is still pending when the event loop
drains, and Node 24 tolerates it:

```
error: 'Promise resolution is still pending but the event loop has already resolved'
failureType: 'cancelledByParent'
```

One pending promise cancels the **whole file**, so six unrelated cases
failed with it. Nothing local could have caught that, and
[[feedback_no_flaky_push]] is the rule it broke.

**How to apply:**

- Before pushing, run the suite under Node 22 as well. The full gate
  (lint, coverage, audits) only needs to run once; it is the *tests*
  that differ by version.
- Suspect this immediately when CI splits by Node version while local
  is green. Do not reach for "flaky timing" first — diagnose by running
  the failing file under the version that failed, which reproduces in
  seconds.
- The class it catches is real beyond the runner: a promise left
  pending, a timer left armed, a `Promise.race` loser still working.
  Node 22 is stricter about those, so it is worth having as a check on
  exactly the defects [[project_total_rpc_outage_oom]] came from.
