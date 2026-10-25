---
name: builtin-before-package
description: "For a new capability, use Node's built-in way first, confirmed in Node's docs; only when none fits, a good npm package with relatively high usage"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8b08a58-72ba-4f26-a891-71b9e99630e4
  modified: 2026-10-22T01:23:53.924Z
---

When the code needs something new, look for Node's own way of doing it
first, and check Node's docs to confirm whether one exists. Only when
none fits, choose an npm package, and only one in wide use.

**Why:** the user, 2026-10-21, on hiding typed passwords: "Find the
approprate built-in NodeJS approach for that or if that doesn't seem to
exist, use a good npm package for it - ensure though that the package
has relatively high usage." Node's readline has no option to hide
input, but its documented parts did the job with no package.

**How to apply:** say what Node's docs show before proposing a package.
If one is needed, say how widely it is used, and prefer the one the
ecosystem already depends on. Related: [[terminal-secrets-never-shown]].
