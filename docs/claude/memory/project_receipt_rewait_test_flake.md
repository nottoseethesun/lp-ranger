---
name: project_receipt_rewait_test_flake
description: "UNRESOLVED flake: 'bounds every receipt re-ask during a speed-up' in test/receipt-wait-failover.test.js fails roughly one full-suite run in five, only under the suite's own contention. Pre-existing, not reproducible in isolation, no timing seam exists to fix it properly."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-02T22:25:55.254Z
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

**Why it can fail.** The case drives the real speed-up pipeline, whose
phases are bounded by wall-clock deadlines from `TX_SPEEDUP_SEC` and an
`AbortSignal` (`src/tx-speedup.js`, `_phase`). Its first assertion is
that the never-mined hash *was* asked about. Under enough contention the
phase's deadline can elapse before the polling loop gets the event loop
back, so the ask never happens and the assertion fails. Nothing is wrong
with the pipeline; the test is timing-dependent.

**Why it was not fixed.** `src/tx-speedup.js` has no delay-injection
seam — unlike `bot-provider._setDelaysForTests` or
`price-source-backoff._setDelays` — so a real fix means adding test
machinery to the code that recovers stuck transactions. That is worth
doing deliberately, not at the end of a long session, and not while the
failure cannot be reproduced on demand to prove the fix works.

**How to fix it when taken up.** Give `tx-speedup.js` the same kind of
seam its siblings have, so the phase budget in a test is a few
milliseconds of injected value rather than a real deadline, and the
assertion no longer races the scheduler. Then confirm by making the
current test fail on demand — if a fix cannot be shown to change a
failing run into a passing one, it has not been shown to fix anything.

Related: [[feedback_no_flaky_push]] — a flake is fixed or named before
CI sees it, and this one is named. [[project_bot_loop_test_scaffolding]]
for the other place this suite lacks a fixture.
