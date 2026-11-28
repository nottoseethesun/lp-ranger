---
name: project_audit_30_open_findings
description: "The thirtieth audit's verified findings in operator terms (5 minor bugs, 5 test gaps, 23 texts), ruled minor by the user on 2026-11-28 and left to fix later"
metadata:
  node_type: memory
  type: project
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-28T07:14:53.898Z
---

The thirtieth audit (2026-11-28) covered the twenty-ninth fix round, the
new `npm run delete-all-caches-and-logs` and the removal of the
shut-down `rpc-pulsechain.g4mm4.io` endpoint. Three read-only auditors
ran ([[feedback_audit_same_as_previous]]); every finding below was
checked against the code. File and line for each are in PROJECT-STATE.md,
in the thirtieth audit's entry.

**The user's ruling, 2026-11-28:** *"these are all minor items that can
be fixed later."* Nothing here is fixed yet.

## Bugs (one mine, four in older code)

- **[A30-1] A headless bot managing one position can take hours to exit
  after a file failure. Mine, from [A29-1]'s fix.** `npm run bot` with no
  positions saved as managed starts one loop, and that start includes
  the position's whole history read from the blockchain: hours when
  nothing is cached. The stop now waits for the start, so it waits for
  the read, against "nothing waits for a scan". Ctrl+C has no handler
  during the start. Fix: start that loop with `eagerScan: false`, as
  Manage and the start-up do, so the stop waits only for the first check.
- **[A30-2] The delete commands wipe every setting when bot-config.json
  can't be read.** `npm run delete-all-caches-and-logs`,
  `npm run build-and-start -- --delete-all-caches-and-logs` and
  `npm run clear-blockchain-scan-cache` read bot-config.json to remove
  the scan figures and save it back. If it is not valid JSON they read it
  as empty and save the empty settings over it, reporting success, while
  their warning says settings are kept. Only bot-config.backup.json keeps
  them. Fix: refuse before stopping or deleting anything when
  bot-config.json or the records file is there but cannot be read,
  naming it.
- **[A30-3] A damaged shipped settings file crashes the start without
  naming the file.** Seven shipped files are first read by the startup
  check (dust-threshold.json among them); a damaged one gives a bare
  "Unexpected end of JSON input" and a stack trace. Fix: list it with the
  other problems, naming the file.
- **[A30-4] The caches write over a file they couldn't read (low).**
  After a read that fails for a passing reason (too many files open),
  LP Ranger stops, but a history read or price lookup still running
  saves its cache over the healthy file meanwhile. Rebuildable (about an
  hour per position; price-service quota). Fix: the shared writer writes
  nothing to a file whose read failed, as the P&L history cache and the
  rebalance log already do.
- **[A30-5] `npm run clean` and `npm run clear-blockchain-scan-cache`
  don't see a running headless bot (low).** Both read only the server's
  PID file. Fix: check `tmp/lp-ranger-bot.pid` too.

## Test gaps

- **[C1]** Half the headless bot's stop wiring is unpinned, including the
  line handing its stop to the SIGUSR2 gentle stop: shortened in a way
  that looks harmless, it brings back [A29-1] with every test green.
- **[C2]** The P&L history cache test skips the save a rebalance's own
  deposit count makes (`setCachedFreshDeposits`).
- **[C3]** Nothing pins the big-integer handling in the wallet's position
  list save; broken, every full wallet scan would fail to save and stop
  LP Ranger.
- **[C4]** An operator's settings copy that is not valid JSON has no test
  of its words.
- **[C5]** The Telegram sender's start failure is checked by source only;
  a spawn seam would let a test check that only the error code is logged.

## Texts and docs (23)

- **False since that round:** the startup check runs before
  `src/lib/config.js` loads, not "right after"; the manual's "starting it
  again fails, its port still in use" holds only for the server (say to
  let a headless bot exit first); stale lines in the shipped-defaults
  loader's header and the il-guard docs; counts ("three providers",
  "triples", "four-per-second", the `--help` command counts, README's
  `--help` list lacking the new command); the g4mm4 note on the wrong
  CLAUDE.md row (it was `RPC_URL`'s default); a diagnostic example that
  now shows the default endpoint; lists missing that round's additions.
- **Words an operator reads:** the stop message's "Start it again once
  the file can be read and written" even for invalid JSON ("once you have
  put the file right"); a write into a missing folder told "it is not
  there. Restore the file."; "delete it if it is a cache" naming no
  folder, so the position records (not rebuildable) could pass for one
  (name `app-data/scan-cache/`); the Other Error line implying a server
  started with `PRIVATE_KEY` alone sends the alert; three places saying
  the alert is always sent; the delete command's "LP Ranger starts now"
  against "the server starts"; commands not named in full; README's
  upgrade steps without a way to stop a headless bot.

**Not findings:** a second headless bot started while the first stops is
the operator's choice ([[feedback_bad_operator_not_a_bug]]); `npm run
gentle-stop -- --help` stopping the server is documented.

**For the release notes:** an operator whose `.env` was copied from the
old example still names g4mm4 first and should edit it.
