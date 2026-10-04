# Log-to-File

> **Status:** Nice-to-have / polish — not a bug. The app works
> correctly without this. Funds are never at risk. The capture itself
> has shipped; what is left is convenience and housekeeping.

Tee server stdout and stderr to `logs/lp-ranger.log` so a full log
accumulates on disk even when running on hardware with limited terminal
scrollback, such as a Pi 5.

## Why

When a runtime issue surfaces during long-running operation, diagnosis
depends on having the full server log handy. Pi 5 terminals truncate
scrollback, so without an on-disk capture a user ends up copying log
chunks piecemeal.

## What has shipped

- **The capture.** Every line written to stdout or stderr is mirrored
  into the file, including `log.info`/`warn`/`error` and raw `console.*`
  calls. Colour escapes are stripped from the file so it greps cleanly;
  the terminal still shows colour.
- **The CLI flag.** `--log-file [PATH]` turns it on for one run and
  overrides both the enabled setting and the path. Documented in
  `src/cli-help.js`, alongside `--delete-pre-existing-log-file`.
- **The persistent setting.** `enabled` and `path` in
  `app-config/app-defaults-for-user-configurable/logging.json`, default
  off, for a long-lived production tail.
- **The default path**, `logs/lp-ranger.log`, following the app-managed
  config layout convention and already gitignored.

Implementation lives in `src/log-file.js` and `src/boot-log-file.js`.

## What remains

- **Settings toggle in the dashboard.** Opting in today means passing a
  CLI flag or hand-editing JSON. A toggle would persist to the global
  section of `bot-config.json`. The flag and the toggle should compose:
  either one enables it, the flag wins for path, the toggle only turns
  it on and off using the default path.
- **Size-based rotation.** The file is opened in append mode and grows
  unbounded; the shipped note tells operators to rotate or truncate it
  externally. Rotating by size, keeping a few rolled files, would remove
  that chore.
