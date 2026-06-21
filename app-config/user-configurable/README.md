# Per-install operator overrides

Most LP Ranger operators don't need anything in this directory &mdash; the app's user interface guides you through every common setting. Read on only if you want to override one of the shipped operator-tunable defaults for your install.

Drop your override files here using the same names as the shipped defaults in the sibling [`../app-defaults-for-user-configurable/`](../app-defaults-for-user-configurable/) directory. The app deep-merges your file on top of the shipped default at read time, with your values winning on every key you set.

Files placed in this directory are gitignored and survive tarball upgrades. The shipped defaults next door are overwritten on every upgrade; your copies here are not.

For the high-level workflow, see the [Configure](../../README.md#configure) section in the project-root README. For the full layout, file inventory, and the rules for where new config files belong, see [The app-config Directory](../../docs/engineering.md#the-app-config-directory) in the engineering reference.
