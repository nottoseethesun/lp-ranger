# Working on the LP Ranger Disclosure

Companion to [CLAUDE.md](../CLAUDE.md). An internal working guide for
Claude sessions that edit the app's regulatory disclosure text — not a
legal artifact, not a substitute for legal review, and not a
restatement of the disclosure itself.

---

## What the Disclosure Is

LP Ranger displays a disclosure on every app launch and in
Settings → Disclosure. The text is written to comply with the **SEC
Staff Statement Regarding Broker-Dealer Registration of Certain User
Interfaces Utilized to Prepare Transactions in Crypto Asset
Securities** (File No. 4-894, April 13, 2026) — the "Covered User
Interface Providers" statement.

It establishes three factual framings the software depends on:

- The **Creator**, **Offeror**, and **Operator** roles and their
  regulatory posture under the Staff Statement.
- LP Ranger's lack of affiliation with 9mm, 9mm Pro V3, PulseChain, or
  any related venue.
- What data the software collects, stores, and transmits — and what it
  does not.

Factual inaccuracy in the disclosure is a regulatory problem, not a
style problem. Treat every edit with that weight.

---

## Single Source of Truth

| Artifact | Path | Role |
| -------- | ---- | ---- |
| Disclosure text | [`public/disclosure-content.js`](../../public/disclosure-content.js) | Canonical content. `DISCLOSURE_HTML` is shown in the startup modal and Settings → Disclosure. |
| Version stamp | `DISCLOSURE_VERSION` (same file) | ISO `YYYY-MM-DD` date. Displayed at the bottom of the disclosure. |
| Renderer | [`public/dashboard-helpers.js`](../../public/dashboard-helpers.js) — `_populateDisclosure()` / `initDisclaimer()` | Inserts `DISCLOSURE_HTML` into `#disclaimerBody`; logs the version on load. |
| Styling | [`public/style.css`](../../public/style.css) — `.disclaimer-*` classes | Accent-colored `<h3>` headings, modal layout. |
| Acknowledgment gate | `initDisclaimer()` → Accept / Decline buttons | No suppression mechanism — the modal appears on every launch. |

There is no other copy in the repo. An older working brief at
`docs/disclosure/disclosure.txt` is temporary and will be removed once
the in-app disclosure is complete — **do not treat it as authoritative**.

---

## When an Edit Is Required

Not every code change touches the disclosure. An edit **is** required
when a change falsifies a disclosed fact. Specifically:

- **Fees change.** Disclosure currently says LP Ranger charges no fees.
  Any change to that is a disclosure edit.
- **Affiliation changes.** Any new relationship with a venue, protocol,
  or counterparty (compensation, referral, revenue share, contractual)
  invalidates the "No Affiliation" section.
- **New data leaves the machine.** A new analytics hit, telemetry
  endpoint, or third-party API call that transmits trade data,
  wallet addresses, or position state is a disclosure edit. Current
  outbound surface (price APIs, aggregator, RPC) is already disclosed;
  additions are not.
- **New post-trade data displayed.** The disclosure enumerates what is
  shown (TX hashes, amounts, USD values, gas, tick range, history).
  New categories (e.g. realized-PnL projections, counterparty
  attribution) warrant an update.
- **Default parameter changes.** If a disclosed default is referenced
  explicitly in the text, update both the default and the disclosure.
  **Non-disclosed defaults** (e.g. `TX_SPEEDUP_SEC`, `TX_CANCEL_SEC`,
  gas bump multiplier) do not require a disclosure edit.
- **New custodial behavior.** Any code path that moves user funds
  outside the Operator's own wallet is a fundamental disclosure
  change — and likely a fundamental architectural change that needs
  legal review before it ships.

Edits that **do not** touch the disclosure: refactors, performance
work, UI polish, bug fixes that don't change externally observable
behavior, adding internal log lines, test-only changes, documentation
updates elsewhere.

---

## Cross-Reference — Section ↔ Source

Before editing a disclosure section, re-read the source files whose
behavior it describes. This is the single most common failure mode —
editing the text in a way that no longer matches the code.

| Disclosure section | Source files to re-read |
| ------------------ | ----------------------- |
| Creator / Offeror / Operator roles | No source — factual/legal framing only |
| Warranty disclaimer | [`server.js`](../../server.js) file-header disclaimer, [`public/index.html`](../../public/index.html) disclosure modal |
| Venue Relationships — No Affiliation | [`src/rebalancer-aggregator.js`](../../src/rebalancer-aggregator.js), [`src/rebalancer-swap.js`](../../src/rebalancer-swap.js), [`src/rebalancer-pools.js`](../../src/rebalancer-pools.js), [`app-config/static-tunables/chains.json`](../../app-config/static-tunables/chains.json) |
| Data Storage (server-side) | [`src/bot-config-v2.js`](../../src/bot-config-v2.js), [`src/wallet-manager.js`](../../src/wallet-manager.js), [`src/api-key-store.js`](../../src/api-key-store.js), [`src/bot-recorder.js`](../../src/bot-recorder.js) |
| Data Storage (client-side) | `public/dashboard-*.js` — any `localStorage.setItem` call |
| External APIs contacted | [`src/price-fetcher.js`](../../src/price-fetcher.js), [`src/gecko-pool-cache.js`](../../src/gecko-pool-cache.js), [`src/rebalancer-aggregator.js`](../../src/rebalancer-aggregator.js), [`src/bot-provider.js`](../../src/bot-provider.js) |
| Transaction History / Post-Trade Data | [`src/bot-recorder.js`](../../src/bot-recorder.js), [`src/position-history.js`](../../src/position-history.js), [`public/dashboard-history.js`](../../public/dashboard-history.js), [`public/dashboard-data-kpi.js`](../../public/dashboard-data-kpi.js) |
| User-Customizable Parameters (if/when added to in-app disclosure) | [`public/index.html`](../../public/index.html) form inputs, [`src/config.js`](../../src/config.js), [`src/bot-config-v2.js`](../../src/bot-config-v2.js) `GLOBAL_KEYS` / `POSITION_KEYS` |
| MEV Exposure (if/when added) | [`src/rebalancer-pools.js`](../../src/rebalancer-pools.js) `_checkSwapImpact`, [`src/rebalancer-aggregator.js`](../../src/rebalancer-aggregator.js) |
| Cybersecurity Controls (if/when added) | [`docs/engineering.md`](../engineering.md) § Security, [`CLAUDE-SECURITY.md`](CLAUDE-SECURITY.md) |

If you edit one of these source files in a way that changes externally
observable behavior, check the disclosure.

---

## Formatting Rules

`disclosure-content.js` is an ES module that exports an HTML string
literal. Keep the conventions the file already uses:

- **HTML, not Markdown.** Section heads are `<h3>`; emphasis is
  `<strong>`; lists are `<ul>` / `<ol>`; paragraphs are `<p>`.
- **HTML entities for punctuation.** Em dashes render as `&mdash;`,
  en dashes as `&ndash;`, curly apostrophes as `&rsquo;`. This keeps
  the text readable when pasted into legal review tools.
- **US date format in prose.** Statutory dates appear as written in
  the source statute (e.g. "April 13, 2026"). The `DISCLOSURE_VERSION`
  constant uses ISO `YYYY-MM-DD`.
- **No emojis, no color adjectives, no marketing tone.** The voice is
  plainspoken and factual. "LP Ranger charges no fees" — not "LP
  Ranger is proud to charge no fees."
- **External links get `target="_blank" rel="noopener noreferrer"`.**
  (See the Apache license link near the bottom of the file.)
- **CSS classes use the `9mm-pos-mgr-` prefix** when introducing new
  styling hooks (same convention as the rest of the dashboard).
- **No inline `style="..."`**. Add a class to the stylesheet instead.

The file is listed in the Prettier and ESLint scopes like any other
dashboard module, so formatting is auto-enforced. If a manual edit
breaks the template-literal string (unclosed backtick, unmatched
`${...}`), the esbuild bundle will fail at `npm run build`.

---

## Version-Bump Protocol

The `DISCLOSURE_VERSION` stamp is the user-visible version date.
**Any** textual change to `DISCLOSURE_HTML` requires bumping it.
Trivial-looking edits (whitespace, entity substitutions, reordering
list items) still count — the whole point of the version is to let a
returning user notice that the text has changed since they last
acknowledged it.

Bump steps:

1. Update `DISCLOSURE_HTML` with the new content.
2. Update `DISCLOSURE_VERSION` to today's date in `YYYY-MM-DD` form.
3. Verify `npm run build` succeeds.
4. Manually open the dashboard, confirm the modal shows the new text
   and the new version stamp at the bottom.
5. Confirm `[lp-ranger] Disclosure version: YYYY-MM-DD` logs to the
   browser console on load.

The modal has no "don't show again" checkbox by design — returning
users re-acknowledge on every launch, which is the intended behavior.

---

## Editorial Discipline

- **Preserve wording precisely** unless the user explicitly asks for a
  rewrite. Changing "LP Ranger charges no fees" to "No fees are
  charged" is an unasked-for edit that invites legal review; don't.
- **Don't add legal claims you're not sure about.** If the user asks
  for something like *"…is a non-custodial wallet interface protected
  by XYZ,"* and the code doesn't support XYZ, flag it rather than
  writing it. The disclosure's value is its accuracy.
- **Don't remove statutory references** (e.g. File No. 4-894) or
  warranty language without explicit instruction.
- **Don't summarize or paraphrase "for clarity"** — the current
  verbosity is deliberate. Short, punchy disclosures tend to fail
  regulatory scrutiny.
- **Don't introduce cross-references to internal code** inside the
  disclosure text. Users see this, not source paths.
- **Flag uncertainty explicitly.** If a proposed edit would change the
  meaning of a sentence, ask before shipping. A returning user who
  sees a bumped version date expects a real change, not a typo fix.

---

## How to Test

1. `npm run build && npm start`
2. Open the dashboard — the disclosure modal must appear before the
   main UI activates.
3. Click **Decline** — the app-disabled overlay should engage and
   block interaction.
4. Reload; click **Accept** — dashboard unlocks.
5. Settings gear → **Disclosure** — the same text must render, with
   the same version stamp.
6. Browser console should contain
   `[lp-ranger] Disclosure version: <date>` exactly once per load.

Automated coverage: [`test/disclaimer.test.js`](../../test/disclaimer.test.js)
exercises the acknowledgment flow at the test level.

---

## Related Documents

- [`CLAUDE-SECURITY.md`](CLAUDE-SECURITY.md) — the control matrix
  behind any "Cybersecurity Controls" section that lands in the
  in-app disclosure.
- [`docs/engineering.md`](../engineering.md) § Security — implementation
  detail for the same controls.
- [`docs/claude/CLAUDE-BEST-PRACTICES.md`](CLAUDE-BEST-PRACTICES.md) —
  general editorial discipline; this document extends those rules for
  regulator-facing text.
