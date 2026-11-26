---
name: feedback-always-test-a-regression
description: "Cover the user-visible contract before manual testing; prove each test fails without its fix; write tests with the implementation; validate through the exact entry point; test the thing asked about, not a cheaper proxy"
metadata:
  type: feedback
---

# Tests

Merged from: feedback_tests_cover_full_contract_before_manual, feedback_tests_with_implementation, feedback_use_the_path_being_tested, feedback_signal_substitution — those slugs no longer exist
separately; search this one.

## tests cover the full contract before manual testing

On 2026-07-23 the user asked: "How come you are just now writing
tests for a feature I thought you had already written tests for?  You
shouldn't have me doing manual testing when the automated tests are
not done."

What happened: every commit shipped with tests, but (a) one test
pinned a FALSE timing assumption (the one-shot poll-skip test assumed
the second sweep carries fresh server data; the audit proved the
stale window spans up to CHECK_INTERVAL_SEC), and (b) adjacent
consumers of the same state (the countdown KPI, string-typed config
values) had no assertions.  Green tests + incomplete contract =
the user's manual session became the bug-discovery mechanism, three
times.

**How to apply:**
- Before requesting manual verification, enumerate every user-visible
  surface that reads the changed state (grep consumers) and assert
  each one.  A fix to a shared value (e.g. `throttle.minIntervalMs`)
  is not covered until every derived display is covered.
- Timing/ordering assumptions in a fix (poll cadences, snapshot
  freshness, event ordering) must be stated in the test docstring AND
  verified against the code path — a test that encodes an unverified
  assumption is a fake pass ([[feedback_finish_logic]],
  no-fake-tests audit).
- Manual testing requests should say exactly what the automated tests
  already prove and what the manual pass is confirming on top.

## always test a regression

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

## tests with the implementation

Write tests for new code paths AS you implement them, not after. Adding 200 lines of uncovered src code then chasing 0.1% coverage gains with trivial helper tests wastes the user's time in an endless loop.

**Why:** User was frustrated by repeated coverage churn cycles that each moved the needle by 0.1%, burning hours. The root cause was adding feature code without corresponding tests.

**How to apply:** For every new function or code path, write a test before or immediately after. If the code needs RPC mocks, write the mocks as part of the implementation task. Never commit uncovered code and hope to fix it later.

## use the path being tested

When the user's goal is to *validate* that something works via a specific path (UI, webhook, API call, etc.), execute via that path — not via a faster equivalent that bypasses the thing being tested.

**Why:** On 2026-04-20, after landing a workflow fallback for release builds, the user wanted to confirm a "normal UI-based Release creation" reliably triggers the workflow. At "Yep recreate" I used `gh release create` instead of waiting for the user to click through the GitHub UI. The end state (release + tarball) was correct, but the specific flow under test (UI publish → `release: published` event) wasn't exercised. The user noted they'd wanted the UI path.

**How to apply:** When the preceding conversation establishes that the goal is "make sure X works from Y" — do not substitute path Z to save a step, even with an explicit imperative. If I have a CLI shortcut available and it's ambiguous whether the user wants speed or the specific path, ask. Default to the path under test.

## signal substitution

When writing a condition, ask: **is this testing the thing I actually
care about, or something cheaper that usually agrees with it?**

Four bugs found in a single session, all the same shape:

| The signal used | The question it was really answering | Where |
| --- | --- | --- |
| `!!cachedHodl` | has the compound scan already run? | `bot-recorder-lifetime.js` |
| `closedEpochs.length > 0` | is the epoch history complete? | `epoch-reconstructor.js` |
| `!entryValueUsd` | are the deposited token amounts present? | `position-history.js` |
| `priceChangePnl` | what is the impermanent loss? | `dashboard-history.js` |

**Why they survive review and tests.** The substitute is correct *most*
of the time. It only diverges on a subset — and in this codebase the
subset was consistently "the positions this bot rebalanced itself,"
because that is the only case where a value is already known from
`rebalance_log.json`. Five of six pools looked perfect; the sixth read
8 epochs against 132 on-chain rebalances. Two of the four were also
actively **asserted** by tests, one literally checking
`key.contract === ""`. A green suite was camouflage, not protection.

**How to apply:**

- Write the condition in terms of the thing itself. "Do I have ALL of
  them?" not "do I have ANY?". "Are the amounts present?" not "is the
  value known?".
- When two needs are bundled behind one flag, split them. Both
  `lifetimeFiguresSaved` and `needsEntryFromChain` exist because the
  original single condition answered two questions at once.
- Name the derived column after what it holds. `IL/G` displaying
  `priceChangePnl` is the same error in the UI layer.
- Cross-check derived data against its source, per entity, and look for
  the row that does not match — that one query found all of these. See
  [[project_0091_burn_in_watch]] for the diagnostic script this argues
  for.

## Tests of a configured value: move it off its default (2026-10-17)

The same shape in a test. A test that "the status names the error log
as logging.json sets it" compared the status against the configured
value, and the configured value in the test process was the default.
A mutation that hard-coded the default passed it: the test could not
tell "reads the setting" from "states the default". The clean script's
log-path test had the same blind spot.

**How to apply:** a test that a value comes from configuration sets
that value to something other than its default first, in an override
directory of the test's own (`LP_RANGER_USER_CONFIG_DIR`, set before
anything under `src/lib/` loads), and asserts the moved value. Then prove it
with a mutation that hard-codes the default
([[feedback_always_test_a_regression]]).

Related: [[feedback_engineering_invariants]] (a second *reader* of a
value is not the same problem as a second *resolution path*), and
[[feedback_no_heuristic_thresholds]].
