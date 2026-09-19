---
name: Pi 5 recommendation phrasing (exact text)
description: Whenever Raspberry Pi 5 is mentioned in user-facing or doc text, follow it with "(recommended configuration: with Heat Sink and Fan, 5GB RAM, and Ethernet cable Internet connection instead of Wi-Fi)".
type: project
originSessionId: 2026-05-04-pause-fetch-fix
modified: 2026-09-19T16:50:52.565Z
---

**Standardized phrasing (verbatim, revised 2026-09-19):**

> Raspberry Pi 5 (recommended configuration: with Heat Sink and Fan, 5GB RAM, and Ethernet cable Internet connection instead of Wi-Fi)

The whole recommendation now sits inside the parentheses. The earlier
form left "with Heat Sink and Fan" outside them, which read as a claim
about the reader's hardware rather than as advice about what to buy.

This is the canonical form for **every** Pi 5 mention — README, help/manual page, engineering notes, and code comments alike. Even casual mentions ("on hardware like Raspberry Pi 5") and contextual mentions in code/JSON comments use the full phrase.

**Why:** The user wants the operator-environment recommendation to travel with the hardware reference so anyone copying a Pi 5 setup gets all three components (heat sink + fan, 5 GB RAM, wired Ethernet). The user explicitly extended the rule to non-recommendation mentions on 2026-05-04: "And those should include 'with Heat Sink and Fan' as well."

**How to apply:**
- New doc/comment that mentions a Pi 5: paste the full phrase.
- Editing existing text that mentions a Pi 5 in a different form: rewrite to the canonical form.
- Notable: "5GB" (no space) and "Wi-Fi" (hyphenated, capital W and F) are how the user wrote it — preserve spelling.
- On 2026-09-19 the sweep to the revised form finished. Every mention
  carrying the old wording now uses it: `README.md`, `docs/security.md`,
  `public/dashboard-helpers.js`, `public/help-and-user-manual.html`
  (three spots), and `app-config/app-defaults-for-user-configurable/csrf.json`.
  Grep the whole repo before assuming a location is current — the
  csrf.json one was missed by an earlier inventory that listed only four.
- Bare mentions ("e.g. a Pi 5", "arm64 / Raspberry Pi") were left bare,
  pending the user's call: `public/dashboard-init.js`,
  `public/dashboard-data-poll.js`, `docs/engineering.md` (a heading),
  `docs/configuration.md`, `README.md` line 85, and the issue template.
  Some are platform references rather than hardware advice, and line 85
  sits one line under the full phrase.
