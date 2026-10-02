---
name: code-cleanup-nice-to-haves
description: "Running list of code-cleanup nice-to-haves (polish, not bugs). Currently: rename the `9mm-pos-mgr-` CSS class prefix to a letter-first form; merge the two per-NFT fee scans into one pass; stop hanging properties on arrays and add a lint for it."
metadata: 
  node_type: memory
  type: project
  originSessionId: d932d59e-01b4-45db-82b1-6d987abcda8f
  modified: 2026-09-20T22:28:42.547Z
---

Running list of **code-cleanup nice-to-haves**.  Each entry here is polish
— not a bug ([[feedback_nice_to_haves_not_bugs]]).  Nothing on this list
blocks a release; nothing is a regression.  Only surface these items when
the user opens the door to cleanup work (a "what should we tidy up next"
moment or explicit ask).

**Why:** After the 2026-07-19 Auto-compound toggle bug (Prettier 3.9.5
line-wrapped `.\39 mm-pos-mgr-…` into a broken selector — see PR #163
and the isolated repro under `../bug-reports-on-dependencies/`), the user
asked whether we could sidestep the class of problem by simply not
starting CSS class names with a digit.  Answer: yes, but only via a
project-wide sweep, so it's parked here.

**How to apply:** Reference this list when the user asks for a
cleanup pass, or when a new nice-to-have surfaces during other work.
Add new items in place; remove them when they land.

---

## Items

### 1. Rename `9mm-pos-mgr-` CSS class prefix to a letter-first form

Every CSS class in this project currently starts with the digit `9`
(`9mm-pos-mgr-…`), which forces the `\39 ` (or equivalent) hex escape
in every CSS selector.  That escape is what Prettier 3.9.5 mangled in
the compound-toggle incident.

Pick a letter-first prefix (`nine-mm-`, `pm-`, `lpr-`, …), then sweep:

- All CSS selectors under `public/*.css` (≈500+ touches in
  `9mm-pos-mgr.css` alone).
- Every HTML `class="…"` list in `public/index.html`,
  `public/help-and-user-manual.html`, and other served pages.
- JS references: `classList.add/remove/toggle`, `querySelector`,
  `matches`, `getElementsByClassName`, string templates that build
  class attributes.
- Any `data-` lookups or docs that name a class.

Loses the brand-echoes-app-name link
(`"9mm Pro Position Manager" → 9mm-pos-mgr-`), which is why it's a
nice-to-have and not scheduled.

A lighter alternative — a stylelint rule that bans the short-form
`\39 ` escape and requires the six-digit `\000039` form project-wide —
was floated in the same conversation.  It's not on this list yet; add
it only if the user opens the door.

**Prettier bug report package** (isolated repro + ready-to-paste
README) still lives on disk at
`../bug-reports-on-dependencies/prettier-css-hex-escape-linewrap/`.
User set filing aside for now (limited time).  If they revisit it and
the fix lands upstream, this cleanup item becomes strictly optional.

### 2. One scan for per-NFT fees, not two

Per-NFT fee totals are derived twice, from two independent passes over
the same `Collect`/`DecreaseLiquidity` logs, into two different stores:

| | Per-Day P&L table | Lifetime "Fees Compounded" |
| --- | --- | --- |
| store | `tmp/pnl-epochs-cache.json` | `bot-config.json` |
| key | pool identity | composite key |
| filled by | `reconstructEpochs` → `getPositionHistory` | `_classifyAllCompounds` → `classifyCompounds` |
| order | first | second |

Until 2026-09-02 the two used *different formulas* and disagreed — the
table read `Collect(last) − DecreaseLiquidity(last)` and so missed every
fee auto-compound had already swept, showing $149 against a lifetime
$1,084 on the HEX pool. That is fixed: both now call
`lifetimeFeeAmounts` in src/compounder.js. What remains is only the
duplicated *pass*.

Merging them would make a future divergence impossible by construction
and halve the log queries on a full rebuild. The ordering is the
obstacle — epoch reconstruction runs before the compound scan, so the
scan's per-NFT results do not exist yet when epochs are built.

**Explicitly parked by the user (2026-09-02):** "it would be nice if
they worked from the same, but that is a nice-to-have that we will
probably never need to do, because it is small data in the end."
Do not raise it again unless they open the door.

---

**On the public list (2026-09-02).** Item 1 (the CSS prefix rename) is now published on the README's
Nice-to-Have list as "Letter-First CSS Class Prefix", detailed in
`docs/roadmap/clean-ups/project_css_prefix_rename.md`.
Keep the two in step, and do not add a second entry for it.

### Stop hanging properties on arrays (plus a lint for it)

`src/event-scanner.js` attaches `firstMintTimestamp` and
`firstMintBlockNumber` directly to the events array, beside the entries
rather than as entries.  Copying an array copies its entries only, so
`push(...list)`, `slice()`, `map()`, `JSON.stringify()` and
`structuredClone()` all drop them silently.  (`Object.assign([], list)`
happens to keep them, which makes the rule harder to remember, not
easier.)

This cost real time on 2026-09-13.  `bot-recorder.js` does
`events.length = 0; events.push(...found)`, which lost
`firstMintBlockNumber` — the only available lower bound for the OLDEST
NFT in a rebalance chain.  A scan-speed fix that used it therefore
worked on the two dashboard code paths and did nothing at all on the
bot's, which is the slow one.  Patched at that one copy site and pinned
by `test/first-mint-block-survives.test.js`; every other copy site is
still exposed.

Fix has two parts: return
`{ events, firstMintBlockNumber, firstMintTimestamp }` from the scanner
and take them as ordinary values; and add a custom ESLint rule (sibling
to `no-separate-contract-calls.js`) rejecting property assignment onto
an array.  The lint is the part that makes it stay fixed.

Full write-up:
`docs/roadmap/clean-ups/project_no_properties_on_arrays.md`.
