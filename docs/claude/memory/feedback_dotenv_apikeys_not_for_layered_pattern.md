---
name: feedback-dotenv-not-for-layered-pattern
description: "`.env` stays outside the `app-config/` layered defaults+overrides pattern. (`api-keys` IS now under `user-configurable/` structurally — file moved 2026-06-21 — but does not use deep-merge semantics; the encrypted blob is a write-target, not a tunable.)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: ee80f1a7-2778-41af-8f18-a3f5993e9278
  modified: 2026-10-24T04:57:19.761Z
---

The layered
`app-config/app-defaults-for-user-configurable/` +
`app-config/user-configurable/` pattern (with deep-merge overlay via
`src/lib/load-merged-defaults.js`) is for **tunable JSON files** — values
that ship with a sensible default and that operators may want to
override per-install.

`.env` is **outside this pattern**: it holds credentials, secrets,
and runtime flags that have no shipped default because they're
personal to the install (private key, wallet password). It is loaded
by `dotenv` from the project root and the project ships only
`.env.example` as documentation.

`api-keys.json` reversed on 2026-06-21. **It IS now under
`app-config/user-configurable/api-keys.json`** as part of the
"only-two-subdirs-under-app-config/" reorg
([[project-approaching-battle-tested]] clean-break). But it uses the
directory STRUCTURALLY only — not the deep-merge `loadMergedDefaults`
semantics. The encrypted blob is a write-target, not a read-time-
merged JSON tunable. The tracked format template lives at
`app-config/app-defaults-for-user-configurable/api-keys.example.json`
(also moved during the reorg).

**Why:** User mandate (2026-06-21) clarified the rule. The original
"basic-user-settings stay where they are" framing was correct for
`.env` but the user opted in mid-conversation to migrate `api-keys`
structurally to fit the "only two subdirs under app-config/"
constraint, even though the deep-merge does not apply to it.

**How to apply:**

- Do NOT flag `.env` as a candidate for migration to the layered
  pattern. It is a deliberately separate category.
- `api-keys.json` already lives under `user-configurable/` after the
  reorg; do not propose moving it back. Do NOT pipe its load through
  `loadMergedDefaults` — encrypted blobs are not deep-merged.
- The README's Update section carries `.env` forward via
  `util/update/migrate-app-state.js`, alongside
  everything under `app-config/user-configurable/` (which includes
  the operator's `api-keys.json`) plus `app-data/` — this is the
  authoritative carry-forward list.
- Telegram bot token + chat ID ride inside the encrypted
  `api-keys.json` (set via `setBotToken` / `setChatId` from the
  dashboard's Telegram settings); they are NOT in `.env`.
