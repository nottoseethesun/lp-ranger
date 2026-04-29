# Log-to-File

Add automatic log-to-file capture: tee server stdout/stderr to
`app-config/lp-ranger.log` (with size-based rotation) so a full log
accumulates on disk even when running on hardware with limited
terminal scrollback (e.g. a Pi 5).

## Why

When a runtime issue surfaces during long-running operation,
diagnosis depends on having the full server log handy. Pi 5
terminals truncate scrollback, so without an on-disk capture a user
ends up copying log chunks piecemeal.

Workaround in the meantime:

```bash
npm start 2>&1 | tee -a app-config/lp-ranger.log
```

## Design when prioritized

- **CLI flag** (e.g. `node server.js --log-file` or
  `--log-file=<path>`), opt-in. Off by default so existing users
  see no behavior change. Wire through `src/cli-help.js`.
- **Settings toggle** in the dashboard — toggle persisted to
  `.bot-config.json` (global section). CLI flag and Settings toggle
  compose: either one enables it. CLI flag wins for path; Settings
  just toggles on/off using the default path.
- Pure-additive: write the same lines to stdout AND file, no
  behavior change, no formatting change.
- Rotate by size (e.g. 10 MB), keep N rolled files.
- Default path under `app-config/lp-ranger.log` so it follows the
  app-managed config layout convention (already gitignored).
