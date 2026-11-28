# Working on the LP Ranger Disclosure

Companion to [CLAUDE.md](../../CLAUDE.md). An internal working guide for
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
| Disclosure source | [`src/client/web/disclosure.html`](../../src/client/web/disclosure.html) | **Canonical content.** Standalone page served via GitHub Pages and the only file to edit for text changes. |
| Generator | [`scripts/build-disclosure-content.js`](../../scripts/build-disclosure-content.js) | Extracts the `<!-- DISCLOSURE:CONTENT:START/END -->` region and emits `src/client/web/js/disclosure-content.js` during `npm run build`. |
| Generated in-app module | `src/client/web/js/disclosure-content.js` (gitignored) | Built artifact. `DISCLOSURE_HTML` / `DISCLOSURE_VERSION` consumed by the startup modal and Settings → Disclosure. Never edit by hand. |
| Version stamp | `Disclosure version: YYYY-MM-DD` line inside the content markers | Parsed by the generator into `DISCLOSURE_VERSION`. Single source of truth for the date. |
| Renderer | [`src/client/web/js/dashboard-helpers.js`](../../src/client/web/js/dashboard-helpers.js) — `_populateDisclosure()` / `initDisclaimer()` | Inserts `DISCLOSURE_HTML` into `#disclaimerBody`; logs the version each time it fills the modal: on load, and on each opening from Settings → Disclosure. |
| Styling | [`src/client/web/css/style.css`](../../src/client/web/css/style.css) — `.disclaimer-*` classes | Accent-colored `<h3>` headings, modal layout. The standalone page reuses the same stylesheets plus `help.css` for page layout. |
| Acknowledgment gate | `initDisclaimer()` → Accept / Decline buttons | No suppression mechanism — the modal appears on every launch. |

To change the disclosure text, edit `src/client/web/disclosure.html` only and run
`npm run build`. Do not edit `src/client/web/js/disclosure-content.js` — it is
overwritten on every build and is gitignored.

An older working brief at `docs/disclosure/disclosure.txt` is temporary
and will be removed once the in-app disclosure is complete — **do not
treat it as authoritative**.

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
  wallet addresses, or position state is a disclosure edit. The
  disclosure names the aggregator, the rpc endpoints, and the token list
  and its logo images; it does not name the price services the bot asks
  (Moralis, GeckoTerminal, DexScreener) or the Telegram api that carries
  the operator's alerts. Any further outbound call is a disclosure edit.
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
| Risk Disclaimer and Limitation of Liability | [`src/server.js`](../../src/server.js) file-header disclaimer, [`src/client/web/index.html`](../../src/client/web/index.html) disclosure modal |
| Venue Relationships — No Affiliation | [`src/bot/rebalancer-aggregator.js`](../../src/bot/rebalancer-aggregator.js), [`src/bot/rebalancer-swap.js`](../../src/bot/rebalancer-swap.js), [`src/bot/rebalancer-pools.js`](../../src/bot/rebalancer-pools.js), [`app-config/app-defaults-for-user-configurable/chains.json`](../../app-config/app-defaults-for-user-configurable/chains.json) |
| Token Logos | [`src/client/web/js/dashboard-token-logos.js`](../../src/client/web/js/dashboard-token-logos.js), [`src/client/web/js/dashboard-init.js`](../../src/client/web/js/dashboard-init.js) (the list is read only once the Disclosure is accepted), `tokenList` in [`chains.json`](../../app-config/app-defaults-for-user-configurable/chains.json) |
| Transaction History and Post-Trade Data | [`src/bot/rebalance-log.js`](../../src/bot/rebalance-log.js), [`src/bot/bot-recorder.js`](../../src/bot/bot-recorder.js), [`src/bot/position-history.js`](../../src/bot/position-history.js), [`src/client/web/js/dashboard-history.js`](../../src/client/web/js/dashboard-history.js), [`src/client/web/js/dashboard-data-kpi.js`](../../src/client/web/js/dashboard-data-kpi.js); for what is stored: [`src/lib/bot-config-v2.js`](../../src/lib/bot-config-v2.js), [`src/lib/wallet-manager.js`](../../src/lib/wallet-manager.js), [`src/lib/api-key-store.js`](../../src/lib/api-key-store.js), and any `localStorage.setItem` call in `src/client/web/js/dashboard-*.js`; for what leaves the machine: [`src/bot/price-fetcher.js`](../../src/bot/price-fetcher.js), [`src/bot/gecko-pool-cache.js`](../../src/bot/gecko-pool-cache.js), [`src/bot/rebalancer-aggregator.js`](../../src/bot/rebalancer-aggregator.js), [`src/bot/bot-provider.js`](../../src/bot/bot-provider.js) |
| User Education and Parameter Transparency | [`src/client/web/index.html`](../../src/client/web/index.html) form inputs, [`src/lib/config.js`](../../src/lib/config.js), [`src/lib/bot-config-keys.js`](../../src/lib/bot-config-keys.js) `GLOBAL_KEYS` / `SETTING_POSITION_KEYS` |
| MEV Exposure and Data Protection | [`src/bot/rebalancer-swap-impact.js`](../../src/bot/rebalancer-swap-impact.js) `_checkSwapImpact`, [`src/bot/rebalancer-aggregator.js`](../../src/bot/rebalancer-aggregator.js) |
| Cybersecurity | [`docs/security.md`](../security.md), [`CLAUDE-SECURITY.md`](CLAUDE-SECURITY.md) |

If you edit one of these source files in a way that changes externally
observable behavior, check the disclosure.

---

## Formatting Rules

The text between the content markers in `src/client/web/disclosure.html`
is HTML. Keep the conventions it already uses:

- **HTML, not Markdown.** Section heads are `<h3>`; emphasis is
  `<strong>`; lists are `<ul>` / `<ol>`; paragraphs are `<p>`.
- **HTML entities for punctuation.** Em dashes render as `&mdash;`,
  en dashes as `&ndash;`, curly apostrophes as `&rsquo;`. This keeps
  the text readable when pasted into legal review tools.
- **US date format in prose.** Statutory dates appear as written in
  the source statute (e.g. "April 13, 2026"). The `Disclosure version:`
  line uses ISO `YYYY-MM-DD`.
- **No emojis, no color adjectives, no marketing tone.** The voice is
  plainspoken and factual. "LP Ranger charges no fees" — not "LP
  Ranger is proud to charge no fees."
- **External links get `target="_blank" rel="noopener noreferrer"`.**
  (See the Apache license link near the bottom of the file.)
- **CSS classes use the `9mm-pos-mgr-` prefix** when introducing new
  styling hooks (same convention as the rest of the dashboard).
- **No inline `style="..."`**. Add a class to the stylesheet instead.

`npm run lint` holds `disclosure.html` to `html-validate`, as it does
every page in `src/client/web/`; neither Prettier nor ESLint reads it, or
the module built from it. The generator escapes backslashes, backticks
and `${` in the text, so none of them can break the module it writes.

---

## Version-Bump Protocol

The `Disclosure version: YYYY-MM-DD` line in `disclosure.html`, which
the build turns into `DISCLOSURE_VERSION`, is the user-visible version
date. **Any** textual change to the disclosure requires bumping it.
Trivial-looking edits (whitespace, entity substitutions, reordering
list items) still count — the whole point of the version is to let a
returning user notice that the text has changed since they last
acknowledged it.

Bump steps:

1. Edit the text between the content markers in
   `src/client/web/disclosure.html`.
2. Set its `Disclosure version:` line to today's date, in `YYYY-MM-DD`
   form.
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
3. Click **Exit** — the app-disabled overlay should engage and
   block interaction.
4. Reload; click **I HAVE READ AND UNDERSTOOD THIS DISCLOSURE** — dashboard unlocks.
5. Settings gear → **Disclosure** — the same text must render, with
   the same version stamp.
6. The browser console holds `[lp-ranger] Disclosure version: <date>`
   once for the load, and once more each time Settings → Disclosure is
   opened: two lines after step 5.

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
