# Clear Out Older Rule Violations

> **Status:** Clean-up &mdash; not a bug. Nothing here changes what the
> app does, and funds are never at risk.

## Plain language

Some code written before a rule existed still breaks it. The audit of
2026-10-17 found three kinds while it checked that day's work, and left
them alone because they predate it. Later audits left a fourth kind,
in new code as well as old, for the user to decide, and on 2026-10-18
the user put it here: truthy checks on an element or an object. Each
makes the code harder to trust or to read. None makes it wrong.

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
`console.error`; for a module that logs through `src/lib/log.js`, its
`log._setSinkForTests` seam makes that swap unnecessary. Three swap
`setTimeout`, where `price-source-backoff._setDelays` and
`bot-provider._setDelaysForTests` cover some cases.

**Re-exports.** A module exports only what it defines, and consumers
import from the module that owns a name. A re-export makes a second
module look like the owner, so a search for a name's definition lands
in the wrong place, and every refactor has to update the copy too.
Eight runtime modules re-export names they import:

- `src/lib/config.js` re-exports seven values it takes from
  `src/lib/runtime-flags.js`: the port, the private key, the dry-run and
  verbose flags, and the chain. The header of `runtime-flags.js` calls
  this deliberate, so that existing callers keep working.
- `src/lib/price-fetcher.js` re-exports the price gate's pause functions
  and the cascade's `tryPriceSources`.
- `src/lib/bot-loop.js`, `src/lib/bot-cycle.js`, `src/lib/bot-recorder.js`,
  `src/lib/bot-pnl-updater.js`, `src/lib/pnl-tracker.js` and
  `src/lib/position-details.js` re-export helpers, mostly for their tests.

`src/client/web/ethers-adapter.js` is not on the list. It adapts an npm package
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

**Truthy checks on an element or an object.** A check for whether a
value is present is written out, `x !== undefined && x !== null`, never
`if (x)`, which also reads `0`, `""` and `false` as absent. The rule is
in [CLAUDE-BEST-PRACTICES.md](../../claude/CLAUDE-BEST-PRACTICES.md),
under Type Checks. An element or an object is never falsy, so these
checks answer correctly, but only a reader who knows what the value can
hold can see that. A scan of what each checked variable was assigned
finds:

- 511 checks on an element, such as `if (el)` and
  `if (!frag) return null`, all but three on what `g()`,
  `getElementById`, `querySelector`, `closest` or `cloneTpl` found. Of
  these, 501 are in 50 dashboard files, 8 were in `src/lib/ui-state.js`
  and 2 are in `scripts/lint-svg.js`. That module was removed on
  2026-10-25, since no part of the app loaded it.
- 57 on the active position, `posStore.getActive()`, in the dashboard.
- Dozens on another object: a `Map`'s entry, a `find` result, a
  regular expression's match, a caught error. Some values checked this
  way are a number or a string instead, such as a timestamp a `Map`
  holds, so each one needs reading.

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
- **Truthy checks:** write each as an explicit check, one file at a
  time.

Measure again before starting. The counts are from 2026-10-17, those
of truthy checks from 2026-10-18.
