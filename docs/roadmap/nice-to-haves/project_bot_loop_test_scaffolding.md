# `startBotLoop` Lifecycle Test Scaffolding

> **Status:** Nice-to-have / developer-experience — not a bug. The
> app works correctly today. Funds are never at risk. This entry is
> a deferred testing improvement that surfaced when fixing the
> stop-race in PR #130.

`src/bot-loop.js` exports `startBotLoop`, which wires up a provider,
signer, detected position, and a self-scheduling `poll()` closure.
Its extracted helpers — `resolvePrivateKey`, `pollCycle`,
`forceRebalance`, `wireBotStateGetConfig` — are well covered in
`test/bot-loop.test.js`. But the `poll()` closure itself (and its
`stop()` lifecycle) has no direct test, because there is no test
harness today for the full provider/signer/position stack plus
timer control.

## Why this matters

`stop()` and an in-flight `poll()` can race: `poll()` tail-calls
`_scheduleNext()`, and if `stop()` has already cleared the timer by
then, the loop is resurrected for one more cycle. Two `if (_stopped)
return` guards close it. **No test covers that race**, because driving
it requires holding a poll mid-flight while `stop()` runs, and no
fixture can do that today.

## What's needed

A test fixture that can:

- Construct a `startBotLoop` instance with mocked provider, signer,
  position, throttle, and config — without touching ganache or the
  real RPC layer.
- Drive the internal timer deterministically (fake timers, or
  injected scheduler) so a test can interleave `stop()` with an
  in-flight `poll()` and assert no further polls fire.
- Cover other lifecycle behaviors: `pendingSwitch` handling, gas
  deferral rescheduling, `_triggerScan` interleaving, and the
  `onRetire` callback path.

## Why deferred

The scope of this test fixture is non-trivial — it likely requires
extracting the scheduling logic and/or introducing dependency
injection for the timer source. That's a meaningful refactor that
should be planned in its own pass, not bolted onto a stopgap fix.

In the meantime, the existing 1917 tests continue to guard against
regressions in the extracted helpers, and the stop-race fix is
small enough to be manually verified by removing a position from
the LP Browser while it is stuck in the gas-defer retry loop and
confirming that no further `[bot] Force rebalance requested` or
`[bot] Gas too high` lines appear in the server log afterwards.
