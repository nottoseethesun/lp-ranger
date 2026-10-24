---
name: respect-engineering-invariants-in-every-corner
description: Never violate single-source-of-truth or singleton-required invariants out of expedience; a duplicated resolution path counts even when no literal is duplicated
metadata:
  node_type: memory
  type: feedback
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-10-24T04:54:38.336Z
---

Do not take shortcuts that violate baseline engineering practice — even in places that "feel" peripheral (HTML defaults, test setup, throwaway helpers, init code). The user assumes basic invariants are upheld everywhere and won't think to check the corners.

**Why:** Two real incidents drove this. (1) Real data defaults hard-coded into HTML `value=` attributes — the server should be the single source of truth, and when the HTML defaults were stripped, latent bugs surfaced (false CAPPED throttle badge, plus five other never-synced throttle fields). (2) Multiple `NonceManager` instances wrapping the same wallet — the single biggest source of pre-burn-in prod instability. Both were violations the user never thought to audit because they're so basic.

**A duplicated RESOLUTION PATH is as bad as a duplicated literal, and
harder to see.** (3) Building the Impermanent Loss Guard, I wrote two
reads of `impermanentLossGuardPct` ten minutes apart: the bot resolved it
via `readBotConfigDefaults()`, and the dashboard badge — added later, to
fix an unrelated em-dash — via a new `config.IMPERMANENT_LOSS_GUARD_PCT`
that layered `process.env` on top. **No literal was duplicated. Both read
the same JSON.** But `IMPERMANENT_LOSS_GUARD_PCT=30` then showed 30 on
the badge while the bot enforced 50 — the UI lying about what the bot
does, on a setting that decides whether a rebalance happens. Every check
listed below would have passed it. Caught only on a second audit pass,
after the user asked for one.

The trigger to watch for is not "am I copying a value" but **"am I adding
a SECOND reader of a value that already has one?"** If a value is both
displayed and acted upon, the display and the action must resolve through
the same expression — not merely the same file. Fixed by having both go
through `config.*`, and pinned by a test that sets the env var in a child
process and asserts the badge figure and the enforced behaviour move
together.

**A second reader is not automatically a second resolution path.**  On
the follow-up audit I flagged the Bot Settings input as a third
disagreeing reader, because it prefills from `/api/bot-config-defaults`,
which cannot see `process.env` — and ripped the env layer out to "fix"
it.  Wrong: `buildStatusPositions` spreads `posDefaults` into every
position payload, so the first `/api/status` poll overwrites the box with
the same `config.*` figure.  The endpoint value paints the field for one
poll at startup and nothing more.  Env-over-JSON is this project's
documented layering (`src/lib/config.js` header) and the reason a headless
install can set anything at all.  **Trace the value to the pixel before
calling two readers a divergence, and never drop an established pattern
on the strength of a reading — [[feedback-instrument-before-inferring]]
applies to config plumbing too.**

**How to apply:** When writing or reviewing any code, ask:
- Is there a single source of truth for this value? Am I duplicating it (HTML default + server config + client default)?
- Does another module already read this value? Do we resolve it identically — same layering of env, operator override, and shipped default? Two readers of one file can still disagree.
- Is this value both shown to the user and acted on by the bot? Those two must not have separate resolution paths.
- Does this object have a singleton invariant (NonceManager, signer, provider, mutex, cache)? Am I instantiating a second one anywhere — including init paths, per-position helpers, or test setup against the same wallet?
- Am I reading state from the wrong layer (client memory instead of server, HTML attribute instead of API response)?

These checks apply to init code, helpers, tests, and "obvious" plumbing — not just the main happy path.
