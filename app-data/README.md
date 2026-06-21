# Per-install runtime data

This directory holds per-install runtime data written by the app itself: history logs and similar records. **Do not edit by hand.** Editing while the app is running can corrupt the file mid-write; editing while it is stopped risks data loss on the next run if your edits do not match the on-disk format the app expects.

Everything in this directory is gitignored and is excluded from the release tarball, so it survives tarball upgrades. To wipe this directory, stop the app first; the next start will recreate the files as needed.

For the full layout and how this directory relates to `app-config/`, see the [`docs/engineering.md`](../docs/engineering.md#the-app-config-directory) reference.
