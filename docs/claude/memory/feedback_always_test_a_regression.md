---
name: feedback-always-test-a-regression
description: "Any regression you find gets a test, unless it is completely trivial — and prove the test fails without the fix"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-14T19:35:40.762Z
---

When you find a regression — in your own work or anyone's — write a test
for it. The only exemption is a completely trivial one. Fixing it and
moving on is not enough: an untested regression is one edit away from
returning, and the next person has no signal that the behaviour was ever
deliberate.

**Why:** stated by the user on 2026-09-14 as a standing rule —
"If you find regressions, ALWAYS write test for it unless it's
completely trivial." It came after I found, fixed, and reported a
regression in my own change without guarding it.

**How to apply:**

- Write the test against the real entry point, not a helper that happens
  to be easier to reach. See [[feedback_use_the_path_being_tested]].
- **Prove the test can fail.** Remove the fix, confirm the suite goes
  red, restore, confirm green. A regression test that passes both ways
  is worse than none — it reports safety it does not provide. Verify the
  revert actually applied first: see [[feedback_prove_the_revert_applied]].
  Check the failure COUNT too, not just that something failed — it tells
  you the test caught the thing you meant and not something adjacent.
- Test-infrastructure regressions count. A test helper that leaks a
  stubbed module into `require.cache` produces false greens, which is
  the same harm as a broken product path.
- The test comment states the invariant and what breaks without it —
  not the incident. See the Documentation rules in
  [CLAUDE-BEST-PRACTICES.md](../CLAUDE-BEST-PRACTICES.md).

Related: [[feedback_tests_with_implementation]],
[[feedback_no_finding_without_a_failure]], [[feedback_no_flaky_push]].
