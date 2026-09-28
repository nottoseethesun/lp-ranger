---
name: Log-to-file feature (nice-to-have, deferred)
description: Auto-write server console output to app-config/lp-ranger.log so Pi 5 scrollback truncation doesn't lose diagnostic context
type: project
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
---
Add automatic log-to-file capture: tee server stdout/stderr to
`app-config/lp-ranger.log` (with size-based rotation) so a full log
accumulates on disk even when the user is running on a Pi 5 with
limited terminal scrollback.

**Why:** During burn-in (release 0.6.5, 2026-04-29) the user hit a
"Compound Failed" Telegram alert and had to copy log chunks
piecemeal from the Pi 5 terminal because scrollback was truncated.
Diagnosis succeeded but only because three separate paste sessions
filled in the gap. A persistent on-disk log would have made it a
single read.

Workaround in the meantime: `npm start 2>&1 | tee -a app-config/lp-ranger.log`.

**How to apply:**
- Deferred until **after** soft-launch — do NOT implement during
  burn-in. Per `project_burn_in_release.md`, stability > features
  and any code change risks resetting the burn-in clock.
- **Expose as a CLI flag** (e.g. `node server.js --log-file` or
  `--log-file=<path>`), opt-in. Off by default so existing users see
  no behavior change. Wire through `src/cli-help.js`.
- **Also switchable from Settings** in the dashboard — toggle
  persisted to `.bot-config.json` (global section). Settings toggle
  and CLI flag should compose: either one enables it. CLI flag wins
  for path; Settings just toggles on/off using the default path.
- When eventually picked up, keep it pure-additive: write same lines
  to stdout AND file, no behavior change, no formatting change.
- Rotate by size (e.g. 10 MB), keep N rolled files.
- Default file path under `app-config/lp-ranger.log` so it follows
  the existing app-managed config layout convention (already
  gitignored).
- Do not implement until user explicitly picks it up.
