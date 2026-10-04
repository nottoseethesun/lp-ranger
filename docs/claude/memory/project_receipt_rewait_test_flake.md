---
name: project_receipt_rewait_test_flake
description: "FIXED 2026-10-02: what looked like a timing-dependent flake was two real races in the speed-up pipeline. One left an abandoned racer rejection unhandled, which the process guard turns into process.exit for several error codes; the other was the phase-boundary race, fixed 2026-10-03."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T17:20:15.290Z
---

`test/receipt-wait-failover.test.js` → `bounds every receipt re-ask
during a speed-up: [compound] collect` failed one full-suite run on
2026-10-02 and has not been made to fail again.

**What was measured, so the next person does not repeat it:**

- Six runs of that file alone: all pass.
- Eight copies of that file in parallel: all pass.
- Two further full-suite runs immediately after the failure: both pass,
  4315/4315.
- The same pass that failed on Node 24 passed on Node 22.

So it needs the full suite's contention — 887 suites at
`--test-concurrency=24` — and neither isolation nor hand-made
parallelism reproduces it.

The case drives the real speed-up pipeline, whose phases are bounded by
wall-clock deadlines from `TX_SPEEDUP_SEC` and an `AbortSignal`
(`src/tx-speedup.js`, `_phase`), which is why contention shows it.

**FIXED 2026-10-02, and it was not a timing problem.** Making it
reproducible — twenty copies of the file at once, with the phase
shortened — turned it from "flaky under load" into two real faults in
`src/tx-speedup.js`:

1. **An abandoned racer's rejection went unhandled.** `Promise.race`
   abandons its losers without stopping them, and an abandoned receipt
   wait rejects the moment the phase aborts it. Nothing was listening,
   so it reached the process-wide guard — which calls `process.exit(1)`
   for any code outside `TIMEOUT`, `NETWORK_ERROR`, `SERVER_ERROR`,
   while a re-ask is entered for refused connections, unresolvable
   hosts and endpoint 4xx as well. Phase 3 guarantees a loser, since
   only one of the two transactions can mine. Fixed with `_settled`,
   which attaches a handler and says why.
2. **The phase-boundary race**, fixed a day later on 2026-10-03 and
   kept in its own entry: [[project_speedup_phase_boundary_race]]. Both
   faults are now closed.

The test briefly measured only what it claims — that the re-asks are
bounded — and stopped requiring the move to succeed, because the second
fault made that assertion fail for its reason rather than the test's.
With that fault fixed the assertion is back, and it is the stronger one:
every receipt wait in the fixture is refused, so a confirmed receipt
proves the refusals were asked around instead of ending the move.
Twenty concurrent runs pass where one in sixteen failed before.

The original diagnosis in this file was wrong in an instructive way: it
read "fails only under contention, passes in isolation" as the test
being timing-dependent, and proposed a timing seam. Contention was not
the fault. It was the thing that made a real race observable, and the
fix for "cannot reproduce it" was to try harder to reproduce it — eight
parallel copies showed nothing, twenty showed it twice.
