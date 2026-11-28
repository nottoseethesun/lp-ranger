---
name: feedback_no_test_runs_a_destructive_command
description: "A test never runs a command that deletes or starts something for real; before a proof breaks a confirmation or guard, check what each test of it runs end to end"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-28T01:04:02.570Z
---

A test never runs, for real, a command that deletes the operator's files
or starts the app, even down a path where a guard should stop it. Test
the decision through seams, over folders of the test's own; pin the
wiring by reading the script's text.

**Why:** on 2026-11-27 I tested `npm run build-and-start --
--delete-all-caches-and-logs` by running the real script with "no" as the
answer. My proof then broke the YES check, so the "no" went through:
the step deleted the install's `logs/lp-ranger.log` and `logs/error.log`,
which no backup held, `build-and-start` ran a build, and it started a
server on port 5555 that outlived the test. Under the test runner the
settings, records and caches were temporary folders, but the log paths
from `logging.json` were real. Any regression would have done the same.

**How to apply:**
- Before a proof breaks a confirmation, a refusal or any other guard,
  list what each test touching it runs end to end. If one runs the real
  command, replace it with a source check first.
- A test of a destructive script calls its function with every path
  injected (install folder, settings folder, log files); the scan-cache
  folder is the test process's own under `node --test`.
- Never assume `node --test` redirects everything: `logging.json`'s paths,
  the PID file and the port are real.
- After any proof run, check that port 5555 is free and nothing changed
  outside the test folders.

Related: [[feedback_never_test_against_production]],
[[feedback_always_test_a_regression]], [[feedback_tests_use_a_free_port]].
