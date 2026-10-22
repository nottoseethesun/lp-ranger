---
name: project-disk-layout-philosophy
description: "Three-tier disk layout invariant (config / data / logs). Only two subdirs allowed at the top of app-config/; new persistent files go to the right tier based on whether they're config, durable runtime data, or write-only diagnostic output."
metadata: 
  node_type: memory
  type: project
  originSessionId: ee80f1a7-2778-41af-8f18-a3f5993e9278
  modified: 2026-10-21T16:34:29.413Z
---

LP Ranger persists state to three distinct top-level directories,
each with a sharply different semantic:

| Dir | Holds | Read back by the app? | Survives tarball upgrade? |
|-----|-------|-----------------------|---------------------------|
| `app-config/` | Configuration (defaults + per-install overrides). | Yes — read at every startup. | Defaults are overwritten on upgrade; operator overrides under `user-configurable/` survive. |
| `app-data/` | Durable per-install runtime DATA the app reads back later (e.g. `rebalance_log.json` consumed by `position-history.js`). | Yes — read on demand. | Yes (gitignored, tarball-excluded). |
| `logs/` | Write-only diagnostic output (e.g. `lp-ranger.log` written by `src/log-file.js`). | NO — the app never reads its own logs. | N/A — fully gitignored, tarball-excluded, auto-created on first write, never backed up. |

**`app-config/` has a hard "only two subdirs at the top" invariant:**

- `app-config/app-defaults-for-user-configurable/` — tracked, shipped
  defaults (overwritten on tarball upgrade — operators must not edit).
- `app-config/user-configurable/` — operator-specific overrides and
  runtime state (gitignored contents, tracked `README.md`).

Files directly under `app-config/` itself are NOT allowed. Per
[[project-approaching-battle-tested]], this invariant was established
in release 0.8.2 (2026-06-21) when runtime files moved out of the top
of `app-config/`.

**How to apply:**

- When adding a new persistent file, decide first: is it config, is
  it durable runtime data the app reads back, or is it write-only
  diagnostic output? Pick the matching tier.
- Do NOT put a new file directly under `app-config/` — it must go
  under one of the two subdirs (or under `app-data/` / `logs/` if
  it's the wrong category for `app-config/` entirely).
- The auto-snapshot for `bot-config.json` (the config-stomp safety
  net per [[project-config-stomp-investigation]]) lives at
  `app-config/user-configurable/bot-config.backup.json` and
  regenerates on every successful `loadConfig` that does not pass
  `skipBackups` (the server's and the bot's at start; a util/ tool's
  read of the price library's settings passes it, since 2026-10-21). Don't propose
  removing it without checking [[project-config-stomp-investigation]]
  first.
- `migrate-app-config.js` handles legacy root-layout files (the
  pre-`app-config/` era); it does NOT migrate from the intermediate
  pre-`user-configurable/` layout (that was a clean-break in 0.8.2,
  documented in the breaking-change release-notes callout — see
  [[reference-release-notes-header]]).
