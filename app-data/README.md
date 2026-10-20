# Per-install runtime data

This directory holds per-install runtime data written by the app itself: the rebalance log, each position's records in `position-records.json` (its HODL baseline, compound history, gas, lifetime deposit and residuals, kept apart from the settings in `app-config/user-configurable/bot-config.json`), and in `scan-cache/` what the app has read from the blockchain and the price services. The app can read the scan caches again if they are deleted, at about an hour per position; `npm run clear-blockchain-scan-cache` empties that folder. **Do not edit by hand.** Editing while the app is running can corrupt the file mid-write; editing while it is stopped risks data loss on the next run if your edits do not match the on-disk format the app expects.

`util/bookkeeping/` holds the csv reports the bookkeeping tools write when you run them ([`docs/bookkeeping-for-coins-in-transactions.md`](../docs/bookkeeping-for-coins-in-transactions.md)). The app itself neither reads nor writes them, and a report deleted here is gone until you run its tool again.

Everything in this directory is gitignored and is excluded from the release tarball, so it survives tarball upgrades. To wipe this directory, stop the app first; the next start will recreate the files as needed.

For the full layout and how this directory relates to `app-config/`, see the [`docs/engineering.md`](../docs/engineering.md#the-app-config-directory) reference.
