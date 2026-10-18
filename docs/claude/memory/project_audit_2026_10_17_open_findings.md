---
name: project_audit_2026_10_17_open_findings
description: "The second 2026-10-17 audit's findings not yet put to the user, kept from the session's scratch tracker; re-check each against current code before acting"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-18T04:26:23.249Z
---

The second audit of 2026-10-17 (state and sequence over the day's
changes) produced findings that were not yet put to the user when the
session's approved items were done. The session's tracker was scratch
and did not persist, so they are kept here. **Re-check each against the
code as it stands before raising it:** the tracker marked many "to
verify", and the day's fixes (items 3 to 7, questions 2 to 4) changed
some of the code they describe. The user wants no false alarms, and
every item put to them restated in full ([[feedback_no_finding_without_a_failure]]).

Already settled, not to raise again: the confirmation-check error answer
(R1-1, R1-2, not a bug), the stop behaviour (R6-1, decided: force-stop
plus `npm run gentle-stop`), the open tab across a restart (R3-4, leave),
the re-open refusal while prices are paused (R5-3, not a bug), the block-0
mint record and the pool-history append (R5-1, R5-2, fixed), the decimals
form (R4-1, fixed; R4-4's seeding and R4-7's decimals half went with it),
the Manage/Stop decision (R4-5, fixed), the disclosure (R7-1, reworded),
the regression in the speed-up timing (C1, fixed). The gas-deferred
rebalance's hour wait (R2-1) is an open question in
[PROJECT-STATE](PROJECT-STATE.md).

**Re-checked late on 2026-10-17** against the code as it then stood.
Confirmed bugs are now in [PROJECT-STATE](PROJECT-STATE.md) ("Confirmed
2026-10-17 re-checking the second audit's open findings"). Fixed the
same night as comment, copy or dead-code cleanups: R2-8's `?? 5`
(deleted), R2-9's comments not tied to a pending decision, R3-3, R3-5
(the trigger count now spelled out), R3-7, R3-9(a) (dead `userDirty`
check deleted), R1-7/R1-8, R5-6. Not bugs: R2-7, C5, C3, the copy-icon
tick, R1-6 and R5-7 (log lines missing context; nothing an operator
sees). R3-2 is latent: the manual's two new modules are served
immutable with no stamp, so the first later release that edits either
leaves browsers on the old copy. R1-5 (wasted block reads after a
stuck move's cancel) is a rare optimization. Scripts and tests (R6,
R8) were still being re-checked.

Open, by area (tracker ids):

- **Send path.** R1-3: a cancel accepted but its reply lost is later
  refused "nonce too low" and not recognised as the bot's own cancel; the
  speed-up path then says "taken by another transaction", with no
  cancelled flag or gas, and the aggregator reports the nonce unsettled.
  R1-4: approval gas counted twice when the post-swap balance read fails
  (aggregator and router). R1-5: phase 4's `t.wait()` keeps scanning
  blocks after the race is decided (about 350 heavy requests on the
  shared queue). R1-6: new send-path logs lack the position's context.
  R1-7, R1-8: false doc claims (rebalancer.js header re-exports,
  `_DEADLINE_SECONDS` comment, aggregator-quote-request "fails before any
  transaction is built") and comment style.
- **Settings and defaults.** R2-2: defaults never applied
  (`moralisEnabled` on unlock or a null save, `fullRangeRebalanceEnabled`,
  `slippagePctToken0/1` in the defaults file). R2-3: `.env` timers
  silently replaced (`CHECK_INTERVAL_SEC=0` becomes 300, fractions
  truncated). R2-4: help figures for off or edge values (request pacing 0
  reads "Infinity", OOR timeout 0 reads "0 seconds", an ILG of 84 or more
  gives a negative example). R2-5: boolean normalizers read the string
  "true" as false. R2-6: `diskConfig.global` spread after
  positionManager/factory in `/api/status`, so stale saved values win.
  R2-7: `gasFeePctToRatio` clamps a saved value. R2-8: dead offset
  fallbacks and a `?? 5` in bot-cycle-triggers. R2-9: stale comments.
  C4: resolved defaults fetched and held twice (Telegram a third time).
  C5: `_ENV_SET` restates config.js's mapping.
- **Dashboard startup and help.** R3-1: the CSRF token is null after the
  page waits for the server, so every POST is refused 403 and not
  retried. R3-2: the manual's module scripts carry no cache-bust stamp.
  R3-3: hard-coded copies of configured figures next to their spans.
  R3-5: numerals and "shipped default" in prose. R3-6: the ask loop logs
  its tag twice. R3-7: comments naming a file that does not exist and
  other false claims. R3-8: typing in Max Rebalances drives the
  throttle's daily max before Save. R3-9: state read from the DOM. C3:
  the help-figures question counted toward HALTED.
- **Dashboard position switching.** R4-2: an unmanaged-details answer
  arriving after a switch blanks the position now on screen. R4-3: the
  alerts' position line runs the chain into the wallet
  ("PulseChain0x1111"). R4-6: re-open and rebalance results labelled
  from the tab on screen when they answer. R4-7: the price override's
  browser copy written under the position on screen at answer time. R4-8:
  `botConfig.chainName` blank until the first poll. Also: the copy
  icon's tick reads its own text as state.
- **Prices and logs.** R5-4: a failed GeckoTerminal pool lookup saves a
  period at today's prices. R5-5: the LP-position cache stores an
  abbreviated address as a symbol. R5-6: comments name renamed
  functions. R5-7: new logs lack symbols and NFT ids.
- **Scripts.** R6-2: a config error blocks `npm stop` (it loads the
  shutdown timings on require). R6-3: `clean:log` unlinks a file the
  running server holds open. R6-4: dead interrupt branches in check.js.
  R6-5: clean.js throws on a null path. R6-6: `npm stop` exits 0 saying
  "nothing to stop" when another program holds the port. R6-7:
  `insideInstall` ignores symlinks. R6-8: `npm run clean` leaves
  `logs/error-npm-run-check.log`. R6-9, R6-10, R6-12: a header gap, an
  editor on server.js matched as the server, a false header.
- **Docs.** R7-2 to R7-23: corrections across README, configuration.md,
  engineering.md, security.md, openapi.json, CLAUDE.md, CLAUDE-SECURITY
  and npm-project-commands.md.
- **Tests.** R8-4.1: boot-log-file.test.js writes the SHIPPED
  logging.json, so other files can fail at require, and a killed run
  breaks `npm start` (must fix). R8-4.2 to 4.4: tests that unlink or
  write the operator's tmp/ caches. R8-7: tests that cannot fail. R8-5:
  configured values compared at their defaults. R8-3: global swaps not
  restored. R8-2: `require` inside functions. R8-8: comment forms.
