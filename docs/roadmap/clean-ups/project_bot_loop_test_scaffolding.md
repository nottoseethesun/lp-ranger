# `startBotLoop` Lifecycle Test Scaffolding

> **Status:** Nice-to-have / testing — not a bug. The app works
> correctly today. Funds are never at risk.

No test runs the bot's poll loop as a whole. `startBotLoop`
(`src/lib/bot-loop.js`) builds a provider, a signer and the position, then
polls on a timer. Nothing in the test suite can stand up that stack with
the timer under the test's control, so how a poll, `stop()` and the
timer interleave is checked only by reading the code.

## What is covered today

The parts taken out of the loop are tested on their own:
`resolvePrivateKey`, `pollCycle`, `forceRebalance` and
`wireBotStateGetConfig` in `test/bot-loop.test.js`; the timer and its
wake-up, `createBotPollScheduler` (`src/lib/bot-loop-scheduler.js`), in
`test/bot-loop-kick-poll.test.js`; and the wait before the next poll,
`nextCheckDelayMs`, in `test/bot-loop-gas-wait.test.js`.

## What is not

`stop()` racing a poll that is still running. A poll ends by scheduling
the next one. If `stop()` clears the timer while a poll is in flight,
that poll's last step would start the loop again for one more cycle. Two
`if (_stopped) return` guards in the poll close the race, and no test
proves they do, because that needs a poll held mid-flight while `stop()`
runs.

The same fixture would cover the rest of the loop's lifecycle: a queued
position switch (`pendingSwitch`), a scan started while a poll runs
(`_triggerScan`), and the `onRetire` callback.

## What's needed

A fixture that:

- builds a `startBotLoop` instance with a mocked provider, signer,
  position, throttle and config, without ganache or the real rpc layer;
- drives the timer deterministically, through fake timers or the
  scheduler's injected `setTimeoutFn`, so a test can run `stop()` while
  a poll is held and assert that no further poll fires.

## Why deferred

The fixture has to mock everything `startBotLoop` sets up before its
first poll. That is a refactor to plan on its own, not one to bolt onto
a fix. The scheduler already takes injected timer functions, which
covers the timer half.

Until then the stop race can be checked by hand. Remove a position from
the LP Browser while it is waiting for gas to come down, then confirm
the server log shows no further `[bot] Force rebalance requested` or
`[bot] Gas too high` lines for it.
