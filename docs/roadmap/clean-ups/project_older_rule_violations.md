# Clear Out Older Rule Violations

> **Status:** Clean-up &mdash; not a bug. Nothing here changes what the
> app does, and funds are never at risk.

## Plain language

Some code written before a rule existed still breaks it. The audit of
2026-10-17 found three kinds while it checked that day's work, and left
them alone because they predate it. Each makes the code harder to trust
or to read. None makes it wrong.

## Detail

**Test global swaps without their label.** A test may replace a
JavaScript global, such as `fetch` or `console.log`, only where no seam
exists, and every such swap carries a comment that opens
`TEST-ONLY global swap:`. The label is what lets one search find every
use of the exception. The rule is in
[CLAUDE-BEST-PRACTICES.md](../../claude/CLAUDE-BEST-PRACTICES.md), under
Core Essentials. Of the 78 test files that swap a standard global, 68
carry no such label anywhere. Most swap `fetch` or
`Module.prototype.require`. Ten swap `console.log`, `console.warn` or
`console.error`; for a module that logs through `src/log.js`, its
`log._setSinkForTests` seam makes that swap unnecessary. Three swap
`setTimeout`, where `price-source-backoff._setDelays` and
`bot-provider._setDelaysForTests` cover some cases.

**Re-exports.** A module exports only what it defines, and consumers
import from the module that owns a name. A re-export makes a second
module look like the owner, so a search for a name's definition lands
in the wrong place, and every refactor has to update the copy too.
Eight runtime modules re-export names they import:

- `src/config.js` re-exports seven values it takes from
  `src/runtime-flags.js`: the port, the private key, the dry-run and
  verbose flags, and the chain. The header of `runtime-flags.js` calls
  this deliberate, so that existing callers keep working.
- `src/price-fetcher.js` re-exports the price gate's pause functions
  and the cascade's `tryPriceSources`.
- `src/bot-loop.js`, `src/bot-cycle.js`, `src/bot-recorder.js`,
  `src/bot-pnl-updater.js`, `src/pnl-tracker.js` and
  `src/position-details.js` re-export helpers, mostly for their tests.

`public/ethers-adapter.js` is not on the list. It adapts an npm package
for the dashboard bundle, by design.

**History in CLAUDE.md.** Technical docs describe how the system works,
not how it came to work that way: the incident belongs in a commit
message or a memory file. Four CLAUDE.md passages recount one:

- the `TX_SPEEDUP_SEC` row of the key-config table, on three copies of
  a rule that gave three answers;
- "Unified RPC failover", on an outage of 2026-09-29;
- "Global RPC request pacing", on incidents of 2026-09-27 and
  2026-09-30;
- "Slippage is two settings, one per token", on the retired third
  setting.

## Fix when prioritized

Each kind is separate work, and none needs the others.

- **Swaps:** label each one, or move it to a seam where the module has
  one or easily could.
- **Re-exports:** point every importer, tests included, at the owning
  module, then drop the re-export. The one in `config.js` touches the
  most files.
- **CLAUDE.md:** keep each passage's reason and drop the incident:
  state the invariant, what breaks without it, and where it is
  enforced.

Measure again before starting. The counts are from 2026-10-17.
